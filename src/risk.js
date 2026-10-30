const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const config = require("./config");

const state = {
  balance: config.STARTING_BALANCE,
  startOfDayBalance: config.STARTING_BALANCE,
  positions: [],
  closedToday: [],
  dailyPnl: 0,
  totalPnl: 0,
  totalTrades: 0,
  dayStart: Date.now(),
  onChainBalances: {},
};

async function fetchOnChainBalances() {
  if (config.MODE !== "live" || !config.PRIVATE_KEY) return null;
  try {
    const depFile = path.join(__dirname, "..", "testnet_deployment.json");
    const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));
    const provider = new ethers.JsonRpcProvider(config.RPC_URL);
    const wallet = new ethers.Wallet(config.PRIVATE_KEY, provider);
    const ERC20 = ["function balanceOf(address) view returns (uint256)"];
    const balances = {};
    for (const [name, info] of Object.entries(dep.tokens)) {
      const c = new ethers.Contract(info.address, ERC20, provider);
      const bal = await c.balanceOf(wallet.address);
      balances[name] = parseFloat(ethers.formatUnits(bal, info.decimals));
    }
    const hsk = await provider.getBalance(wallet.address);
    balances.HSK = parseFloat(ethers.formatEther(hsk));
    state.onChainBalances = balances;
    return balances;
  } catch (e) {
    console.error("  Balance fetch error:", e.message);
    return null;
  }
}

function resetDaily() {
  state.startOfDayBalance = state.balance;
  state.closedToday = [];
  state.dailyPnl = 0;
  state.dayStart = Date.now();
}

function canOpenPosition(token, price, signal) {
  if (state.positions.length >= config.MAX_OPEN_POSITIONS) {
    return { ok: false, reason: `Max ${config.MAX_OPEN_POSITIONS} open positions reached` };
  }
  if (state.positions.find(p => p.token === token)) {
    return { ok: false, reason: `Already have open position in ${token}` };
  }

  const maxUsdt = state.balance * (config.MAX_POSITION_PCT / 100);
  if (maxUsdt < 1) {
    return { ok: false, reason: `Position size too small ($${maxUsdt.toFixed(2)})` };
  }

  const dailyLossLimit = state.startOfDayBalance * (config.DAILY_LOSS_LIMIT_PCT / 100);
  if (state.dailyPnl <= -dailyLossLimit) {
    return { ok: false, reason: `Daily loss limit hit ($${state.dailyPnl.toFixed(2)})` };
  }

  if (signal.confidence < 0.5) {
    return { ok: false, reason: `Signal confidence too low (${signal.confidence})` };
  }

  return { ok: true, maxUsdt, reason: "Approved" };
}

function openPosition(token, price, amountUsdt) {
  const amount = amountUsdt / price;
  const pos = {
    token,
    entryPrice: price,
    currentPrice: price,
    amount,
    costUsdt: amountUsdt,
    stopLoss: price * (1 - config.STOP_LOSS_PCT / 100),
    takeProfit: price * (1 + config.TAKE_PROFIT_PCT / 100),
    openedAt: Date.now(),
  };
  state.positions.push(pos);
  state.balance -= amountUsdt;
  state.totalTrades++;
  return pos;
}

function closePosition(token, currentPrice, reason = "manual") {
  const idx = state.positions.findIndex(p => p.token === token);
  if (idx === -1) return null;

  const pos = state.positions[idx];
  const valueNow = pos.amount * currentPrice;
  const pnl = valueNow - pos.costUsdt;
  const pnlPct = (pnl / pos.costUsdt) * 100;

  state.balance += valueNow;
  state.dailyPnl += pnl;
  state.totalPnl += pnl;
  state.positions.splice(idx, 1);

  const record = { ...pos, closePrice: currentPrice, pnl, pnlPct, reason, closedAt: Date.now() };
  state.closedToday.push(record);
  return record;
}

function checkStopLossTakeProfit(prices) {
  const closed = [];
  for (const pos of [...state.positions]) {
    const price = prices[pos.token];
    if (!price) continue;
    pos.currentPrice = price;

    if (price <= pos.stopLoss) {
      closed.push(closePosition(pos.token, price, "stop-loss"));
    } else if (price >= pos.takeProfit) {
      closed.push(closePosition(pos.token, price, "take-profit"));
    }
  }
  return closed;
}

function getState() {
  const openValue = state.positions.reduce((sum, p) => sum + p.amount * p.currentPrice, 0);
  return {
    balance: state.balance,
    openValue,
    totalValue: state.balance + openValue,
    positions: state.positions.map(p => ({
      ...p,
      unrealizedPnl: (p.amount * p.currentPrice) - p.costUsdt,
      unrealizedPct: ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100,
    })),
    dailyPnl: state.dailyPnl,
    totalPnl: state.totalPnl,
    totalTrades: state.totalTrades,
    closedToday: state.closedToday,
    onChainBalances: state.onChainBalances,
  };
}

module.exports = { canOpenPosition, openPosition, closePosition, checkStopLossTakeProfit, getState, resetDaily, fetchOnChainBalances, state };
