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
let tradeLog = [];
let agentRunning = false;
let agentLoop = null;

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
  lastArbOpportunities = await scanArbitrage(poolAddrs, 200);
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

  // Log executed trades with tx hashes
  const actions = result.decision.actions || [];
  const results = result.results || [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const res = results[i];
    if (res && res.executed) {
      tradeLog.push({
        type: action.type === 'execute_arb' ? 'arb' : action.action || action.type,
        token: res.token || (action.type === 'execute_arb' ? 'ARB' : action.pool || '?'),
        price: res.price || null,
        cost: res.cost || null,
        pnl: res.profit || res.pnl || 0,
        pnlPct: res.profitPct || res.pnlPct || 0,
        txHash: res.txHash || null,
        mode: res.mode || 'live',
        reason: action.reason || res.action || '',
        time: Date.now(),
      });
    }
  }

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
  res.json(tradeLog);
});

app.post("/api/agent/start", (req, res) => {
  if (agentRunning) return res.json({ status: "already_running" });
  agentRunning = true;
  startAgentLoop();
  console.log(`  [${ts()}] Agent STARTED by user`);
  broadcast("agent_status", { running: true });
  res.json({ status: "started" });
});

app.post("/api/agent/stop", (req, res) => {
  if (!agentRunning) return res.json({ status: "already_stopped" });
  agentRunning = false;
  if (agentLoop) { clearInterval(agentLoop); agentLoop = null; }
  console.log(`  [${ts()}] Agent STOPPED by user`);
  broadcast("agent_status", { running: false });
  res.json({ status: "stopped" });
});

app.get("/api/agent/status", (req, res) => {
  res.json({ running: agentRunning, cycles: agentCycleCount });
});

app.get("/api/onchain/events", async (req, res) => {
  try {
    const { ethers } = require("ethers");
    const provider = new ethers.JsonRpcProvider(config.RPC_URL);
    const dep = require("./testnet_deployment.json");
    const vaultAddr = dep.contracts.vault;
    if (!vaultAddr) return res.json([]);

    const iface = new ethers.Interface([
      "event TradeExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
      "event ArbExecuted(uint256 amountIn, uint256 amountOut)",
      "event Deposited(address indexed token, uint256 amount)",
      "event Withdrawn(address indexed token, uint256 amount)",
    ]);

    const latestBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latestBlock - 10000);
    const logs = await provider.getLogs({ address: vaultAddr, fromBlock, toBlock: latestBlock });

    const tokenNames = {};
    for (const [name, info] of Object.entries(dep.tokens)) {
      tokenNames[info.address.toLowerCase()] = { name, decimals: info.decimals };
    }

    const events = [];
    for (const log of logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        const block = await provider.getBlock(log.blockNumber);
        const ev = {
          event: parsed.name,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          timestamp: block ? block.timestamp * 1000 : null,
        };

        if (parsed.name === "TradeExecuted") {
          const tokenIn = tokenNames[parsed.args[0].toLowerCase()] || { name: parsed.args[0].slice(0, 10), decimals: 18 };
          const tokenOut = tokenNames[parsed.args[1].toLowerCase()] || { name: parsed.args[1].slice(0, 10), decimals: 18 };
          ev.tokenIn = tokenIn.name;
          ev.tokenOut = tokenOut.name;
          ev.amountIn = parseFloat(ethers.formatUnits(parsed.args[2], tokenIn.decimals));
          ev.amountOut = parseFloat(ethers.formatUnits(parsed.args[3], tokenOut.decimals));
        } else if (parsed.name === "ArbExecuted") {
          ev.amountIn = parseFloat(ethers.formatUnits(parsed.args[0], 6));
          ev.amountOut = parseFloat(ethers.formatUnits(parsed.args[1], 6));
          ev.profit = ev.amountOut - ev.amountIn;
        } else if (parsed.name === "Deposited" || parsed.name === "Withdrawn") {
          const tok = tokenNames[parsed.args[0].toLowerCase()] || { name: parsed.args[0].slice(0, 10), decimals: 18 };
          ev.token = tok.name;
          ev.amount = parseFloat(ethers.formatUnits(parsed.args[1], tok.decimals));
        }
        events.push(ev);
      } catch (_) {}
    }

    res.json(events);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  const EXPLORER = 'https://testnet-explorer.hskchain.net';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TradeMinds — AI Trading Agent</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, sans-serif; background: #0a0a0a; color: #e0e0e0; min-height: 100vh; -webkit-font-smoothing: antialiased; }
  .header { padding: 20px 28px; border-bottom: 1px solid #1a1a1a; display: flex; justify-content: space-between; align-items: center; background: #0d0d0d; }
  .header h1 { font-size: 15px; font-weight: 500; letter-spacing: -0.3px; color: #fff; }
  .header h1 span { font-weight: 600; }
  .header-controls { display: flex; align-items: center; gap: 8px; }
  .badge { display: inline-block; padding: 3px 10px; border: 1px solid #333; border-radius: 20px; font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 500; letter-spacing: 0.5px; }
  .badge-mode { border-color: #444; color: #888; }
  .badge-agent { padding: 3px 12px; font-weight: 600; }
  .badge-agent.stopped { border-color: #633; color: #c66; }
  .badge-agent.running { border-color: #363; color: #6c6; }
  .btn { background: #151515; border: 1px solid #333; color: #ccc; padding: 6px 14px; font-family: 'JetBrains Mono', monospace; font-size: 11px; cursor: pointer; letter-spacing: 0.5px; transition: all 0.2s; }
  .btn:hover { border-color: #666; color: #fff; }
  .btn:disabled { opacity: 0.3; cursor: not-allowed; }
  .btn-start { border-color: #363; color: #6c6; }
  .btn-start:hover { border-color: #4a4; background: #0a1a0a; }
  .btn-stop { border-color: #633; color: #c66; }
  .btn-stop:hover { border-color: #a55; background: #1a0a0a; }
  .btn-danger { border-color: #633; color: #c88; }
  .btn-danger:hover { border-color: #a55; }
  .cycle-badge { font-family: 'JetBrains Mono', monospace; color: #444; font-size: 11px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; padding: 0; background: #1a1a1a; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  .card { background: #0a0a0a; padding: 20px 24px; }
  .card-title { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #555; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 16px; }
  .full-width { grid-column: 1 / -1; }
  .stat-row { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid #111; }
  .stat-row:last-child { border-bottom: none; }
  .stat-label { color: #666; font-size: 13px; font-weight: 300; }
  .stat-value { font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 500; color: #fff; }
  .muted { color: #444; }
  .green { color: #6c6; }
  .red { color: #c66; }
  .reasoning-box { border: 1px solid #222; padding: 16px; font-size: 13px; line-height: 1.7; font-weight: 300; color: #aaa; }
  .reasoning-box .label { font-family: 'JetBrains Mono', monospace; color: #666; font-weight: 500; font-size: 10px; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px; }
  .price-bar { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #111; }
  .price-bar:last-child { border-bottom: none; }
  .price-name { width: 120px; font-size: 12px; color: #666; }
  .price-value { font-family: 'JetBrains Mono', monospace; font-size: 14px; font-weight: 500; flex: 1; }
  .action-item { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; border-bottom: 1px solid #111; font-size: 13px; font-weight: 300; color: #aaa; line-height: 1.5; }
  .action-item:last-child { border-bottom: none; }
  .action-icon { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #555; min-width: 16px; padding-top: 2px; }
  .arb-card { border: 1px solid #1a1a1a; padding: 14px; margin-bottom: 8px; }
  .arb-profit { font-family: 'JetBrains Mono', monospace; font-weight: 500; font-size: 14px; color: #6c6; }
  .arb-step { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #555; padding: 2px 0 2px 14px; }
  .position-card { border: 1px solid #1a1a1a; padding: 12px 14px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
  .position-card strong { font-weight: 500; }
  .vault-panel { margin-top: 12px; border-top: 1px solid #1a1a1a; padding-top: 12px; }
  .vault-token-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #111; }
  .vault-token-row:last-child { border-bottom: none; }
  .vault-token-name { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #888; }
  .vault-token-bal { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: #fff; font-weight: 500; }
  .vault-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .deposit-row { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
  .deposit-row select, .deposit-row input { background: #111; border: 1px solid #222; color: #fff; padding: 8px 10px; font-family: 'JetBrains Mono', monospace; font-size: 12px; outline: none; }
  .deposit-row select { width: 100px; }
  .deposit-row input { flex: 1; }
  .vault-limit-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #111; font-size: 12px; }
  .vault-limit-label { color: #555; }
  .vault-limit-value { font-family: 'JetBrains Mono', monospace; color: #ccc; }
  .tx-status { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #666; margin-top: 8px; min-height: 16px; }
  .tx-status.success { color: #6c6; }
  .tx-status.error { color: #c66; }
  .tx-status.pending { color: #cc8; }
  .wallet-modal-overlay { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:1000; justify-content:center; align-items:center; }
  .wallet-modal-overlay.show { display:flex; }
  .wallet-modal { background:#111; border:1px solid #333; padding:24px; width:340px; }
  .wallet-modal h3 { font-family:'JetBrains Mono',monospace; font-size:12px; color:#888; text-transform:uppercase; letter-spacing:2px; margin-bottom:16px; }
  .wallet-option { display:flex; align-items:center; gap:12px; padding:14px 16px; border:1px solid #1a1a1a; cursor:pointer; margin-bottom:8px; transition:border-color 0.2s; }
  .wallet-option:hover { border-color:#555; }
  .wallet-option .wo-name { font-size:14px; font-weight:500; }
  .wallet-option .wo-desc { font-size:11px; color:#555; margin-top:2px; }
  .wallet-option .wo-icon { width:32px; height:32px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:18px; background:#1a1a1a; }
  .wallet-modal-close { float:right; background:none; border:none; color:#555; font-size:18px; cursor:pointer; }
  .wallet-modal-close:hover { color:#fff; }
  .trade-row { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px solid #111; font-size: 12px; }
  .trade-row:last-child { border-bottom: none; }
  .trade-type { font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 600; letter-spacing: 0.5px; padding: 2px 8px; min-width: 44px; text-align: center; flex-shrink: 0; margin-top: 2px; }
  .trade-type.buy { color: #6c6; border: 1px solid #363; }
  .trade-type.sell { color: #c88; border: 1px solid #633; }
  .trade-type.arb { color: #8bf; border: 1px solid #346; }
  .trade-detail { flex: 1; min-width: 0; }
  .trade-detail .td-token { font-weight: 500; color: #ddd; }
  .trade-detail .td-reason { color: #444; font-size: 11px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .trade-detail .td-hash { font-family: 'JetBrains Mono', monospace; font-size: 10px; margin-top: 3px; }
  .trade-detail .td-hash a { color: #446; text-decoration: none; }
  .trade-detail .td-hash a:hover { color: #88c; text-decoration: underline; }
  .trade-pnl { font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 500; text-align: right; min-width: 80px; flex-shrink: 0; }
  .trade-pnl.pos { color: #6c6; }
  .trade-pnl.neg { color: #c66; }
  .trade-pnl.zero { color: #555; }
  .trade-time { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #333; min-width: 70px; text-align: right; flex-shrink: 0; }
  .trade-summary { display: flex; gap: 20px; margin-bottom: 12px; padding: 10px 0; border-bottom: 1px solid #1a1a1a; }
  .trade-summary-item { text-align: center; }
  .trade-summary-label { font-size: 10px; color: #444; text-transform: uppercase; letter-spacing: 1px; font-family: 'JetBrains Mono', monospace; }
  .trade-summary-value { font-family: 'JetBrains Mono', monospace; font-size: 16px; font-weight: 500; margin-top: 4px; color: #ccc; }
  .onchain-event { padding: 8px 0; border-bottom: 1px solid #111; font-size: 12px; display: flex; gap: 10px; align-items: flex-start; }
  .onchain-event:last-child { border-bottom: none; }
  .event-type { font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 600; padding: 2px 8px; min-width: 50px; text-align: center; flex-shrink: 0; }
  .event-type.trade { color: #c8a; border: 1px solid #534; }
  .event-type.arb { color: #8bf; border: 1px solid #346; }
  .event-type.deposit { color: #6c6; border: 1px solid #363; }
  .event-type.withdraw { color: #cc8; border: 1px solid #553; }
  .event-detail { flex: 1; color: #aaa; }
  .event-detail a { color: #446; text-decoration: none; font-family: 'JetBrains Mono', monospace; font-size: 10px; }
  .event-detail a:hover { color: #88c; text-decoration: underline; }
  .news-item { padding: 10px 0; border-bottom: 1px solid #111; }
  .news-item:last-child { border-bottom: none; }
  .news-item.bullish .news-headline::before { content: '+'; margin-right: 6px; color: #6c6; }
  .news-item.bearish .news-headline::before { content: '-'; margin-right: 6px; color: #c66; }
  .news-item.neutral .news-headline::before { content: '~'; margin-right: 6px; color: #444; }
  .news-headline { font-size: 13px; font-weight: 400; margin-bottom: 4px; }
  .news-meta { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #444; display: flex; gap: 12px; flex-wrap: wrap; }
  .news-tag { display: inline-block; padding: 1px 6px; border: 1px solid #222; font-family: 'JetBrains Mono', monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; }
  .news-tag.bullish { border-color: #363; color: #6c6; }
  .news-tag.bearish { border-color: #633; color: #c66; }
  .news-tag.high { border-color: #553; color: #cc8; }
  .news-flash { animation: newsFlash 0.6s ease-out; }
  @keyframes newsFlash { 0% { background: #151515; } 100% { background: transparent; } }
  .pulse { animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .chat-msg { padding: 8px 12px; margin-bottom: 6px; font-size: 13px; line-height: 1.5; border-left: 2px solid #222; color: #888; }
  .chat-msg.user { border-left-color: #555; color: #ddd; }
  .chat-msg.bot { border-left-color: #222; color: #888; }
  .chat-msg pre { font-family: 'JetBrains Mono', monospace; font-size: 12px; white-space: pre-wrap; margin-top: 4px; }
  .log-entry { font-family: 'JetBrains Mono', monospace; font-size: 11px; padding: 4px 0; border-bottom: 1px solid #0d0d0d; color: #444; }
  .log-entry .time { color: #333; }
  .log-entry .highlight { color: #888; font-weight: 500; }
  .section-sub { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #555; text-transform: uppercase; letter-spacing: 2px; margin: 12px 0 8px; }
</style>
</head>
<body>
<div class="header">
  <h1><span>TradeMinds</span> — AI Trading Agent</h1>
  <div class="header-controls">
    <span class="badge badge-mode" id="mode-badge">${config.MODE === 'live' ? 'LIVE' : 'SIM'}</span>
    <span class="badge badge-agent stopped" id="agent-badge">AGENT STOPPED</span>
    <span class="cycle-badge" id="cycle-badge"></span>
    <button class="btn btn-start" id="start-btn" onclick="startAgent()">START AGENT</button>
    <button class="btn btn-stop" id="stop-btn" onclick="stopAgent()" style="display:none">STOP AGENT</button>
    <button class="btn" id="connect-btn" onclick="connectWallet()">CONNECT WALLET</button>
    <span class="badge" id="wallet-badge" style="display:none;border-color:#363;color:#6c6"></span>
  </div>
</div>

<div class="grid">
  <!-- Wallet Balances -->
  <div class="card">
    <div class="card-title">Wallet Balances</div>
    <div id="wallet-balances">
      <div style="color:#444;font-size:13px">Connect wallet to see balances</div>
    </div>
  </div>

  <!-- Vault Balances -->
  <div class="card" id="vault-card">
    <div class="card-title">AgentVault Balances</div>
    <div id="vault-not-connected" style="color:#444;font-size:13px">Connect wallet to see vault</div>
    <div id="vault-connected" style="display:none">
      <div id="vault-balances">
        <div style="color:#444;font-size:12px">Loading...</div>
      </div>

      <div class="vault-panel">
        <div class="section-sub">Risk Limits</div>
        <div id="vault-limits">
          <div class="vault-limit-row"><span class="vault-limit-label">Max Position</span><span class="vault-limit-value" id="vl-maxpos">—</span></div>
          <div class="vault-limit-row"><span class="vault-limit-label">Daily Loss Cap</span><span class="vault-limit-value" id="vl-dailyloss">—</span></div>
          <div class="vault-limit-row"><span class="vault-limit-label">Cooldown</span><span class="vault-limit-value" id="vl-cooldown">—</span></div>
          <div class="vault-limit-row"><span class="vault-limit-label">Daily Loss Used</span><span class="vault-limit-value" id="vl-dailyused">—</span></div>
          <div class="vault-limit-row"><span class="vault-limit-label">Status</span><span class="vault-limit-value" id="vl-paused">—</span></div>
        </div>
      </div>

      <div class="vault-panel">
        <div class="section-sub">Deposit / Withdraw</div>
        <div class="deposit-row">
          <select id="deposit-token"><option value="tUSDT">tUSDT</option><option value="TALPHA">TALPHA</option><option value="TBETA">TBETA</option></select>
          <input id="deposit-amount" type="number" placeholder="Amount" step="any">
          <button class="btn" onclick="depositToVault()">DEPOSIT</button>
          <button class="btn" onclick="withdrawFromVault()">WITHDRAW</button>
        </div>
      </div>

      <div class="vault-actions">
        <button class="btn btn-danger" onclick="emergencyWithdrawAll()">EMERGENCY WITHDRAW</button>
        <button class="btn" id="pause-vault-btn" onclick="toggleVaultPause()">PAUSE VAULT</button>
      </div>

      <div class="tx-status" id="tx-status"></div>
    </div>
  </div>

  <!-- Live Prices -->
  <div class="card">
    <div class="card-title">Live Prices</div>
    <div id="prices-container">
      <div class="price-bar"><span class="price-name pulse">Loading...</span></div>
    </div>
  </div>

  <!-- Arbitrage Detection -->
  <div class="card">
    <div class="card-title">Arbitrage Detection</div>
    <div id="arb-container">
      <div style="color:#444;font-size:13px">Scanning for opportunities...</div>
    </div>
  </div>

  <!-- AI Agent Brain -->
  <div class="card">
    <div class="card-title">AI Agent Brain</div>
    <div id="agent-status" class="reasoning-box">
      <div class="label">Agent stopped</div>
      <div style="color:#444">Click START AGENT to begin trading</div>
    </div>
    <div style="margin-top:10px">
      <div class="stat-row"><span class="stat-label">Strategy</span><span class="stat-value" id="strategy" style="color:#555">—</span></div>
      <div class="stat-row"><span class="stat-label">Cycle</span><span class="stat-value" id="decision-source" style="color:#555">—</span></div>
    </div>
  </div>

  <!-- Agent Actions -->
  <div class="card">
    <div class="card-title">Agent Actions</div>
    <div id="actions-container">
      <div style="color:#444;font-size:13px">Agent not started</div>
    </div>
  </div>

  <!-- Open Positions -->
  <div class="card">
    <div class="card-title">Open Positions</div>
    <div id="positions-container">
      <div style="color:#444;font-size:13px">No open positions</div>
    </div>
  </div>

  <!-- Portfolio (from agent) -->
  <div class="card">
    <div class="card-title">Agent Portfolio</div>
    <div id="portfolio-section" style="color:#444;font-size:13px">Start agent to see portfolio tracking</div>
  </div>

  <!-- On-Chain Vault Events -->
  <div class="card full-width">
    <div class="card-title">On-Chain Transactions (from AgentVault)</div>
    <div id="onchain-events" style="max-height:300px;overflow-y:auto">
      <div style="color:#444;font-size:13px">Connect wallet to load on-chain history</div>
    </div>
  </div>

  <!-- Trade History (this session) -->
  <div class="card full-width">
    <div class="card-title">Trade History (This Session)</div>
    <div class="trade-summary">
      <div class="trade-summary-item"><div class="trade-summary-label">Total</div><div class="trade-summary-value" id="th-total">0</div></div>
      <div class="trade-summary-item"><div class="trade-summary-label">Arb</div><div class="trade-summary-value" id="th-arbs">0</div></div>
      <div class="trade-summary-item"><div class="trade-summary-label">Directional</div><div class="trade-summary-value" id="th-directional">0</div></div>
      <div class="trade-summary-item"><div class="trade-summary-label">Net P&L</div><div class="trade-summary-value" id="th-profit">$0.00</div></div>
      <div class="trade-summary-item"><div class="trade-summary-label">Win Rate</div><div class="trade-summary-value" id="th-winrate">—</div></div>
    </div>
    <div id="trades-container" style="max-height:300px;overflow-y:auto">
      <div style="color:#444;font-size:13px">No trades yet — start the agent to begin</div>
    </div>
  </div>

  <!-- News Feed -->
  <div class="card full-width">
    <div class="card-title">News Feed</div>
    <div id="news-container" style="max-height:200px;overflow-y:auto">
      <div style="color:#444;font-size:13px">Monitoring news sources...</div>
    </div>
  </div>

  <!-- Chat Control -->
  <div class="card full-width">
    <div class="card-title">Chat Control</div>
    <div id="chat-messages" style="max-height:180px;overflow-y:auto;margin-bottom:12px">
      <div class="chat-msg bot">Type a command or question. Try: status, balance, positions, arb, help</div>
    </div>
    <div style="display:flex;gap:8px">
      <input id="chat-input" type="text" placeholder="Ask your agent..." style="flex:1;background:#111;border:1px solid #222;color:#fff;padding:10px 14px;font-family:'Inter',sans-serif;font-size:13px;outline:none" onkeydown="if(event.key==='Enter')sendChat()">
      <button onclick="sendChat()" class="btn">SEND</button>
    </div>
  </div>

  <!-- Activity Log -->
  <div class="card full-width">
    <div class="card-title">Activity Log</div>
    <div id="log-container" style="max-height:160px;overflow-y:auto">
      <div class="log-entry"><span class="time">${new Date().toLocaleTimeString()}</span> — <span class="highlight">Dashboard loaded. Agent stopped.</span></div>
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
const EXPLORER = '${EXPLORER}';
const es = new EventSource('/api/events');
let _agentRunning = false;

es.addEventListener('connected', function() {
  addLog('Connected to dashboard');
  fetch('/api/agent/status').then(function(r) { return r.json(); }).then(function(s) {
    _agentRunning = s.running;
    updateAgentUI();
    if (s.cycles > 0) document.getElementById('cycle-badge').textContent = 'Cycle #' + s.cycles;
  });
  fetch('/api/news').then(function(r) { return r.json(); }).then(function(news) {
    news.forEach(function(n) { addNewsItem(n); });
  });
  fetchTradeHistory();
});

es.addEventListener('prices', function(e) {
  var d = JSON.parse(e.data);
  updatePrices(d.prices);
});

es.addEventListener('agent', function(e) {
  var d = JSON.parse(e.data);
  updateAgent(d);
});

es.addEventListener('arb', function(e) {
  var d = JSON.parse(e.data);
  updateArb(d.opportunities);
});

es.addEventListener('news', function(e) {
  var n = JSON.parse(e.data);
  addNewsItem(n);
});

es.addEventListener('agent_status', function(e) {
  var d = JSON.parse(e.data);
  _agentRunning = d.running;
  updateAgentUI();
  addLog('Agent ' + (_agentRunning ? 'STARTED' : 'STOPPED'));
});

function startAgent() {
  document.getElementById('start-btn').disabled = true;
  fetch('/api/agent/start', { method: 'POST' }).then(function(r) { return r.json(); }).then(function(d) {
    _agentRunning = true;
    updateAgentUI();
    addLog('Agent started');
  }).catch(function(e) {
    document.getElementById('start-btn').disabled = false;
    addLog('Failed to start agent: ' + e.message);
  });
}

function stopAgent() {
  document.getElementById('stop-btn').disabled = true;
  fetch('/api/agent/stop', { method: 'POST' }).then(function(r) { return r.json(); }).then(function(d) {
    _agentRunning = false;
    updateAgentUI();
    addLog('Agent stopped');
  }).catch(function(e) {
    document.getElementById('stop-btn').disabled = false;
  });
}

function updateAgentUI() {
  var badge = document.getElementById('agent-badge');
  var startBtn = document.getElementById('start-btn');
  var stopBtn = document.getElementById('stop-btn');
  if (_agentRunning) {
    badge.textContent = 'AGENT RUNNING';
    badge.className = 'badge badge-agent running';
    startBtn.style.display = 'none';
    stopBtn.style.display = '';
    stopBtn.disabled = false;
  } else {
    badge.textContent = 'AGENT STOPPED';
    badge.className = 'badge badge-agent stopped';
    startBtn.style.display = '';
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
  }
}

function updatePrices(priceList) {
  var c = document.getElementById('prices-container');
  if (!priceList || priceList.length === 0) return;
  c.innerHTML = priceList.map(function(p) {
    return '<div class="price-bar"><span class="price-name">' + p.name + '</span><span class="price-value">$' + p.price.toFixed(6) + '</span></div>';
  }).join('');
}

function updateAgent(d) {
  var dec = d.decision;
  document.getElementById('cycle-badge').textContent = 'Cycle #' + d.cycle;
  document.getElementById('strategy').textContent = dec.strategy || '—';
  document.getElementById('strategy').style.color = '#fff';
  document.getElementById('decision-source').textContent = '#' + d.cycle + ' (' + (dec.source || 'ai') + ')';
  document.getElementById('decision-source').style.color = '#ccc';

  var box = document.getElementById('agent-status');
  box.innerHTML = '<div class="label">Agent reasoning (cycle #' + d.cycle + ')</div>' +
    '<div>' + (dec.reasoning || 'No reasoning provided') + '</div>' +
    (dec.market_assessment ? '<div style="margin-top:8px;color:#555;font-size:12px">' + dec.market_assessment + '</div>' : '');

  var ac = document.getElementById('actions-container');
  if (dec.actions && dec.actions.length > 0) {
    ac.innerHTML = dec.actions.map(function(a) {
      return '<div class="action-item"><span class="action-icon">' + actionIcon(a.type, a.action) + '</span>' + actionLabel(a) + '</div>';
    }).join('');
  }

  if (d.state) {
    updatePortfolio(d.state.portfolio);
    updatePositions(d.state.positions);
  }

  addLog('Cycle #' + d.cycle + ': ' + (dec.strategy || 'neutral') + ' — ' + (dec.actions || []).map(function(a) { return a.type; }).join(', '));
  fetchTradeHistory();
}

function updatePortfolio(p) {
  if (!p) return;
  var c = document.getElementById('portfolio-section');
  c.innerHTML =
    '<div class="stat-row"><span class="stat-label">Balance</span><span class="stat-value">' + p.balance + '</span></div>' +
    '<div class="stat-row"><span class="stat-label">Open Value</span><span class="stat-value">' + p.openValue + '</span></div>' +
    '<div class="stat-row"><span class="stat-label">Total Value</span><span class="stat-value">' + p.totalValue + '</span></div>' +
    '<div class="stat-row"><span class="stat-label">Daily P&L</span><span class="stat-value ' + pnlColor(p.dailyPnl) + '">' + p.dailyPnl + '</span></div>' +
    '<div class="stat-row"><span class="stat-label">Total P&L</span><span class="stat-value ' + pnlColor(p.totalPnl) + '">' + p.totalPnl + '</span></div>' +
    '<div class="stat-row"><span class="stat-label">Trades</span><span class="stat-value">' + p.totalTrades + '</span></div>';
}

function updatePositions(positions) {
  var c = document.getElementById('positions-container');
  if (!positions || positions.length === 0) {
    c.innerHTML = '<div style="color:#444;font-size:13px">No open positions</div>';
    return;
  }
  c.innerHTML = positions.map(function(p) {
    var cls = p.pnl && p.pnl.startsWith('-') ? 'red' : 'green';
    return '<div class="position-card"><div><strong>' + p.token + '</strong><br><span style="font-size:12px;color:#555">Entry: ' + p.entry + ' &rarr; Current: ' + p.current + '</span></div><div class="' + cls + '">' + p.pnl + '</div></div>';
  }).join('');
}

function updateArb(opps) {
  var c = document.getElementById('arb-container');
  if (!opps || opps.length === 0) {
    c.innerHTML = '<div style="color:#444;font-size:13px">No profitable routes found</div>';
    return;
  }
  c.innerHTML = opps.map(function(o) {
    var steps = (o.steps || []).map(function(s) { return '<div class="arb-step">' + s.pool + ': ' + s.in + ' &rarr; ' + s.out + '</div>'; }).join('');
    return '<div class="arb-card"><div class="arb-profit">+$' + o.profit.toFixed(2) + ' (' + o.profitPct.toFixed(2) + '%)</div>' + steps + '</div>';
  }).join('');
}

function pnlColor(val) {
  var n = parseFloat(String(val).replace('$', ''));
  return n > 0 ? 'green' : n < 0 ? 'red' : '';
}

function actionIcon(type, action) {
  if (type === 'trade') return action === 'buy' ? '+' : '-';
  if (type === 'execute_arb') return '&gt;';
  if (type === 'close_position') return 'x';
  if (type === 'hold') return '.';
  if (type === 'scan_arb') return '?';
  return '~';
}

function actionLabel(a) {
  if (a.type === 'trade') return a.action.toUpperCase() + ' ' + (a.pool || '') + ' — ' + (a.reason || '');
  if (a.type === 'execute_arb') return 'Execute arb — ' + (a.reason || '');
  if (a.type === 'close_position') return 'Close ' + (a.token || '') + ' — ' + (a.reason || '');
  if (a.type === 'hold') return 'HOLD — ' + (a.reason || '');
  if (a.type === 'scan_arb') return 'Scan arb — ' + (a.reason || '');
  return a.type + ' — ' + (a.reason || '');
}

function fetchTradeHistory() {
  fetch('/api/trades').then(function(r) { return r.json(); }).then(updateTradeHistory).catch(function() {});
}

function updateTradeHistory(trades) {
  if (!trades || trades.length === 0) return;
  var executed = trades.filter(function(t) { return t.type === 'arb' || t.type === 'buy' || t.type === 'sell'; });

  var totalProfit = executed.reduce(function(s, t) { return s + (t.pnl || 0); }, 0);
  var arbTrades = executed.filter(function(t) { return t.type === 'arb'; });
  var dirTrades = executed.filter(function(t) { return t.type !== 'arb'; });
  var winners = executed.filter(function(t) { return (t.pnl || 0) > 0; }).length;

  document.getElementById('th-total').textContent = executed.length;
  document.getElementById('th-arbs').textContent = arbTrades.length;
  document.getElementById('th-directional').textContent = dirTrades.length;
  var profitEl = document.getElementById('th-profit');
  profitEl.textContent = (totalProfit >= 0 ? '+' : '') + '$' + totalProfit.toFixed(2);
  profitEl.style.color = totalProfit > 0 ? '#6c6' : totalProfit < 0 ? '#c66' : '#555';
  document.getElementById('th-winrate').textContent = executed.length > 0 ? Math.round(winners / executed.length * 100) + '%' : '—';

  var c = document.getElementById('trades-container');
  c.innerHTML = executed.slice().reverse().map(function(t) {
    var isArb = t.type === 'arb';
    var typeLabel, typeClass;
    if (isArb) { typeLabel = 'ARB'; typeClass = 'arb'; }
    else if (t.type === 'buy') { typeLabel = 'BUY'; typeClass = 'buy'; }
    else if (t.type === 'sell') { typeLabel = 'SELL'; typeClass = 'sell'; }
    else { typeLabel = (t.type || '?').toUpperCase(); typeClass = 'buy'; }

    var pnl = t.pnl || 0;
    var pnlPct = t.pnlPct || 0;
    var pnlClass = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'zero';
    var pnlStr = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
    var pctStr = '(' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%)';
    var time = t.time ? new Date(t.time).toLocaleTimeString() : '';
    var token = isArb ? 'Triangular Arb' : (t.token || '?');
    var priceStr = t.price ? ' @ $' + Number(t.price).toFixed(4) : '';
    var modeTag = t.mode === 'vault' ? ' [vault]' : t.mode === 'live' ? ' [live]' : '';
    var hashLink = t.txHash ? '<div class="td-hash"><a href="' + EXPLORER + '/tx/' + t.txHash + '" target="_blank">tx: ' + t.txHash.slice(0, 10) + '...' + t.txHash.slice(-6) + '</a></div>' : '';

    return '<div class="trade-row">' +
      '<span class="trade-type ' + typeClass + '">' + typeLabel + '</span>' +
      '<div class="trade-detail">' +
        '<div class="td-token">' + token + priceStr + modeTag + '</div>' +
        '<div class="td-reason">' + (t.reason || '') + '</div>' +
        hashLink +
      '</div>' +
      '<span class="trade-pnl ' + pnlClass + '">' + pnlStr + ' <span style="font-size:10px;color:#444">' + pctStr + '</span></span>' +
      '<span class="trade-time">' + time + '</span>' +
      '</div>';
  }).join('');
}

function loadOnChainEvents() {
  fetch('/api/onchain/events').then(function(r) { return r.json(); }).then(function(events) {
    var c = document.getElementById('onchain-events');
    if (!Array.isArray(events) || events.length === 0) {
      c.innerHTML = '<div style="color:#444;font-size:13px">No vault events found on-chain</div>';
      return;
    }
    c.innerHTML = events.slice().reverse().map(function(ev) {
      var typeClass = 'trade';
      var typeLabel = ev.event;
      if (ev.event === 'TradeExecuted') { typeLabel = 'TRADE'; typeClass = 'trade'; }
      else if (ev.event === 'ArbExecuted') { typeLabel = 'ARB'; typeClass = 'arb'; }
      else if (ev.event === 'Deposited') { typeLabel = 'DEPOSIT'; typeClass = 'deposit'; }
      else if (ev.event === 'Withdrawn') { typeLabel = 'WITHDRAW'; typeClass = 'withdraw'; }

      var detail = '';
      if (ev.event === 'TradeExecuted') {
        detail = ev.tokenIn + ' &rarr; ' + ev.tokenOut + ' | In: ' + ev.amountIn.toFixed(4) + ' | Out: ' + ev.amountOut.toFixed(4);
      } else if (ev.event === 'ArbExecuted') {
        var profit = ev.profit || (ev.amountOut - ev.amountIn);
        var profitPct = ev.amountIn > 0 ? ((profit / ev.amountIn) * 100).toFixed(2) : '0';
        detail = 'In: $' + ev.amountIn.toFixed(2) + ' &rarr; Out: $' + ev.amountOut.toFixed(2) + ' | P&L: <span class="' + (profit >= 0 ? 'green' : 'red') + '">$' + profit.toFixed(2) + ' (' + profitPct + '%)</span>';
      } else if (ev.event === 'Deposited' || ev.event === 'Withdrawn') {
        detail = ev.token + ': ' + ev.amount.toFixed(4);
      }

      var timeStr = ev.timestamp ? new Date(ev.timestamp).toLocaleString() : 'Block #' + ev.blockNumber;
      var hashLink = '<a href="' + EXPLORER + '/tx/' + ev.txHash + '" target="_blank">' + ev.txHash.slice(0, 10) + '...' + ev.txHash.slice(-6) + '</a>';

      return '<div class="onchain-event">' +
        '<span class="event-type ' + typeClass + '">' + typeLabel + '</span>' +
        '<div class="event-detail">' +
          '<div>' + detail + '</div>' +
          '<div style="margin-top:2px">' + hashLink + ' &middot; <span style="color:#333">' + timeStr + '</span></div>' +
        '</div>' +
        '</div>';
    }).join('');
  }).catch(function(e) {
    document.getElementById('onchain-events').innerHTML = '<div style="color:#c66;font-size:12px">Error loading events: ' + e.message + '</div>';
  });
}

function addNewsItem(n) {
  var c = document.getElementById('news-container');
  if (c.querySelector('[style*="color:#444"]')) c.innerHTML = '';
  var time = new Date(n.timestamp).toLocaleTimeString();
  var tokens = (n.tokens || []).join(', ');
  var html = '<div class="news-item news-flash ' + n.sentiment + '">' +
    '<div class="news-headline">' + n.headline + '</div>' +
    '<div class="news-meta">' +
    '<span class="news-tag ' + n.sentiment + '">' + n.sentiment + '</span>' +
    '<span class="news-tag ' + n.impact + '">' + n.impact + '</span>' +
    '<span>' + tokens + '</span>' +
    '<span>' + time + '</span>' +
    '</div></div>';
  c.insertAdjacentHTML('afterbegin', html);
  if (c.children.length > 15) c.removeChild(c.lastChild);
}

function addLog(msg) {
  var c = document.getElementById('log-container');
  var time = new Date().toLocaleTimeString();
  c.innerHTML = '<div class="log-entry"><span class="time">' + time + '</span> — <span class="highlight">' + msg + '</span></div>' + c.innerHTML;
  if (c.children.length > 50) c.removeChild(c.lastChild);
}

function sendChat() {
  var input = document.getElementById('chat-input');
  var msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  addChatMsg(msg, 'user');
  fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg })
  })
  .then(function(r) { return r.json(); })
  .then(function(reply) { addChatMsg(reply.message, 'bot'); })
  .catch(function(e) { addChatMsg('Error: ' + e.message, 'bot'); });
}

function addChatMsg(text, role) {
  var c = document.getElementById('chat-messages');
  var div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  var pre = document.createElement('pre');
  pre.textContent = text;
  div.appendChild(pre);
  c.appendChild(div);
  c.scrollTop = c.scrollHeight;
}

// === WALLET & VAULT ===
var VAULT_ADDR = '${require("./testnet_deployment.json").contracts.vault || ""}';
var TOKENS = ${JSON.stringify(
  Object.fromEntries(
    Object.entries(require("./testnet_deployment.json").tokens).map(([name, info]) => [name, { address: info.address, decimals: info.decimals }])
  )
)};
var HSK_CHAIN_ID = '0x${(config.CHAIN_ID || 133).toString(16)}';

var VAULT_ABI = [
  'function deposit(address token, uint256 amount)',
  'function withdraw(address token, uint256 amount)',
  'function emergencyWithdraw(address token)',
  'function getTokenBalance(address token) view returns (uint256)',
  'function getVaultState() view returns (address, address, address, uint256, uint256, uint256, uint256, uint256, bool)',
  'function pause()',
  'function unpause()',
];

var ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

var walletProvider = null;
var walletSigner = null;
var walletAddress = null;
var vaultContract = null;
var isVaultPaused = false;

function setTxStatus(msg, type) {
  var el = document.getElementById('tx-status');
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

    await refreshWalletBalances();

    if (VAULT_ADDR) {
      vaultContract = new ethers.Contract(VAULT_ADDR, VAULT_ABI, walletSigner);
      document.getElementById('vault-not-connected').style.display = 'none';
      document.getElementById('vault-connected').style.display = 'block';
      await refreshVault();
    }

    loadOnChainEvents();
    addLog('Connected ' + walletName + ': ' + walletAddress.slice(0,6) + '...' + walletAddress.slice(-4));

    provider.on('accountsChanged', function() { location.reload(); });
    provider.on('chainChanged', function() { location.reload(); });
  } catch (e) {
    const btn = document.getElementById('connect-btn');
    btn.textContent = 'CONNECT WALLET';
    btn.disabled = false;
    alert('Connection failed: ' + e.message);
  }
}

async function refreshWalletBalances() {
  if (!walletProvider || !walletAddress) return;
  try {
    var hskBal = await walletProvider.getBalance(walletAddress);
    var html = '<div class="vault-token-row"><span class="vault-token-name">HSK (native)</span><span class="vault-token-bal">' +
      parseFloat(ethers.formatEther(hskBal)).toFixed(4) + '</span></div>';
    for (var name in TOKENS) {
      var info = TOKENS[name];
      var tokenContract = new ethers.Contract(info.address, ERC20_ABI, walletProvider);
      var bal = await tokenContract.balanceOf(walletAddress);
      html += '<div class="vault-token-row"><span class="vault-token-name">' + name + '</span><span class="vault-token-bal">' +
        parseFloat(ethers.formatUnits(bal, info.decimals)).toLocaleString(undefined, {maximumFractionDigits: 4}) + '</span></div>';
    }
    document.getElementById('wallet-balances').innerHTML = html;
  } catch (e) {
    document.getElementById('wallet-balances').innerHTML = '<div style="color:#c66;font-size:12px">Error: ' + e.message + '</div>';
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

    var balHTML = [];
    for (var name in TOKENS) {
      var info = TOKENS[name];
      var vaultBal = await vaultContract.getTokenBalance(info.address);
      var dec = info.decimals;
      balHTML.push(
        '<div class="vault-token-row">' +
        '<span class="vault-token-name">' + name + '</span>' +
        '<span class="vault-token-bal">' + parseFloat(ethers.formatUnits(vaultBal, dec)).toLocaleString(undefined, {maximumFractionDigits: 4}) + '</span>' +
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
    await refreshWalletBalances();
    loadOnChainEvents();
  } catch (e) {
    setTxStatus('Deposit failed: ' + (e.reason || e.message).slice(0, 80), 'error');
  }
}

async function withdrawFromVault() {
  if (!vaultContract || !walletSigner) return;
  const tokenName = document.getElementById('deposit-token').value;
  const amount = document.getElementById('deposit-amount').value;
  if (!amount || parseFloat(amount) <= 0) { setTxStatus('Enter a valid amount', 'error'); return; }

  const info = TOKENS[tokenName];
  const parsedAmount = ethers.parseUnits(amount, info.decimals);

  try {
    setTxStatus('Withdrawing ' + amount + ' ' + tokenName + '...', 'pending');
    const tx = await vaultContract.withdraw(info.address, parsedAmount);
    await tx.wait();
    setTxStatus('Withdrawn ' + amount + ' ' + tokenName + ' — tx: ' + tx.hash.slice(0,10) + '...', 'success');
    document.getElementById('deposit-amount').value = '';
    addLog('Withdrawn ' + amount + ' ' + tokenName + ' from vault');
    await refreshVault();
    await refreshWalletBalances();
    loadOnChainEvents();
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
    await refreshWalletBalances();
    loadOnChainEvents();
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

setInterval(function() {
  if (vaultContract) refreshVault();
  if (walletAddress) refreshWalletBalances();
}, 30000);
</script>
</body>
</html>`;
}

// --- Agent loop (only runs when user clicks Start) ---
function startAgentLoop() {
  let nextAgentTime = Date.now() + 10_000;
  let nextArbTime = Date.now() + (config.ARB_SCAN_MS || 30_000);
  let nextReportTime = Date.now() + config.REPORT_MS;

  agentLoop = setInterval(async () => {
    if (!agentRunning) { clearInterval(agentLoop); agentLoop = null; return; }
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
}

// --- Main (dashboard only, agent NOT started) ---
async function main() {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  AI AGENT TRADING BOT — Dashboard`);
  console.log(`${"=".repeat(70)}`);
  console.log(`  Mode: ${config.MODE.toUpperCase()} | Agent: STOPPED (click Start to begin)`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`${"=".repeat(70)}\n`);

  app.listen(PORT, () => {
    console.log(`  Dashboard running at http://localhost:${PORT}\n`);
  });

  console.log("  Warming up — initial price poll + arb scan...\n");
  await pollPrices();
  await runArbScan();

  // Price polling runs regardless (no API cost, just RPC reads)
  setInterval(async () => {
    try { await pollPrices(); } catch (e) { console.error(`  Poll error: ${e.message}`); }
  }, config.POLL_MS);

  process.on("SIGINT", () => {
    agentRunning = false;
    if (agentLoop) clearInterval(agentLoop);
    console.log("\n  Agent stopped. Goodbye!\n");
    history.save();
    process.exit(0);
  });
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
