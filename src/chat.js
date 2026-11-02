const risk = require("./risk");
const config = require("./config");
const { getActionLog } = require("./agent");
const { scanArbitrage } = require("./arb");

const COMMANDS = {
  status: { desc: "Show portfolio status and P&L", fn: cmdStatus },
  balance: { desc: "Show current balances", fn: cmdBalance },
  positions: { desc: "Show open positions", fn: cmdPositions },
  history: { desc: "Show recent trade history", fn: cmdHistory },
  arb: { desc: "Show current arb opportunities", fn: cmdArb },
  limits: { desc: "Show current risk limits", fn: cmdLimits },
  pause: { desc: "Pause trading", fn: cmdPause },
  resume: { desc: "Resume trading", fn: cmdResume },
  help: { desc: "Show available commands", fn: cmdHelp },
};

let tradingPaused = false;
function isTradingPaused() { return tradingPaused; }

async function processMessage(text) {
  const trimmed = text.trim().toLowerCase();

  for (const [cmd, info] of Object.entries(COMMANDS)) {
    if (trimmed === cmd || trimmed.startsWith(cmd + " ")) {
      return await info.fn(trimmed);
    }
  }

  return handleNaturalLanguage(trimmed);
}

function cmdStatus() {
  const s = risk.getState();
  return {
    type: "status",
    message: `Portfolio: $${s.totalValue.toFixed(2)} | Balance: $${s.balance.toFixed(2)} | Open: $${s.openValue.toFixed(2)}\nDaily P&L: $${s.dailyPnl.toFixed(2)} | Total P&L: $${s.totalPnl.toFixed(2)} | Trades: ${s.totalTrades}\nOpen positions: ${s.positions.length}/${config.MAX_OPEN_POSITIONS} | Mode: ${config.MODE}`,
  };
}

function cmdBalance() {
  const s = risk.getState();
  let msg = `Available: $${s.balance.toFixed(2)}\nOpen value: $${s.openValue.toFixed(2)}\nTotal: $${s.totalValue.toFixed(2)}`;
  if (s.onChainBalances && Object.keys(s.onChainBalances).length > 0) {
    msg += "\n\nOn-chain:";
    for (const [token, bal] of Object.entries(s.onChainBalances)) {
      msg += `\n  ${token}: ${typeof bal === "number" ? bal.toFixed(4) : bal}`;
    }
  }
  return { type: "balance", message: msg };
}

function cmdPositions() {
  const s = risk.getState();
  if (s.positions.length === 0) return { type: "positions", message: "No open positions." };
  const lines = s.positions.map(p =>
    `${p.token}: entry $${p.entryPrice.toFixed(6)} | current $${p.currentPrice.toFixed(6)} | P&L: $${p.unrealizedPnl.toFixed(2)} (${p.unrealizedPct.toFixed(1)}%)`
  );
  return { type: "positions", message: lines.join("\n") };
}

function cmdHistory() {
  const s = risk.getState();
  if (s.closedToday.length === 0) return { type: "history", message: "No trades today." };
  const recent = s.closedToday.slice(-5);
  const lines = recent.map(t =>
    `${t.token}: ${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)} (${t.pnlPct.toFixed(1)}%) — ${t.reason}`
  );
  return { type: "history", message: `Last ${recent.length} trades:\n${lines.join("\n")}` };
}

async function cmdArb() {
  const poolAddrs = config.POOLS.map(p => p.addr);
  const opps = await scanArbitrage(poolAddrs, 1000);
  if (opps.length === 0) return { type: "arb", message: "No profitable arb routes detected right now." };
  const lines = opps.slice(0, 3).map(o =>
    `$${o.profit.toFixed(2)} (${o.profitPct.toFixed(2)}%): ${o.steps.map(s => `${s.in}->${s.out}`).join(" -> ")}`
  );
  return { type: "arb", message: `Arb opportunities:\n${lines.join("\n")}` };
}

function cmdLimits() {
  return {
    type: "limits",
    message: `Max position: ${config.MAX_POSITION_PCT}%\nStop loss: ${config.STOP_LOSS_PCT}%\nTake profit: ${config.TAKE_PROFIT_PCT}%\nDaily loss limit: ${config.DAILY_LOSS_LIMIT_PCT}%\nMax open positions: ${config.MAX_OPEN_POSITIONS}\nMode: ${config.MODE}`,
  };
}

function cmdPause() {
  tradingPaused = true;
  return { type: "control", message: "Trading PAUSED. The agent will not execute trades until you type 'resume'." };
}

function cmdResume() {
  tradingPaused = false;
  return { type: "control", message: "Trading RESUMED. The agent will continue normal operations." };
}

function cmdHelp() {
  const lines = Object.entries(COMMANDS).map(([cmd, info]) => `  ${cmd} — ${info.desc}`);
  return { type: "help", message: `Available commands:\n${lines.join("\n")}\n\nYou can also ask questions naturally like "how is my portfolio doing?" or "why did you sell TALPHA?"` };
}

function handleNaturalLanguage(text) {
  if (text.includes("portfolio") || text.includes("how am i doing") || text.includes("performance")) {
    return cmdStatus();
  }
  if (text.includes("position") || text.includes("holding")) {
    return cmdPositions();
  }
  if (text.includes("balance") || text.includes("wallet") || text.includes("funds")) {
    return cmdBalance();
  }
  if (text.includes("arb") || text.includes("arbitrage") || text.includes("opportunity")) {
    return cmdArb();
  }
  if (text.includes("history") || text.includes("trade") || text.includes("recent")) {
    return cmdHistory();
  }
  if (text.includes("limit") || text.includes("risk") || text.includes("setting")) {
    return cmdLimits();
  }
  if (text.includes("stop") || text.includes("pause") || text.includes("halt")) {
    return cmdPause();
  }
  if (text.includes("start") || text.includes("resume") || text.includes("continue") || text.includes("go")) {
    return cmdResume();
  }
  if (text.includes("why") || text.includes("reason") || text.includes("explain")) {
    const log = getActionLog();
    const lastDecision = [...log].reverse().find(e => e.type === "decision");
    if (lastDecision) {
      return {
        type: "reasoning",
        message: `Last decision:\n  Reasoning: ${lastDecision.decision.reasoning}\n  Strategy: ${lastDecision.decision.strategy}\n  Market: ${lastDecision.decision.market_assessment}`,
      };
    }
    return { type: "reasoning", message: "No recent decisions to explain yet." };
  }
  if (text.includes("help") || text.includes("what can you do") || text.includes("command")) {
    return cmdHelp();
  }

  return {
    type: "unknown",
    message: "I understand commands like: status, balance, positions, history, arb, limits, pause, resume, help. You can also ask naturally about your portfolio, trades, or the agent's reasoning.",
  };
}

module.exports = { processMessage, isTradingPaused, COMMANDS };
