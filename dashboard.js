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

const app = express();
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
  .purple { color: #fff; font-weight: 500; }
</style>
</head>
<body>
<div class="header">
  <h1><span>AI Agent</span> Trading Bot — HashKey Chain</h1>
  <div>
    <span class="badge badge-sim" id="mode-badge">${config.MODE === 'live' ? 'LIVE' : 'SIMULATE'}</span>
    <span class="badge badge-ai" id="ai-badge">AI Agent</span>
    <span class="cycle-badge" id="cycle-badge">Cycle #0</span>
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
    <div id="chain-balances" style="margin-top:12px;border-top:1px solid #222;padding-top:12px;display:none">
      <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#666;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px">On-Chain Balances</div>
      <div id="chain-balances-list"></div>
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

  <!-- News Feed -->
  <div class="card full-width">
    <div class="card-title">News Feed — Agent reacts to market news</div>
    <div id="news-container" style="max-height:240px;overflow-y:auto">
      <div style="color:#555;font-size:13px">Monitoring news sources...</div>
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

<script>
const es = new EventSource('/api/events');

es.addEventListener('connected', () => {
  addLog('Connected to agent dashboard');
  fetch('/api/state').then(r => r.json()).then(updateState);
  fetch('/api/news').then(r => r.json()).then(news => {
    news.forEach(n => addNewsItem(n));
  });
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
  if (s.portfolio.onChainBalances && Object.keys(s.portfolio.onChainBalances).length > 0) {
    const cb = document.getElementById('chain-balances');
    const cl = document.getElementById('chain-balances-list');
    cb.style.display = 'block';
    cl.innerHTML = Object.entries(s.portfolio.onChainBalances).map(function(e) {
      return '<div class="stat-row"><span class="stat-label">' + e[0] + '</span><span class="stat-value">' + (typeof e[1] === 'number' ? e[1].toLocaleString(undefined, {maximumFractionDigits: 4}) : e[1]) + '</span></div>';
    }).join('');
  }
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
        agentCycleCount++;
        console.log(`\n  ── AGENT CYCLE #${agentCycleCount} ──`);
        const result = await runAgent();
        nextAgentTime = Date.now() + result.nextCheckMs;
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
