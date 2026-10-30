const config = require("./config");

const baseVolatility = {
  "HSK/USDT":    0.025,
  "WBTC/USDT":   0.008,
  "WETH/USDT":   0.012,
  "TSLA/USDT":   0.018,
  "QQQ/USDT":    0.010,
  "AAPL/USDT":   0.014,
  "NVDA/USDT":   0.020,
  "CRCL/USDT":   0.030,
  "USDC.e/HSK":  0.025,
};

const state = {};

function initPool(poolName, realPrice) {
  if (state[poolName]) return;
  state[poolName] = {
    price: realPrice,
    trend: (Math.random() - 0.5) * 0.002,
    momentum: 0,
    lastShock: 0,
  };
}

function nextPrice(poolName, realPrice) {
  initPool(poolName, realPrice);
  const s = state[poolName];
  const vol = baseVolatility[poolName] || 0.015;

  const noise = (Math.random() - 0.5) * 2 * vol;

  s.momentum = s.momentum * 0.85 + noise * 0.15;

  if (Math.random() < 0.03) {
    s.trend = (Math.random() - 0.5) * 0.004;
  }

  if (Math.random() < 0.02) {
    s.lastShock = (Math.random() - 0.5) * vol * 4;
  } else {
    s.lastShock *= 0.5;
  }

  const meanRevert = (realPrice - s.price) / realPrice * 0.01;

  const change = s.trend + s.momentum + s.lastShock + meanRevert;
  s.price = s.price * (1 + change);

  if (s.price < realPrice * 0.8) s.price = realPrice * 0.8;
  if (s.price > realPrice * 1.2) s.price = realPrice * 1.2;

  return s.price;
}

function isSimulating() {
  return config.MODE === "simulate";
}

module.exports = { nextPrice, isSimulating, state };
