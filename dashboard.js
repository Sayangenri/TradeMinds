const express = require("express");
const path = require("path");
const config = require("./src/config");
const { readPool } = require("./src/chain");
const history = require("./src/history");
const risk = require("./src/risk");
const { nextPrice, isSimulating } = require("./src/simulator");
const { scanArbitrage } = require("./src/arb");
const { runAgentCycle, gatherSystemState, getActionLog, log } = require("./src/agent");
const { generateNews, getRecentNews } = require("./src/news");
const { processMessage, isTradingPaused } = require("./src/chat");

const app = express();
app.use(express.json());
const PORT = 3456;

const prices = {};
let pollCount = 0;
let agentCycleCount = 0;
let lastArbOpportunities = [];
let lastDecision = null;
let sseClients = [];

function fmt(n, d = 6) { return typeof n === "number" ? n.toFixed(d) : "?"; }
function ts() { return new Date().toLocaleTimeString(); }

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(res => {
    try { res.write(msg); return true; } catch { return false; }
  });
}

async function pollPrices() {
  pollCount++;
  const results = [];

  for (const pool of config.POOLS) {
    try {
      const data = await readPool(pool.addr);
      const name = pool.name;
      const token = name.split("/")[0];
      const price = isSimulating() ? nextPrice(name, data.price) : data.price;
      prices[token] = price;
      history.addPrice(name, price, data.tvlUsdt);
      results.push({ name, price, tvl: data.tvlUsdt });
    } catch (e) {
      console.error(`  [${ts()}] Error reading ${pool.name}: ${e.message}`);
    }
  }

  if (results.length > 0) {
    const line = results.map(r => `${r.name}: $${fmt(r.price)}`).join("  |  ");
    console.log(`  [${ts()}] Poll #${pollCount}: ${line}`);
  }

  const closed = risk.checkStopLossTakeProfit(prices);
  for (const c of closed) {
    console.log(`  [${ts()}] AUTO-CLOSE ${c.token} @ $${fmt(c.closePrice)} | ${c.reason}`);
    log({ type: "auto_close", ...c });
  }

  broadcast("prices", { prices: results, pollCount });

  const news = generateNews();
  if (news) {
    console.log(`  [${ts()}] NEWS: ${news.headline} [${news.sentiment}/${news.impact}]`);
    broadcast("news", news);
  }

  return results;
}

async function runArbScan() {
  const poolAddrs = config.POOLS.map(p => p.addr);
  lastArbOpportunities = await scanArbitrage(poolAddrs, 1000);
  broadcast("arb", { opportunities: lastArbOpportunities.slice(0, 5) });
  return lastArbOpportunities;
}

async function runAgent() {
  agentCycleCount++;
  console.log(`\n  ── AGENT CYCLE #${agentCycleCount} ──`);

  const result = await runAgentCycle(prices, lastArbOpportunities);
  lastDecision = result.decision;

  broadcast("agent", {
    cycle: agentCycleCount,
    decision: result.decision,
    results: result.results,
    state: result.systemState,
  });

  return result;
}

// --- API Routes ---
app.get("/api/state", async (req, res) => {
  if (config.MODE === "live") await risk.fetchOnChainBalances();
  const state = gatherSystemState(prices, lastArbOpportunities);
  res.json({
    ...state,
    agentCycles: agentCycleCount,
    pollCount,
    lastDecision,
    mode: config.MODE,
  });
});

app.get("/api/news", (req, res) => {
  res.json(getRecentNews(10));
});

app.get("/api/log", (req, res) => {
  res.json(getActionLog().slice(-50));
});

app.get("/api/history/:pool", (req, res) => {
  const prices = history.getPriceArray(req.params.pool, 60, 60);
  const stats = history.getStats(req.params.pool, 30);
  res.json({ prices, stats });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "No message" });
    const reply = await processMessage(message);
    res.json(reply);
  } catch (e) {
    res.status(500).json({ type: "error", message: e.message });
  }
});

app.get("/api/trades", (req, res) => {
  const riskState = risk.getState();
  const trades = (riskState.closedToday || []).map(t => ({
    token: t.token,
    action: t.token === 'ARB' ? 'arb' : (t.pnl >= 0 ? 'sell' : 'sell'),
    entry: t.entryPrice,
    close: t.closePrice,
    amount: t.amount,
    cost: t.costUsdt,
    pnl: t.pnl,
    pnlPct: t.pnlPct,
    reason: t.reason,
    time: t.closedAt,
  }));
  res.json(trades);
});

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write("event: connected\ndata: {}\n\n");
  sseClients.push(res);
  req.on("close", () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// --- Dashboard HTML ---
app.get("/", (req, res) => {
  res.send(getDashboardHTML());
});

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Agent Trading Bot — HSK Chain</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, sans-serif; background: #000; color: #fff; min-height: 100vh; -webkit-font-smoothing: antialiased; }
  .header { padding: 24px 28px; border-bottom: 1px solid #222; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { font-size: 16px; font-weight: 500; letter-spacing: -0.3px; }
  .header h1 span { font-weight: 600; }
  .badge { display: inline-block; padding: 3px 10px; border: 1px solid #444; border-radius: 20px; font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 500; letter-spacing: 0.5px; }
  .badge-sim { border-color: #555; color: #aaa; }
  .badge-ai { border-color: #666; color: #ccc; margin-left: 8px; }
  .badge-connected { border-color: #4a4; color: #6c6; margin-left: 8px; }
  .wallet-btn { background: #222; border: 1px solid #444; color: #fff; padding: 6px 14px; font-family: 'JetBrains Mono', monospace; font-size: 11px; cursor: pointer; letter-spacing: 0.5px; transition: border-color 0.2s; }
  .wallet-btn:hover { border-color: #888; }
  .wallet-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .wallet-btn.danger { border-color: #633; color: #c88; }
  .wallet-btn.danger:hover { border-color: #a55; }
  .vault-panel { margin-top: 12px; border-top: 1px solid #222; padding-top: 12px; }
  .vault-token-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #111; }
  .vault-token-row:last-child { border-bottom: none; }
  .vault-token-name { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #888; }
  .vault-token-bal { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: #fff; font-weight: 500; }
  .vault-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .deposit-row { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
  .deposit-row select, .deposit-row input { background: #111; border: 1px solid #333; color: #fff; padding: 8px 10px; font-family: 'JetBrains Mono', monospace; font-size: 12px; outline: none; }
  .deposit-row select { width: 100px; }
  .deposit-row input { flex: 1; }
  .vault-limit-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #111; font-size: 12px; }
  .vault-limit-label { color: #666; }
  .vault-limit-value { font-family: 'JetBrains Mono', monospace; color: #fff; }
  .tx-status { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #888; margin-top: 8px; min-height: 16px; }
  .tx-status.success { color: #6c6; }
  .tx-status.error { color: #c66; }
  .tx-status.pending { color: #cc8; }
  .wallet-modal-overlay { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); z-index:1000; justify-content:center; align-items:center; }
  .wallet-modal-overlay.show { display:flex; }
  .wallet-modal { background:#111; border:1px solid #333; padding:24px; width:340px; }
  .wallet-modal h3 { font-family:'JetBrains Mono',monospace; font-size:12px; color:#888; text-transform:uppercase; letter-spacing:2px; margin-bottom:16px; }
  .wallet-option { display:flex; align-items:center; gap:12px; padding:14px 16px; border:1px solid #222; cursor:pointer; margin-bottom:8px; transition:border-color 0.2s; }
  .wallet-option:hover { border-color:#666; }
  .wallet-option.disabled { opacity:0.3; cursor:not-allowed; }
  .wallet-option .wo-name { font-size:14px; font-weight:500; }
  .wallet-option .wo-desc { font-size:11px; color:#666; margin-top:2px; }
  .wallet-option .wo-icon { width:32px; height:32px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:18px; background:#222; }
  .wallet-modal-close { float:right; background:none; border:none; color:#666; font-size:18px; cursor:pointer; line-height:1; }
  .wallet-modal-close:hover { color:#fff; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; padding: 0; background: #222; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  .card { background: #000; padding: 20px 24px; }
  .card-title { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 16px; }
  .stat-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #111; }
  .stat-label { color: #666; font-size: 13px; font-weight: 300; }
  .stat-value { font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 500; color: #fff; }
  .green { color: #fff; }
  .red { color: #888; }
  .reasoning-box { border: 1px solid #333; border-radius: 0; padding: 16px; margin-top: 8px; font-size: 13px; line-height: 1.7; font-weight: 300; color: #ccc; }
  .reasoning-box .label { font-family: 'JetBrains Mono', monospace; color: #888; font-weight: 500; font-size: 10px; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px; }
  .action-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px solid #111; font-size: 13px; font-weight: 300; color: #ccc; line-height: 1.5; }
  .action-item:last-child { border-bottom: none; }
  .action-icon { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #666; min-width: 16px; padding-top: 2px; }
  .price-bar { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #111; }
  .price-bar:last-child { border-bottom: none; }
  .price-name { width: 120px; font-size: 12px; color: #666; font-weight: 400; letter-spacing: 0.3px; }
  .price-value { font-family: 'JetBrains Mono', monospace; font-size: 14px; font-weight: 500; flex: 1; }
  .arb-card { border: 1px solid #222; padding: 14px; margin-bottom: 8px; }
  .arb-profit { font-family: 'JetBrains Mono', monospace; font-weight: 500; font-size: 14px; color: #fff; }
  .arb-step { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #555; padding: 2px 0 2px 14px; }
  .log-entry { font-family: 'JetBrains Mono', monospace; font-size: 11px; padding: 5px 0; border-bottom: 1px solid #111; color: #555; }
  .log-entry .time { color: #333; }
  .log-entry .highlight { color: #999; font-weight: 500; }
  .pulse { animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .full-width { grid-column: 1 / -1; }
  .position-card { border: 1px solid #222; padding: 12px 14px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
  .position-card strong { font-weight: 500; }
  .cycle-badge { font-family: 'JetBrains Mono', monospace; color: #555; font-size: 11px; }
  .news-item { padding: 12px 0; border-bottom: 1px solid #111; }
  .news-item:last-child { border-bottom: none; }
  .news-item.bullish .news-headline::before { content: '+'; margin-right: 6px; color: #fff; }
  .news-item.bearish .news-headline::before { content: '-'; margin-right: 6px; color: #666; }
  .news-item.neutral .news-headline::before { content: '~'; margin-right: 6px; color: #444; }
  .news-headline { font-size: 13px; font-weight: 400; margin-bottom: 4px; }
  .news-meta { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #444; display: flex; gap: 12px; flex-wrap: wrap; }
  .news-tag { display: inline-block; padding: 1px 6px; border: 1px solid #333; font-family: 'JetBrains Mono', monospace; font-size: 9px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; color: #888; }
  .news-tag.bullish { border-color: #555; color: #aaa; }
  .news-tag.bearish { border-color: #444; color: #666; }
  .news-tag.neutral { border-color: #333; color: #555; }
  .news-tag.high { border-color: #666; color: #aaa; }
  .news-tag.medium { border-color: #444; color: #777; }
  .news-tag.low { border-color: #222; color: #444; }
  .news-flash { animation: newsFlash 0.6s ease-out; }
  @keyframes newsFlash { 0% { background: #111; } 100% { background: transparent; } }
  .stat-row:last-child { border-bottom: none; }
  .trade-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid #111; font-size: 12px; }
  .trade-row:last-child { border-bottom: none; }
  .trade-type { font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 600; letter-spacing: 0.5px; padding: 2px 8px; min-width: 40px; text-align: center; }
  .trade-type.buy { color: #6c6; border: 1px solid #363; }
  .trade-type.sell { color: #c88; border: 1px solid #633; }
  .trade-type.arb { color: #8bf; border: 1px solid #346; }
  .trade-detail { flex: 1; }
  .trade-detail .td-token { font-weight: 500; color: #fff; }
  .trade-detail .td-reason { color: #555; font-size: 11px; margin-top: 2px; }
  .trade-pnl { font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 500; text-align: right; min-width: 80px; }
  .trade-pnl.pos { color: #6c6; }
  .trade-pnl.neg { color: #c66; }
  .trade-pnl.zero { color: #888; }
  .trade-time { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #444; min-width: 70px; text-align: right; }
  .trade-hash { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #446; cursor: pointer; }
  .trade-hash:hover { color: #88c; }
  .trade-summary { display: flex; gap: 20px; margin-bottom: 12px; padding: 10px 0; border-bottom: 1px solid #222; }
  .trade-summary-item { text-align: center; }
  .trade-summary-label { font-size: 10px; color: #555; text-transform: uppercase; letter-spacing: 1px; font-family: 'JetBrains Mono', monospace; }
  .trade-summary-value { font-family: 'JetBrains Mono', monospace; font-size: 16px; font-weight: 500; margin-top: 4px; }
  .purple { color: #fff; font-weight: 500; }
  .chat-msg { padding: 8px 12px; margin-bottom: 6px; font-size: 13px; line-height: 1.5; border-left: 2px solid #333; color: #aaa; }
  .chat-msg.user { border-left-color: #666; color: #fff; }
  .chat-msg.bot { border-left-color: #333; color: #999; }
  .chat-msg pre { font-family: 'JetBrains Mono', monospace; font-size: 12px; white-space: pre-wrap; margin-top: 4px; }
</style>
</head>
<body>
<div class="header">
  <h1><span>AI Agent</span> Trading Bot — HashKey Chain</h1>
  <div style="display:flex;align-items:center;gap:8px">
    <span class="badge badge-sim" id="mode-badge">${config.MODE === 'live' ? 'LIVE' : 'SIMULATE'}</span>
    <span class="badge badge-ai" id="ai-badge">AI Agent</span>
    <span class="cycle-badge" id="cycle-badge">Cycle #0</span>
    <button class="wallet-btn" id="connect-btn" onclick="connectWallet()">CONNECT WALLET</button>
    <span class="badge badge-connected" id="wallet-badge" style="display:none"></span>
  </div>
</div>

<div class="grid">
  <!-- Portfolio Card -->
  <div class="card">
    <div class="card-title">Portfolio</div>
    <div class="stat-row"><span class="stat-label">Balance</span><span class="stat-value" id="balance">$10,000.00</span></div>
    <div class="stat-row"><span class="stat-label">Open Value</span><span class="stat-value" id="open-value">$0.00</span></div>
    <div class="stat-row"><span class="stat-label">Total Value</span><span class="stat-value" id="total-value">$10,000.00</span></div>
    <div class="stat-row"><span class="stat-label">Daily P&L</span><span class="stat-value" id="daily-pnl">$0.00</span></div>
    <div class="stat-row"><span class="stat-label">Total P&L</span><span class="stat-value" id="total-pnl">$0.00</span></div>
    <div class="stat-row"><span class="stat-label">Trades</span><span class="stat-value" id="total-trades">0</span></div>
  </div>

  <!-- Vault Management -->
  <div class="card" id="vault-card">
    <div class="card-title">Vault Management</div>
    <div id="vault-not-connected" style="color:#555;font-size:13px">Connect wallet to manage vault</div>
    <div id="vault-connected" style="display:none">
      <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#666;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px">Vault Balances</div>
      <div id="vault-balances">
        <div style="color:#555;font-size:12px">Loading...</div>
      </div>

      <div class="vault-panel">
        <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#666;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px">Risk Limits</div>
        <div id="vault-limits">
          <div class="vault-limit-row"><span class="vault-limit-label">Max Position</span><span class="vault-limit-value" id="vl-maxpos">—</span></div>
          <div class="vault-limit-row"><span class="vault-limit-label">Daily Loss Cap</span><span class="vault-limit-value" id="vl-dailyloss">—</span></div>
          <div class="vault-limit-row"><span class="vault-limit-label">Cooldown</span><span class="vault-limit-value" id="vl-cooldown">—</span></div>
          <div class="vault-limit-row"><span class="vault-limit-label">Daily Loss Used</span><span class="vault-limit-value" id="vl-dailyused">—</span></div>
          <div class="vault-limit-row"><span class="vault-limit-label">Vault Status</span><span class="vault-limit-value" id="vl-paused">—</span></div>
        </div>
      </div>

      <div class="vault-panel">
        <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#666;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px">Deposit</div>
        <div class="deposit-row">
          <select id="deposit-token">
            <option value="tUSDT">tUSDT</option>
            <option value="TALPHA">TALPHA</option>
            <option value="TBETA">TBETA</option>
          </select>
          <input id="deposit-amount" type="number" placeholder="Amount" step="any">
          <button class="wallet-btn" onclick="depositToVault()">DEPOSIT</button>
        </div>
      </div>

      <div class="vault-panel">
        <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#666;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px">Withdraw</div>
        <div class="deposit-row">
          <select id="withdraw-token">
            <option value="tUSDT">tUSDT</option>
            <option value="TALPHA">TALPHA</option>
            <option value="TBETA">TBETA</option>
          </select>
          <input id="withdraw-amount" type="number" placeholder="Amount" step="any">
          <button class="wallet-btn" onclick="withdrawFromVault()">WITHDRAW</button>
        </div>
      </div>

      <div class="vault-actions">
        <button class="wallet-btn danger" onclick="emergencyWithdrawAll()">EMERGENCY WITHDRAW ALL</button>
        <button class="wallet-btn" id="pause-vault-btn" onclick="toggleVaultPause()">PAUSE VAULT</button>
      </div>

      <div class="tx-status" id="tx-status"></div>
    </div>
  </div>

  <!-- AI Agent Brain -->
  <div class="card">
    <div class="card-title">AI Agent Brain</div>
    <div id="agent-status" class="reasoning-box">
      <div class="label">Waiting for first decision cycle...</div>
      <div class="pulse" style="color:#555">Agent initializing — gathering market data</div>
    </div>
    <div style="margin-top:10px">
      <div class="stat-row"><span class="stat-label">Strategy</span><span class="stat-value purple" id="strategy">—</span></div>
      <div class="stat-row"><span class="stat-label">Decision</span><span class="stat-value" id="decision-source">—</span></div>
    </div>
  </div>

  <!-- Live Prices -->
  <div class="card">
    <div class="card-title">Live Prices</div>
    <div id="prices-container">
      <div class="price-bar"><span class="price-name">Loading...</span></div>
    </div>
  </div>

  <!-- Agent Actions -->
  <div class="card">
    <div class="card-title">Agent Actions</div>
    <div id="actions-container">
      <div class="action-item"><span class="action-icon">⏳</span> Waiting for first cycle...</div>
    </div>
  </div>

  <!-- Arbitrage Opportunities -->
  <div class="card">
    <div class="card-title">Arbitrage Detection</div>
    <div id="arb-container">
      <div style="color:#555;font-size:13px">Scanning for opportunities...</div>
    </div>
  </div>

  <!-- Open Positions -->
  <div class="card">
    <div class="card-title">Open Positions</div>
    <div id="positions-container">
      <div style="color:#5a6480;font-size:13px">No open positions</div>
    </div>
  </div>

  <!-- Trade History -->
  <div class="card full-width">
    <div class="card-title">Trade History</div>
    <div class="trade-summary">
      <div class="trade-summary-item"><div class="trade-summary-label">Total Trades</div><div class="trade-summary-value" id="th-total">0</div></div>
      <div class="trade-summary-item"><div class="trade-summary-label">Arb Trades</div><div class="trade-summary-value" id="th-arbs">0</div></div>
      <div class="trade-summary-item"><div class="trade-summary-label">Directional</div><div class="trade-summary-value" id="th-directional">0</div></div>
      <div class="trade-summary-item"><div class="trade-summary-label">Total Profit</div><div class="trade-summary-value" id="th-profit">$0.00</div></div>
      <div class="trade-summary-item"><div class="trade-summary-label">Win Rate</div><div class="trade-summary-value" id="th-winrate">—</div></div>
    </div>
    <div id="trades-container" style="max-height:300px;overflow-y:auto">
      <div style="color:#555;font-size:13px">No trades yet — agent is analyzing the market</div>
    </div>
  </div>

  <!-- News Feed -->
  <div class="card full-width">
    <div class="card-title">News Feed — Agent reacts to market news</div>
    <div id="news-container" style="max-height:240px;overflow-y:auto">
      <div style="color:#555;font-size:13px">Monitoring news sources...</div>
    </div>
  </div>

  <!-- Chat Control -->
  <div class="card full-width">
    <div class="card-title">Chat Control — Talk to your agent</div>
    <div id="chat-messages" style="max-height:200px;overflow-y:auto;margin-bottom:12px">
      <div class="chat-msg bot">Type a command or question below. Try: status, balance, positions, arb, help</div>
    </div>
    <div style="display:flex;gap:8px">
      <input id="chat-input" type="text" placeholder="Ask your agent... (status, positions, arb, pause, help)" style="flex:1;background:#111;border:1px solid #333;color:#fff;padding:10px 14px;font-family:'Inter',sans-serif;font-size:13px;outline:none" onkeydown="if(event.key==='Enter')sendChat()">
      <button onclick="sendChat()" style="background:#222;border:1px solid #444;color:#fff;padding:10px 18px;font-family:'JetBrains Mono',monospace;font-size:12px;cursor:pointer;letter-spacing:0.5px">SEND</button>
    </div>
  </div>

  <!-- Activity Log -->
  <div class="card full-width">
    <div class="card-title">Activity Log</div>
    <div id="log-container" style="max-height:200px;overflow-y:auto">
      <div class="log-entry"><span class="time">${new Date().toLocaleTimeString()}</span> — Agent starting up...</div>
    </div>
  </div>
</div>

<div class="wallet-modal-overlay" id="wallet-modal" onclick="if(event.target===this)closeWalletModal()">
  <div class="wallet-modal">
    <button class="wallet-modal-close" onclick="closeWalletModal()">&times;</button>
    <h3>Connect Wallet</h3>
    <div id="wallet-options"></div>
    <div style="margin-top:12px;font-size:11px;color:#444;text-align:center">Select a wallet to connect to HSK Chain</div>
  </div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js"></script>
<script>
const es = new EventSource('/api/events');

es.addEventListener('connected', () => {
  addLog('Connected to agent dashboard');
  fetch('/api/state').then(r => r.json()).then(updateState);
  fetch('/api/news').then(r => r.json()).then(news => {
    news.forEach(n => addNewsItem(n));
  });
  fetchTradeHistory();
});

es.addEventListener('prices', (e) => {
  const d = JSON.parse(e.data);
  updatePrices(d.prices);
});

es.addEventListener('agent', (e) => {
  const d = JSON.parse(e.data);
  updateAgent(d);
});

es.addEventListener('arb', (e) => {
  const d = JSON.parse(e.data);
  updateArb(d.opportunities);
});

es.addEventListener('news', (e) => {
  const n = JSON.parse(e.data);
  addNewsItem(n);
  addLog('NEWS: ' + n.headline + ' [' + n.sentiment + '/' + n.impact + ']');
});

function updateState(s) {
  document.getElementById('balance').textContent = s.portfolio.balance;
  document.getElementById('open-value').textContent = s.portfolio.openValue;
  document.getElementById('total-value').textContent = s.portfolio.totalValue;
  document.getElementById('daily-pnl').textContent = s.portfolio.dailyPnl;
  document.getElementById('daily-pnl').className = 'stat-value ' + pnlColor(s.portfolio.dailyPnl);
  document.getElementById('total-pnl').textContent = s.portfolio.totalPnl;
  document.getElementById('total-pnl').className = 'stat-value ' + pnlColor(s.portfolio.totalPnl);
  document.getElementById('total-trades').textContent = s.portfolio.totalTrades;
  if (s.mode) document.getElementById('mode-badge').textContent = s.mode.toUpperCase();
}

function updatePrices(priceList) {
  const c = document.getElementById('prices-container');
  if (!priceList || priceList.length === 0) return;
  c.innerHTML = priceList.map(p => {
    return '<div class="price-bar"><span class="price-name">' + p.name + '</span><span class="price-value">$' + p.price.toFixed(6) + '</span></div>';
  }).join('');
}

function updateAgent(d) {
  const dec = d.decision;
  document.getElementById('cycle-badge').textContent = 'Cycle #' + d.cycle;
  document.getElementById('strategy').textContent = dec.strategy || '—';
  document.getElementById('decision-source').textContent = dec.source || '—';

  const box = document.getElementById('agent-status');
  box.innerHTML = '<div class="label">Agent reasoning (cycle #' + d.cycle + ')</div>' +
    '<div>' + (dec.reasoning || 'No reasoning provided') + '</div>' +
    '<div style="margin-top:8px;color:#555;font-size:12px">' + (dec.market_assessment || '') + '</div>';

  const ac = document.getElementById('actions-container');
  if (dec.actions && dec.actions.length > 0) {
    ac.innerHTML = dec.actions.map(a => {
      const icon = actionIcon(a.type, a.action);
      const label = actionLabel(a);
      return '<div class="action-item"><span class="action-icon">' + icon + '</span>' + label + '</div>';
    }).join('');
  }

  if (d.state) {
    updateState({ portfolio: d.state.portfolio });
    updatePositions(d.state.positions);
  }

  addLog('Agent cycle #' + d.cycle + ': ' + (dec.strategy || 'neutral') + ' — ' + (dec.actions || []).map(a => a.type).join(', '));
  fetchTradeHistory();
}

function updatePositions(positions) {
  const c = document.getElementById('positions-container');
  if (!positions || positions.length === 0) {
    c.innerHTML = '<div style="color:#555;font-size:13px">No open positions</div>';
    return;
  }
  c.innerHTML = positions.map(p => {
    const pnlClass = p.pnl && p.pnl.startsWith('-') ? 'red' : 'green';
    return '<div class="position-card"><div><strong>' + p.token + '</strong><br><span style="font-size:12px;color:#666">Entry: ' + p.entry + ' → Current: ' + p.current + '</span></div><div class="' + pnlClass + '">' + p.pnl + '</div></div>';
  }).join('');
}

function updateArb(opps) {
  const c = document.getElementById('arb-container');
  if (!opps || opps.length === 0) {
    c.innerHTML = '<div style="color:#555;font-size:13px">No profitable routes found</div>';
    return;
  }
  c.innerHTML = opps.map(o => {
    const steps = (o.steps || []).map(s => '<div class="arb-step">' + s.pool + ': ' + s.in + ' → ' + s.out + '</div>').join('');
    return '<div class="arb-card"><div class="arb-profit">+' + o.profit.toFixed(2) + ' (' + o.profitPct.toFixed(2) + '%)</div>' + steps + '</div>';
  }).join('');
}

function pnlColor(val) {
  const n = parseFloat(String(val).replace('$', ''));
  return n > 0 ? 'green' : n < 0 ? 'red' : '';
}

function actionIcon(type, action) {
  if (type === 'trade') return action === 'buy' ? '+' : '-';
  if (type === 'execute_arb') return '>';
  if (type === 'close_position') return 'x';
  if (type === 'hold') return '.';
  if (type === 'scan_arb') return '?';
  if (type === 'adjust_risk') return '*';
  return '~';
}

function actionLabel(a) {
  if (a.type === 'trade') return a.action.toUpperCase() + ' ' + (a.pool || '') + ' — ' + (a.reason || '');
  if (a.type === 'execute_arb') return 'Execute arbitrage — ' + (a.reason || '');
  if (a.type === 'close_position') return 'Close ' + (a.token || '') + ' — ' + (a.reason || '');
  if (a.type === 'hold') return 'HOLD — ' + (a.reason || '');
  if (a.type === 'scan_arb') return 'Scan arbitrage — ' + (a.reason || '');
  if (a.type === 'adjust_risk') return 'Adjust ' + (a.param || '') + ' for ' + (a.token || '');
  return a.type + ' — ' + (a.reason || '');
}

function fetchTradeHistory() {
  fetch('/api/trades').then(r => r.json()).then(updateTradeHistory).catch(() => {});
}

function updateTradeHistory(trades) {
  if (!trades || trades.length === 0) return;

  const totalProfit = trades.reduce((s, t) => s + t.pnl, 0);
  const arbTrades = trades.filter(t => t.token === 'ARB');
  const dirTrades = trades.filter(t => t.token !== 'ARB');
  const winners = trades.filter(t => t.pnl > 0).length;

  document.getElementById('th-total').textContent = trades.length;
  document.getElementById('th-arbs').textContent = arbTrades.length;
  document.getElementById('th-directional').textContent = dirTrades.length;
  const profitEl = document.getElementById('th-profit');
  profitEl.textContent = (totalProfit >= 0 ? '+' : '') + '$' + totalProfit.toFixed(2);
  profitEl.style.color = totalProfit > 0 ? '#6c6' : totalProfit < 0 ? '#c66' : '#888';
  document.getElementById('th-winrate').textContent = trades.length > 0 ? Math.round(winners / trades.length * 100) + '%' : '—';

  const c = document.getElementById('trades-container');
  c.innerHTML = trades.slice().reverse().map(function(t) {
    const isArb = t.token === 'ARB';
    const typeClass = isArb ? 'arb' : (t.pnl >= 0 ? 'buy' : 'sell');
    const typeLabel = isArb ? 'ARB' : 'TRADE';
    const pnlClass = t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : 'zero';
    const pnlStr = (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2);
    const pctStr = '(' + (t.pnlPct >= 0 ? '+' : '') + t.pnlPct.toFixed(2) + '%)';
    const time = t.time ? new Date(t.time).toLocaleTimeString() : '';
    const token = isArb ? 'Triangular Arb' : t.token;
    const reason = t.reason || '';

    return '<div class="trade-row">' +
      '<span class="trade-type ' + typeClass + '">' + typeLabel + '</span>' +
      '<div class="trade-detail"><div class="td-token">' + token + '</div><div class="td-reason">' + reason + '</div></div>' +
      '<span class="trade-pnl ' + pnlClass + '">' + pnlStr + ' <span style="font-size:10px;color:#666">' + pctStr + '</span></span>' +
      '<span class="trade-time">' + time + '</span>' +
      '</div>';
  }).join('');
}

function addNewsItem(n) {
  const c = document.getElementById('news-container');
  if (c.children.length === 1 && c.children[0].tagName !== 'DIV') return;
  if (c.querySelector('[style*="color:#555"]')) c.innerHTML = '';
  const time = new Date(n.timestamp).toLocaleTimeString();
  const tokens = (n.tokens || []).join(', ');
  const html = '<div class="news-item news-flash ' + n.sentiment + '">' +
    '<div class="news-headline">' + n.headline + '</div>' +
    '<div class="news-meta">' +
    '<span class="news-tag ' + n.sentiment + '">' + n.sentiment + '</span>' +
    '<span class="news-tag ' + n.impact + '">' + n.impact + ' impact</span>' +
    '<span>Tokens: ' + tokens + '</span>' +
    '<span>' + n.source + '</span>' +
    '<span>' + time + '</span>' +
    '</div></div>';
  c.insertAdjacentHTML('afterbegin', html);
  if (c.children.length > 15) c.removeChild(c.lastChild);
}

function addLog(msg) {
  const c = document.getElementById('log-container');
  const time = new Date().toLocaleTimeString();
  c.innerHTML = '<div class="log-entry"><span class="time">' + time + '</span> — <span class="highlight">' + msg + '</span></div>' + c.innerHTML;
  if (c.children.length > 50) c.removeChild(c.lastChild);
}

setInterval(() => {
  fetch('/api/state').then(r => r.json()).then(updateState).catch(() => {});
}, 10000);

function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  addChatMsg(msg, 'user');
  fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg })
  })
  .then(r => r.json())
  .then(reply => {
    addChatMsg(reply.message, 'bot');
    addLog('Chat: ' + msg + ' => ' + reply.type);
  })
  .catch(e => addChatMsg('Error: ' + e.message, 'bot'));
}

function addChatMsg(text, role) {
  const c = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  const pre = document.createElement('pre');
  pre.textContent = text;
  div.appendChild(pre);
  c.appendChild(div);
  c.scrollTop = c.scrollHeight;
}

// === WALLET & VAULT MANAGEMENT ===
const VAULT_ADDR = '${require("./testnet_deployment.json").contracts.vault || ""}';
const TOKENS = ${JSON.stringify(
  Object.fromEntries(
    Object.entries(require("./testnet_deployment.json").tokens).map(([name, info]) => [name, { address: info.address, decimals: info.decimals }])
  )
)};
const HSK_CHAIN_ID = '0x${(config.CHAIN_ID || 133).toString(16)}';

const VAULT_ABI = [
  'function deposit(address token, uint256 amount)',
  'function withdraw(address token, uint256 amount)',
  'function emergencyWithdraw(address token)',
  'function getTokenBalance(address token) view returns (uint256)',
  'function getVaultState() view returns (address, address, address, uint256, uint256, uint256, uint256, uint256, bool)',
  'function getDepositedTokens() view returns (address[])',
  'function pause()',
  'function unpause()',
  'function owner() view returns (address)',
  'function agent() view returns (address)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

let walletProvider = null;
let walletSigner = null;
let walletAddress = null;
let vaultContract = null;
let isVaultPaused = false;

function setTxStatus(msg, type) {
  const el = document.getElementById('tx-status');
  el.textContent = msg;
  el.className = 'tx-status ' + (type || '');
}

// EIP-6963 wallet discovery — each wallet announces itself with a unique rdns
window._eip6963Wallets = [];
window.addEventListener('eip6963:announceProvider', function(event) {
  const info = event.detail.info;
  const provider = event.detail.provider;
  const existing = window._eip6963Wallets.find(w => w.rdns === info.rdns);
  if (!existing) {
    window._eip6963Wallets.push({ rdns: info.rdns, name: info.name, icon: info.icon, provider: provider });
  }
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

function detectWallets() {
  const wallets = [];
  const seen = new Set();

  // EIP-6963 wallets (reliable, each wallet has unique rdns)
  for (const w of window._eip6963Wallets) {
    const rdns = (w.rdns || '').toLowerCase();
    let name = w.name;
    let icon = name.charAt(0).toUpperCase();
    if (rdns.includes('metamask')) { name = 'MetaMask'; icon = 'M'; }
    else if (rdns.includes('okex') || rdns.includes('okx')) { name = 'OKX Wallet'; icon = 'O'; }
    else if (rdns.includes('coinbase')) { name = 'Coinbase Wallet'; icon = 'C'; }
    else if (rdns.includes('brave')) { name = 'Brave Wallet'; icon = 'B'; }
    else if (rdns.includes('rabby')) { name = 'Rabby'; icon = 'R'; }
    if (!seen.has(name)) {
      seen.add(name);
      wallets.push({ name: name, icon: icon, provider: w.provider, desc: w.name });
    }
  }

  if (wallets.length > 0) return wallets;

  // Fallback: legacy window.ethereum detection
  if (window.ethereum) {
    if (window.ethereum.providers && window.ethereum.providers.length > 0) {
      for (const p of window.ethereum.providers) {
        const isOkx = p.isOkxWallet || p.isOKExWallet;
        if (isOkx && !seen.has('OKX Wallet')) { seen.add('OKX Wallet'); wallets.push({ name: 'OKX Wallet', icon: 'O', provider: p, desc: 'OKX exchange wallet' }); continue; }
        if (p.isMetaMask && !isOkx && !seen.has('MetaMask')) { seen.add('MetaMask'); wallets.push({ name: 'MetaMask', icon: 'M', provider: p, desc: 'Popular browser wallet' }); continue; }
      }
    }
    if (wallets.length === 0) {
      const e = window.ethereum;
      const isOkx = e.isOkxWallet || e.isOKExWallet;
      if (isOkx) wallets.push({ name: 'OKX Wallet', icon: 'O', provider: e, desc: 'OKX exchange wallet' });
      else if (e.isMetaMask) wallets.push({ name: 'MetaMask', icon: 'M', provider: e, desc: 'Popular browser wallet' });
      else wallets.push({ name: 'Browser Wallet', icon: 'W', provider: e, desc: 'Detected browser wallet' });
    }
  }

  // Dedicated OKX global
  if (window.okxwallet && !seen.has('OKX Wallet')) {
    wallets.push({ name: 'OKX Wallet', icon: 'O', provider: window.okxwallet, desc: 'OKX exchange wallet' });
  }
  return wallets;
}

function connectWallet() {
  // Re-request EIP-6963 in case wallets loaded late
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  setTimeout(function() {
    const wallets = detectWallets();
    if (wallets.length === 0) {
      alert('No wallet detected. Please install MetaMask or another Web3 wallet.');
      return;
    }
    if (wallets.length === 1) {
      doConnect(wallets[0].provider, wallets[0].name);
      return;
    }
    const container = document.getElementById('wallet-options');
    container.innerHTML = wallets.map(function(w, i) {
      return '<div class="wallet-option" onclick="selectWallet(' + i + ')" data-idx="' + i + '">' +
        '<div class="wo-icon">' + w.icon + '</div>' +
        '<div><div class="wo-name">' + w.name + '</div><div class="wo-desc">' + w.desc + '</div></div>' +
        '</div>';
    }).join('');
    window._detectedWallets = wallets;
    document.getElementById('wallet-modal').classList.add('show');
  }, 100);
}

function closeWalletModal() {
  document.getElementById('wallet-modal').classList.remove('show');
}

function selectWallet(idx) {
  closeWalletModal();
  const w = window._detectedWallets[idx];
  doConnect(w.provider, w.name);
}

async function doConnect(provider, walletName) {
  try {
    const btn = document.getElementById('connect-btn');
    btn.textContent = 'CONNECTING...';
    btn.disabled = true;

    await provider.request({ method: 'eth_requestAccounts' });

    const currentChain = await provider.request({ method: 'eth_chainId' });
    if (currentChain !== HSK_CHAIN_ID) {
      try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: HSK_CHAIN_ID }] });
      } catch (switchErr) {
        if (switchErr.code === 4902) {
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: HSK_CHAIN_ID,
              chainName: '${config.CHAIN_ID === 133 ? "HSK Testnet" : "HSK Mainnet"}',
              nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 },
              rpcUrls: ['${config.RPC_URL}'],
            }]
          });
        } else { throw switchErr; }
      }
    }

    walletProvider = new ethers.BrowserProvider(provider);
    walletSigner = await walletProvider.getSigner();
    walletAddress = await walletSigner.getAddress();

    btn.style.display = 'none';
    const badge = document.getElementById('wallet-badge');
    badge.style.display = 'inline-block';
    badge.textContent = walletAddress.slice(0,6) + '...' + walletAddress.slice(-4);

    if (VAULT_ADDR) {
      vaultContract = new ethers.Contract(VAULT_ADDR, VAULT_ABI, walletSigner);
      document.getElementById('vault-not-connected').style.display = 'none';
      document.getElementById('vault-connected').style.display = 'block';
      await refreshVault();
    }

    addLog('Connected ' + walletName + ': ' + walletAddress.slice(0,6) + '...' + walletAddress.slice(-4));

    provider.on('accountsChanged', () => location.reload());
    provider.on('chainChanged', () => location.reload());
  } catch (e) {
    const btn = document.getElementById('connect-btn');
    btn.textContent = 'CONNECT WALLET';
    btn.disabled = false;
    alert('Connection failed: ' + e.message);
  }
}

async function refreshVault() {
  if (!vaultContract || !walletAddress) return;
  try {
    const state = await vaultContract.getVaultState();
    const maxPosPct = Number(state[3]);
    const dailyLossPct = Number(state[4]);
    const cooldown = Number(state[5]);
    const dailyLoss = Number(state[6]);
    isVaultPaused = state[8];

    document.getElementById('vl-maxpos').textContent = (maxPosPct / 100).toFixed(1) + '%';
    document.getElementById('vl-dailyloss').textContent = (dailyLossPct / 100).toFixed(1) + '%';
    document.getElementById('vl-cooldown').textContent = cooldown > 0 ? cooldown + 's' : 'None';
    document.getElementById('vl-dailyused').textContent = dailyLoss.toString();
    document.getElementById('vl-paused').textContent = isVaultPaused ? 'PAUSED' : 'ACTIVE';
    document.getElementById('vl-paused').style.color = isVaultPaused ? '#c66' : '#6c6';
    document.getElementById('pause-vault-btn').textContent = isVaultPaused ? 'UNPAUSE VAULT' : 'PAUSE VAULT';

    const balHTML = [];
    for (const [name, info] of Object.entries(TOKENS)) {
      const vaultBal = await vaultContract.getTokenBalance(info.address);
      const tokenContract = new ethers.Contract(info.address, ERC20_ABI, walletProvider);
      const walletBal = await tokenContract.balanceOf(walletAddress);
      const dec = info.decimals;
      balHTML.push(
        '<div class="vault-token-row">' +
        '<span class="vault-token-name">' + name + '</span>' +
        '<span><span class="vault-token-bal">' + parseFloat(ethers.formatUnits(vaultBal, dec)).toLocaleString(undefined, {maximumFractionDigits: 2}) + '</span>' +
        '<span style="color:#555;font-size:11px;margin-left:8px">(wallet: ' + parseFloat(ethers.formatUnits(walletBal, dec)).toLocaleString(undefined, {maximumFractionDigits: 2}) + ')</span></span>' +
        '</div>'
      );
    }
    document.getElementById('vault-balances').innerHTML = balHTML.join('');
  } catch (e) {
    setTxStatus('Error reading vault: ' + e.message, 'error');
  }
}

async function depositToVault() {
  if (!vaultContract || !walletSigner) return;
  const tokenName = document.getElementById('deposit-token').value;
  const amount = document.getElementById('deposit-amount').value;
  if (!amount || parseFloat(amount) <= 0) { setTxStatus('Enter a valid amount', 'error'); return; }

  const info = TOKENS[tokenName];
  const parsedAmount = ethers.parseUnits(amount, info.decimals);
  const tokenContract = new ethers.Contract(info.address, ERC20_ABI, walletSigner);

  try {
    setTxStatus('Checking allowance...', 'pending');
    const allowance = await tokenContract.allowance(walletAddress, VAULT_ADDR);
    if (allowance < parsedAmount) {
      setTxStatus('Approving ' + tokenName + '...', 'pending');
      const approveTx = await tokenContract.approve(VAULT_ADDR, ethers.MaxUint256);
      await approveTx.wait();
      setTxStatus('Approved. Depositing...', 'pending');
    }

    setTxStatus('Depositing ' + amount + ' ' + tokenName + '...', 'pending');
    const tx = await vaultContract.deposit(info.address, parsedAmount);
    await tx.wait();
    setTxStatus('Deposited ' + amount + ' ' + tokenName + ' — tx: ' + tx.hash.slice(0,10) + '...', 'success');
    document.getElementById('deposit-amount').value = '';
    addLog('Deposited ' + amount + ' ' + tokenName + ' to vault');
    await refreshVault();
  } catch (e) {
    setTxStatus('Deposit failed: ' + (e.reason || e.message).slice(0, 80), 'error');
  }
}

async function withdrawFromVault() {
  if (!vaultContract || !walletSigner) return;
  const tokenName = document.getElementById('withdraw-token').value;
  const amount = document.getElementById('withdraw-amount').value;
  if (!amount || parseFloat(amount) <= 0) { setTxStatus('Enter a valid amount', 'error'); return; }

  const info = TOKENS[tokenName];
  const parsedAmount = ethers.parseUnits(amount, info.decimals);

  try {
    setTxStatus('Withdrawing ' + amount + ' ' + tokenName + '...', 'pending');
    const tx = await vaultContract.withdraw(info.address, parsedAmount);
    await tx.wait();
    setTxStatus('Withdrawn ' + amount + ' ' + tokenName + ' — tx: ' + tx.hash.slice(0,10) + '...', 'success');
    document.getElementById('withdraw-amount').value = '';
    addLog('Withdrawn ' + amount + ' ' + tokenName + ' from vault');
    await refreshVault();
  } catch (e) {
    setTxStatus('Withdraw failed: ' + (e.reason || e.message).slice(0, 80), 'error');
  }
}

async function emergencyWithdrawAll() {
  if (!vaultContract || !walletSigner) return;
  if (!confirm('Emergency withdraw ALL tokens from vault?')) return;

  try {
    for (const [name, info] of Object.entries(TOKENS)) {
      setTxStatus('Emergency withdrawing ' + name + '...', 'pending');
      try {
        const tx = await vaultContract.emergencyWithdraw(info.address);
        await tx.wait();
        addLog('Emergency withdrawn ' + name + ' from vault');
      } catch (e) {
        if (!e.message.includes('revert')) throw e;
      }
    }
    setTxStatus('Emergency withdrawal complete', 'success');
    await refreshVault();
  } catch (e) {
    setTxStatus('Emergency withdraw failed: ' + (e.reason || e.message).slice(0, 80), 'error');
  }
}

async function toggleVaultPause() {
  if (!vaultContract || !walletSigner) return;
  try {
    if (isVaultPaused) {
      setTxStatus('Unpausing vault...', 'pending');
      const tx = await vaultContract.unpause();
      await tx.wait();
      setTxStatus('Vault unpaused', 'success');
      addLog('Vault unpaused');
    } else {
      setTxStatus('Pausing vault...', 'pending');
      const tx = await vaultContract.pause();
      await tx.wait();
      setTxStatus('Vault paused', 'success');
      addLog('Vault paused');
    }
    await refreshVault();
  } catch (e) {
    setTxStatus('Failed: ' + (e.reason || e.message).slice(0, 80), 'error');
  }
}

setInterval(() => { if (vaultContract) refreshVault(); }, 30000);
</script>
</body>
</html>`;
}

// --- Main with dashboard ---
async function main() {
  const modeLabel = config.MODE === "simulate" ? "SIMULATE (AI Agent + price movement)" : config.MODE.toUpperCase();

  console.log(`\n${"=".repeat(70)}`);
  console.log(`  AI AGENT TRADING BOT — Dashboard Mode`);
  console.log(`${"=".repeat(70)}`);
  console.log(`  Mode: ${modeLabel} | Starting balance: $${config.STARTING_BALANCE.toFixed(2)}`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`${"=".repeat(70)}\n`);

  app.listen(PORT, () => {
    console.log(`  Dashboard running at http://localhost:${PORT}\n`);
  });

  console.log("  Warming up — initial price poll + arb scan...\n");
  await pollPrices();
  await runArbScan();

  let nextAgentTime = Date.now() + 10_000;
  let nextArbTime = Date.now() + (config.ARB_SCAN_MS || 30_000);
  let nextReportTime = Date.now() + config.REPORT_MS;

  const loop = setInterval(async () => {
    try {
      await pollPrices();

      if (Date.now() >= nextArbTime) {
        await runArbScan();
        nextArbTime = Date.now() + (config.ARB_SCAN_MS || 30_000);
      }

      if (Date.now() >= nextAgentTime) {
        if (isTradingPaused()) {
          console.log(`  [${ts()}] Agent paused via chat — skipping cycle`);
          nextAgentTime = Date.now() + 15_000;
        } else {
          agentCycleCount++;
          console.log(`\n  ── AGENT CYCLE #${agentCycleCount} ──`);
          const result = await runAgent();
          nextAgentTime = Date.now() + result.nextCheckMs;
        }
      }

      if (Date.now() >= nextReportTime) {
        const s = risk.getState();
        console.log(`  Report: Balance $${s.balance.toFixed(2)} | PnL $${s.totalPnl.toFixed(2)} | Trades ${s.totalTrades}`);
        history.save();
        nextReportTime = Date.now() + config.REPORT_MS;
      }
    } catch (e) {
      console.error(`  Loop error: ${e.message}`);
    }
  }, config.POLL_MS);

  process.on("SIGINT", () => {
    clearInterval(loop);
    console.log("\n  Agent stopped. Goodbye!\n");
    history.save();
    process.exit(0);
  });
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
