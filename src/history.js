const fs = require("fs");
const path = require("path");

const HISTORY_FILE = path.join(__dirname, "..", "price_history.json");
const MAX_ENTRIES = 10_000;

let store = {};

function load() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      store = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    }
  } catch { store = {}; }
}

function save() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(store));
  } catch (e) {
    console.error("  History save failed:", e.message);
  }
}

function addPrice(poolName, price, tvl = 0) {
  if (!store[poolName]) store[poolName] = [];
  store[poolName].push({ ts: Date.now(), price, tvl });
  if (store[poolName].length > MAX_ENTRIES) {
    store[poolName] = store[poolName].slice(-MAX_ENTRIES);
  }
}

function getRecent(poolName, minutes = 30) {
  const entries = store[poolName] || [];
  const cutoff = Date.now() - minutes * 60_000;
  return entries.filter(e => e.ts >= cutoff);
}

function getStats(poolName, minutes = 30) {
  const data = getRecent(poolName, minutes);
  if (data.length < 2) return null;

  const prices = data.map(d => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const latest = prices[prices.length - 1];
  const first = prices[0];
  const changePct = ((latest - first) / first) * 100;
  const variance = prices.reduce((sum, p) => sum + (p - avg) ** 2, 0) / prices.length;
  const volatility = (Math.sqrt(variance) / avg) * 100;

  return { min, max, avg, latest, first, changePct, volatility, samples: data.length, period: minutes };
}

function getAllStats(minutes = 30) {
  const result = {};
  for (const name of Object.keys(store)) {
    const s = getStats(name, minutes);
    if (s) result[name] = s;
  }
  return result;
}

function getPriceArray(poolName, minutes = 30, maxPoints = 20) {
  const data = getRecent(poolName, minutes);
  if (data.length <= maxPoints) return data.map(d => d.price);
  const step = Math.floor(data.length / maxPoints);
  return data.filter((_, i) => i % step === 0).map(d => d.price);
}

load();

module.exports = { addPrice, getRecent, getStats, getAllStats, getPriceArray, save, load };
