// scripts/live_price_monitor.js
//
// READ-ONLY monitor — connects to HashKey Chain mainnet via RPC,
// reads live pool prices from HSKSwap (V3) and HyperIndex (V2),
// compares them, and flags when a cross-DEX gap appears.
//
// No wallet, no trading, no signing — pure observation.
//
// Run:  node scripts/live_price_monitor.js
// Stop: Ctrl+C

const { ethers } = require("ethers");

// ═══ CONFIG ═════════════════════════════════════════════════════════════
const RPC_URL    = "https://mainnet.hsk.xyz";
const CHAIN_ID   = 177;
const POLL_MS    = 10_000;  // poll every 10 seconds
const FEE_FLOOR  = 0.6;    // minimum gap % to flag (two 0.3% V3 fees)
// ════════════════════════════════════════════════════════════════════════

// ── Known pools ─────────────────────────────────────────────────────────
// HSKSwap (Uniswap V3 fork)
const HSKSWAP_POOLS = [
  { name: "HSKSwap HSK/USDT",  addr: "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc", type: "v3" },
  { name: "HSKSwap WETH/USDT", addr: "0xb92b79ed6b370d5cfee2e14b1d0983c258304c16", type: "v3" },
  { name: "HSKSwap WBTC/USDT", addr: "0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a", type: "v3" },
];

// HyperIndex (Uniswap V2 style)
const HYPERINDEX_POOLS = [
  { name: "HyperIndex HSK/WETH", addr: "0x711d26aa3ff64dd9dc5fa22b7c64c26c1b28f8f2", type: "v2" },
];

// ── ABIs ────────────────────────────────────────────────────────────────
const V3_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
];

const V2_ABI = [
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

// ── Readers ─────────────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);

const tokenCache = {};
async function getTokenInfo(addr) {
  if (tokenCache[addr]) return tokenCache[addr];
  const c = new ethers.Contract(addr, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
  tokenCache[addr] = { symbol, decimals: Number(decimals) };
  return tokenCache[addr];
}

async function readV3(addr) {
  const pool = new ethers.Contract(addr, V3_ABI, provider);
  const [slot0, t0addr, t1addr, fee, liq] = await Promise.all([
    pool.slot0(), pool.token0(), pool.token1(), pool.fee(), pool.liquidity(),
  ]);
  const t0 = await getTokenInfo(t0addr);
  const t1 = await getTokenInfo(t1addr);

  const sqrtPrice = Number(slot0[0]) / 2 ** 96;
  const rawPrice = sqrtPrice * sqrtPrice;
  const price = rawPrice * Math.pow(10, t0.decimals - t1.decimals);

  return {
    token0: t0.symbol, token1: t1.symbol,
    price, // token1 per token0
    fee: Number(fee) / 10000,
    liquidity: Number(liq),
  };
}

async function readV2(addr) {
  const pool = new ethers.Contract(addr, V2_ABI, provider);
  const [reserves, t0addr, t1addr] = await Promise.all([
    pool.getReserves(), pool.token0(), pool.token1(),
  ]);
  const t0 = await getTokenInfo(t0addr);
  const t1 = await getTokenInfo(t1addr);

  const r0 = Number(ethers.formatUnits(reserves[0], t0.decimals));
  const r1 = Number(ethers.formatUnits(reserves[1], t1.decimals));

  return {
    token0: t0.symbol, token1: t1.symbol,
    r0, r1,
    price: r1 / r0, // token1 per token0
    depthUsd: null,  // filled in later if we know a USD rate
  };
}

// ── Stats ───────────────────────────────────────────────────────────────
let polls = 0;
let alerts = 0;
let maxGap = 0;
const gapHistory = [];

process.on("SIGINT", () => {
  console.log("\n\n╔═══════════════════════════════════════════════════╗");
  console.log("║              MONITOR SUMMARY                      ║");
  console.log("╠═══════════════════════════════════════════════════╣");
  console.log(`║  Polls: ${polls}`);
  console.log(`║  Alerts (gap > ${FEE_FLOOR}%): ${alerts}`);
  console.log(`║  Max gap seen: ${maxGap.toFixed(4)}%`);
  if (gapHistory.length > 0) {
    const avg = gapHistory.reduce((a, b) => a + b, 0) / gapHistory.length;
    console.log(`║  Avg gap: ${avg.toFixed(4)}%`);
  }
  console.log("╚═══════════════════════════════════════════════════╝");
  process.exit(0);
});

// ── Main loop ───────────────────────────────────────────────────────────
async function poll() {
  polls++;
  const time = new Date().toLocaleTimeString();

  try {
    // Read all pools in parallel
    const [hskUsdt, ethUsdt, btcUsdt, hskEth] = await Promise.all([
      readV3(HSKSWAP_POOLS[0].addr),
      readV3(HSKSWAP_POOLS[1].addr),
      readV3(HSKSWAP_POOLS[2].addr),
      readV2(HYPERINDEX_POOLS[0].addr),
    ]);

    // Derive cross-DEX HSK price
    // HyperIndex: 1 HSK = X WETH
    // HSKSwap:    1 WETH = Y USDT
    // Derived:    1 HSK = X * Y USDT
    const derivedHskPrice = hskEth.price * ethUsdt.price;
    const directHskPrice = hskUsdt.price;

    const gap = Math.abs(directHskPrice - derivedHskPrice) / Math.min(directHskPrice, derivedHskPrice) * 100;
    gapHistory.push(gap);
    if (gap > maxGap) maxGap = gap;

    // HyperIndex depth in USD
    const hiDepthUsd = hskEth.r1 * ethUsdt.price;

    // Console output
    const isAlert = gap > FEE_FLOOR;
    if (isAlert) alerts++;

    console.log(`\n[${time}] Poll #${polls}`);
    console.log("  Prices:");
    console.log(`    HSKSwap  HSK/USDT:  $${directHskPrice.toFixed(6)}`);
    console.log(`    HSKSwap  WETH/USDT: $${ethUsdt.price.toFixed(2)}`);
    console.log(`    HSKSwap  WBTC/USDT: $${btcUsdt.price.toFixed(2)}`);
    console.log(`    HyperIdx HSK/WETH:  ${hskEth.price.toFixed(8)} WETH  (depth: $${hiDepthUsd.toFixed(0)})`);
    console.log(`    HyperIdx HSK→USDT:  $${derivedHskPrice.toFixed(6)}  (derived via WETH)`);
    console.log(`  Gap: ${gap.toFixed(4)}%${isAlert ? "  >>> EXCEEDS FEE FLOOR" : ""}`);

    if (isAlert) {
      const cheaper = directHskPrice < derivedHskPrice ? "HSKSwap" : "HyperIndex";
      const dearer  = directHskPrice < derivedHskPrice ? "HyperIndex(via WETH)" : "HSKSwap";
      console.log(`  Direction: buy on ${cheaper}, sell on ${dearer}`);
      console.log(`  Caveats: 3-pool route = ~0.9% fees, HyperIndex depth only $${hiDepthUsd.toFixed(0)}`);
    }
  } catch (e) {
    console.log(`[${time}] RPC error: ${e.message?.slice(0, 80)}`);
  }
}

// ── Start ───────────────────────────────────────────────────────────────
console.log("╔═══════════════════════════════════════════════════════════╗");
console.log("║     LIVE PRICE MONITOR — HashKey Chain (read-only)       ║");
console.log("║     HSKSwap (V3) vs HyperIndex (V2)                     ║");
console.log("║     RPC: " + RPC_URL.padEnd(47) + "║");
console.log("║     Polling every " + (POLL_MS / 1000) + "s — Ctrl+C to stop" + " ".repeat(24) + "║");
console.log("╚═══════════════════════════════════════════════════════════╝");

// Initial poll immediately, then interval
poll();
setInterval(poll, POLL_MS);
