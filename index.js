const config = require("./src/config");
const { readPool } = require("./src/chain");
const history = require("./src/history");
const risk = require("./src/risk");
const { nextPrice, isSimulating } = require("./src/simulator");
const { scanArbitrage } = require("./src/arb");
const { runAgentCycle, getActionLog, log } = require("./src/agent");

const prices = {};
let pollCount = 0;
let lastArbOpportunities = [];
let agentCycleCount = 0;

function fmt(n, d = 6) { return typeof n === "number" ? n.toFixed(d) : "?"; }
function fmtUsd(n) { return `$${n.toFixed(2)}`; }
function ts() { return new Date().toLocaleTimeString(); }

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
    console.log(`  [${ts()}] AUTO-CLOSE ${c.token} @ $${fmt(c.closePrice)} | ${c.reason} | PnL: ${fmtUsd(c.pnl)} (${c.pnlPct.toFixed(1)}%)`);
    log({ type: "auto_close", ...c });
  }

  if (dashboardEmitter) {
    dashboardEmitter({ type: "prices", data: results, pollCount });
  }

  return results;
}

async function runArbScan() {
  const poolAddrs = config.POOLS.map(p => p.addr);
  lastArbOpportunities = await scanArbitrage(poolAddrs, 1000);
  return lastArbOpportunities;
}

function printReport() {
  const s = risk.getState();
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  PORTFOLIO REPORT — ${new Date().toLocaleString()}`);
  console.log(`${"=".repeat(70)}`);
  console.log(`  Mode: ${config.MODE.toUpperCase()} | Agent Cycles: ${agentCycleCount} | Polls: ${pollCount}`);
  console.log(`  Balance: ${fmtUsd(s.balance)} | Open: ${fmtUsd(s.openValue)} | Total: ${fmtUsd(s.totalValue)}`);
  console.log(`  Daily P&L: ${fmtUsd(s.dailyPnl)} | Total P&L: ${fmtUsd(s.totalPnl)} | Trades: ${s.totalTrades}`);

  if (s.positions.length > 0) {
    console.log(`\n  Open Positions:`);
    for (const p of s.positions) {
      console.log(`    ${p.token}: ${p.amount.toFixed(4)} @ $${fmt(p.entryPrice)} → $${fmt(p.currentPrice)} | PnL: ${fmtUsd(p.unrealizedPnl)} (${p.unrealizedPct.toFixed(1)}%)`);
    }
  }

  if (s.closedToday.length > 0) {
    console.log(`\n  Today's Closed:`);
    for (const c of s.closedToday) {
      console.log(`    ${c.token}: ${c.reason} | PnL: ${fmtUsd(c.pnl)} (${c.pnlPct.toFixed(1)}%)`);
    }
  }
  console.log(`${"=".repeat(70)}\n`);
}

// --- Dashboard SSE support ---
let dashboardEmitter = null;
function setDashboardEmitter(fn) { dashboardEmitter = fn; }

// --- Agent-driven main loop ---
async function main() {
  const modeLabel = config.MODE === "simulate" ? "SIMULATE (AI Agent + price movement)" : config.MODE.toUpperCase();

  console.log(`\n${"=".repeat(70)}`);
  console.log(`  🤖 AI AGENT TRADING BOT — HashKey Chain`);
  console.log(`${"=".repeat(70)}`);
  console.log(`  Mode: ${modeLabel} | Starting balance: ${fmtUsd(config.STARTING_BALANCE)}`);
  console.log(`  Pools: ${config.POOLS.map(p => p.name).join(", ")}`);
  const aiStatus = (config.AI_PROVIDER === "openrouter" && config.OPENROUTER_API_KEY)
    ? `${config.AI_MODEL} via OpenRouter`
    : config.ANTHROPIC_API_KEY ? `${config.AI_MODEL} via Anthropic` : "Rule-based fallback";
  console.log(`  AI Agent: ${aiStatus}`);
  console.log(`  Architecture: AI is the ORCHESTRATOR — it decides all trades, arb, risk`);
  console.log(`${"=".repeat(70)}\n`);

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
        console.log(`\n${"─".repeat(50)}`);
        console.log(`  AGENT CYCLE #${agentCycleCount} — ${new Date().toLocaleTimeString()}`);
        console.log(`${"─".repeat(50)}`);

        const result = await runAgentCycle(prices, lastArbOpportunities);

        if (dashboardEmitter) {
          dashboardEmitter({
            type: "agent_cycle",
            cycle: agentCycleCount,
            decision: result.decision,
            results: result.results,
            state: result.systemState,
          });
        }

        nextAgentTime = Date.now() + result.nextCheckMs;
        console.log(`  ⏰ Next decision in ${(result.nextCheckMs / 1000).toFixed(0)}s`);
      }

      if (Date.now() >= nextReportTime) {
        printReport();
        history.save();
        nextReportTime = Date.now() + config.REPORT_MS;
      }
    } catch (e) {
      console.error(`  [${ts()}] Loop error: ${e.message}`);
    }
  }, config.POLL_MS);

  process.on("SIGINT", () => {
    clearInterval(loop);
    console.log("\n  Shutting down agent...");
    printReport();
    history.save();
    console.log("  Agent stopped. Goodbye!\n");
    process.exit(0);
  });
}

// Export for dashboard
module.exports = { main, prices, getActionLog, setDashboardEmitter, pollPrices, runArbScan };

if (require.main === module) {
  main().catch(e => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
