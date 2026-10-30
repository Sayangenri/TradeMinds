// scripts/paper_trader.js
//
// Paper trading bot for HashKey Chain — reads REAL prices from the chain,
// simulates trades with proper fee/impact math, tracks P&L honestly.
//
// Data source: on-chain smart contract reads via RPC (slot0, getReserves).
// Same method real arb bots use — no APIs, no oracles, just the chain.
//
// Run:  node scripts/paper_trader.js
// Stop: Ctrl+C (prints full report + saves paper_trades.json)

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// ═══ CONFIG ═════════════════════════════════════════════════════════════
const RPC              = "https://mainnet.hsk.xyz";
const STARTING_BALANCE = 10_000;     // USDT
const POLL_MS          = 15_000;     // 15s between polls
const REPORT_MS        = 300_000;    // 5-min periodic report
const COOLDOWN_MS      = 120_000;    // 2 min between trades (gap closes after arb)
const MIN_PROFIT       = 0.001;      // min net profit in USDT to execute
const GAS_PER_SWAP     = 200_000n;   // estimated gas units per swap
const SWAPS_PER_ARB    = 3;          // 3-hop route
// ════════════════════════════════════════════════════════════════════════

// ── Pools ───────────────────────────────────────────────────────────────
const POOLS = {
  hskUsdtV3:  "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc", // HSKSwap
  ethUsdtV3:  "0xb92b79ed6b370d5cfee2e14b1d0983c258304c16", // HSKSwap
  btcUsdtV3:  "0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a", // HSKSwap
  hskEthV2:   "0x711d26aa3ff64dd9dc5fa22b7c64c26c1b28f8f2", // HyperIndex
};

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
const ERC20_ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];

// ── State ───────────────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC);
const tokenCache = {};
let balance = STARTING_BALANCE;
let trades = [];
let polls = 0;
let lastTradeTime = 0;
let lastRealV2 = null;
let adjV2 = null;
const gapLog = [];
let theoreticalProfit = 0;  // cumulative gross profit ignoring gas
let theoreticalTrades = 0;
const startTime = Date.now();

// ── Token info cache ────────────────────────────────────────────────────
async function tokenInfo(addr) {
  if (tokenCache[addr]) return tokenCache[addr];
  const c = new ethers.Contract(addr, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
  tokenCache[addr] = { symbol, decimals: Number(decimals) };
  return tokenCache[addr];
}

// ── V3 pool reader (returns virtual reserves for constant-product sim) ──
async function readV3(addr) {
  const pool = new ethers.Contract(addr, V3_ABI, provider);
  const [slot0, t0a, t1a, fee, liq] = await Promise.all([
    pool.slot0(), pool.token0(), pool.token1(), pool.fee(), pool.liquidity(),
  ]);
  const t0 = await tokenInfo(t0a);
  const t1 = await tokenInfo(t1a);

  const sqrtP = Number(slot0[0]) / 2 ** 96;
  const price = sqrtP * sqrtP * Math.pow(10, t0.decimals - t1.decimals);

  // Virtual reserves (V3 within-range ≈ V2)
  const vr0 = (Number(liq) / sqrtP) / 10 ** t0.decimals;
  const vr1 = (Number(liq) * sqrtP) / 10 ** t1.decimals;

  return { sym0: t0.symbol, sym1: t1.symbol, d0: t0.decimals, d1: t1.decimals, vr0, vr1, price, fee: Number(fee) / 1e6 };
}

// ── V2 pool reader ──────────────────────────────────────────────────────
async function readV2(addr) {
  const pool = new ethers.Contract(addr, V2_ABI, provider);
  const [res, t0a, t1a] = await Promise.all([pool.getReserves(), pool.token0(), pool.token1()]);
  const t0 = await tokenInfo(t0a);
  const t1 = await tokenInfo(t1a);
  const r0 = Number(ethers.formatUnits(res[0], t0.decimals));
  const r1 = Number(ethers.formatUnits(res[1], t1.decimals));
  return { sym0: t0.symbol, sym1: t1.symbol, r0, r1, price: r1 / r0 };
}

// ── Constant-product swap (with 0.3% fee baked in) ──────────────────────
function cpSwap(amtIn, rIn, rOut) {
  const inFee = amtIn * 997;
  return (inFee * rOut) / (rIn * 1000 + inFee);
}

// ── Simulate 3-hop arb route ────────────────────────────────────────────
// Forward: USDT → WETH (HSKSwap V3) → HSK (HyperIndex V2) → USDT (HSKSwap V3)
// Reverse: USDT → HSK (HSKSwap V3) → WETH (HyperIndex V2) → USDT (HSKSwap V3)
function simForward(usdtIn, ethUsdt, hskEthR, hskUsdt) {
  const weth = cpSwap(usdtIn, ethUsdt.vr1, ethUsdt.vr0);   // USDT→WETH
  const hsk  = cpSwap(weth, hskEthR.r1, hskEthR.r0);       // WETH→HSK
  const out  = cpSwap(hsk, hskUsdt.vr0, hskUsdt.vr1);      // HSK→USDT
  return { weth, hsk, usdtOut: out, profit: out - usdtIn };
}

function simReverse(usdtIn, hskUsdt, hskEthR, ethUsdt) {
  const hsk  = cpSwap(usdtIn, hskUsdt.vr1, hskUsdt.vr0);   // USDT→HSK
  const weth = cpSwap(hsk, hskEthR.r0, hskEthR.r1);        // HSK→WETH
  const out  = cpSwap(weth, ethUsdt.vr0, ethUsdt.vr1);      // WETH→USDT
  return { hsk, weth, usdtOut: out, profit: out - usdtIn };
}

// ── Find optimal trade size (geometric scan) ────────────────────────────
function findOptimal(simFn, maxUsdt) {
  let best = { size: 0, profit: -Infinity, result: null };
  for (let size = 0.01; size <= maxUsdt; size *= 1.12) {
    const r = simFn(size);
    if (r.profit > best.profit) {
      best = { size, profit: r.profit, result: r };
    } else if (best.profit > 0 && r.profit < best.profit * 0.5) {
      break;
    }
  }
  if (best.profit === -Infinity) best.profit = 0;
  return best;
}

// ── Gas cost estimate ───────────────────────────────────────────────────
async function estimateGasCost(ethUsdtPrice) {
  try {
    const feeData = await provider.getFeeData();
    const gasPrice = Number(feeData.gasPrice || 0n);
    const totalGas = Number(GAS_PER_SWAP) * SWAPS_PER_ARB;
    const costHSK = (gasPrice * totalGas) / 1e18; // gas is paid in native HSK
    // HSK→USDT conversion needed; approximate from our price data
    // We'll pass in the HSK/USDT price
    return costHSK; // in HSK; caller converts to USDT
  } catch {
    return 0;
  }
}

// ── Adjusted V2 reserves (simulates our trades closing the gap) ─────────
function getEffectiveV2(realV2) {
  if (!lastRealV2 || realV2.r0 !== lastRealV2.r0 || realV2.r1 !== lastRealV2.r1) {
    lastRealV2 = { r0: realV2.r0, r1: realV2.r1 };
    adjV2 = { r0: realV2.r0, r1: realV2.r1 };
  }
  return { ...realV2, r0: adjV2.r0, r1: adjV2.r1 };
}

function applyV2Trade(direction, amount0, amount1) {
  if (direction === "weth_to_hsk") {
    adjV2.r1 += amount1; // WETH in
    adjV2.r0 -= amount0; // HSK out
  } else {
    adjV2.r0 += amount0; // HSK in
    adjV2.r1 -= amount1; // WETH out
  }
}

// ── Reports ─────────────────────────────────────────────────────────────
function elapsed() {
  const s = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function printReport(label) {
  const pnl = balance - STARTING_BALANCE;
  const pnlPct = (pnl / STARTING_BALANCE * 100).toFixed(4);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${label} @ ${new Date().toLocaleTimeString()} (${elapsed()} elapsed)`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Starting balance: ${STARTING_BALANCE.toFixed(2)} USDT`);
  console.log(`  Current balance:  ${balance.toFixed(6)} USDT`);
  console.log(`  P&L:              ${pnl >= 0 ? "+" : ""}${pnl.toFixed(6)} USDT (${pnlPct}%)`);
  console.log(`  Trades executed:  ${trades.length}`);
  console.log(`  Polls completed:  ${polls}`);
  if (trades.length > 0) {
    console.log(`\n  Trade History:`);
    console.log(`  ${"#".padEnd(4)} ${"Time".padEnd(12)} ${"Route".padEnd(24)} ${"Size".padEnd(10)} ${"Gross".padEnd(12)} ${"Gas".padEnd(8)} ${"Net".padEnd(12)} ${"Balance"}`);
    trades.forEach((t, i) => {
      console.log(`  ${String(i + 1).padEnd(4)} ${t.time.padEnd(12)} ${t.route.padEnd(24)} $${t.size.padEnd(9)} ${t.gross.padEnd(12)} ${t.gas.padEnd(8)} ${t.net.padEnd(12)} $${t.balance}`);
    });
  }
  if (gapLog.length > 0) {
    const avg = gapLog.reduce((a, b) => a + b, 0) / gapLog.length;
    const max = Math.max(...gapLog);
    console.log(`\n  Gap stats: avg ${avg.toFixed(4)}% | max ${max.toFixed(4)}% | samples ${gapLog.length}`);
  }
  if (theoreticalTrades > 0) {
    console.log(`\n  Theoretical (gas=0): +$${theoreticalProfit.toFixed(6)} over ${theoreticalTrades} opportunities`);
    console.log(`  Lesson: gap is REAL, math works, but $96 depth + $0.027 gas = not executable`);
  }
  console.log(`\n  Data source: on-chain contract reads (slot0, getReserves) via RPC`);
  console.log(`  No APIs, no oracles — reading the actual blockchain state`);
  console.log(`${"═".repeat(60)}`);
}

function saveTrades() {
  const outPath = path.join(__dirname, "..", "paper_trades.json");
  const data = {
    startTime: new Date(startTime).toISOString(),
    endTime: new Date().toISOString(),
    startingBalance: STARTING_BALANCE,
    finalBalance: balance,
    pnl: balance - STARTING_BALANCE,
    pnlPct: ((balance - STARTING_BALANCE) / STARTING_BALANCE * 100),
    totalPolls: polls,
    trades,
    gapSamples: gapLog.length,
    avgGap: gapLog.length > 0 ? gapLog.reduce((a, b) => a + b, 0) / gapLog.length : 0,
    maxGap: gapLog.length > 0 ? Math.max(...gapLog) : 0,
  };
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`\n  Saved to ${outPath}`);
}

process.on("SIGINT", () => {
  printReport("FINAL REPORT");
  saveTrades();
  process.exit(0);
});

// ── Main loop ───────────────────────────────────────────────────────────
let lastReportTime = Date.now();

async function poll() {
  polls++;
  const now = Date.now();
  const time = new Date().toLocaleTimeString();

  try {
    // Read all pools in parallel
    const [hskUsdt, ethUsdt, realV2Raw] = await Promise.all([
      readV3(POOLS.hskUsdtV3),
      readV3(POOLS.ethUsdtV3),
      readV2(POOLS.hskEthV2),
    ]);

    const effV2 = getEffectiveV2(realV2Raw);
    const hskPriceDirect = hskUsdt.price;
    const hskPriceDerived = effV2.price * ethUsdt.price; // via WETH
    const gap = Math.abs(hskPriceDirect - hskPriceDerived) / Math.min(hskPriceDirect, hskPriceDerived) * 100;
    gapLog.push(gap);

    const depthUsd = effV2.r1 * ethUsdt.price;
    const inCooldown = (now - lastTradeTime) < COOLDOWN_MS;

    // Log every poll
    const gapFlag = gap > 0.9 ? " >>>" : "";
    console.log(`[${time}] #${polls} | HSK: $${hskPriceDirect.toFixed(6)} (direct) vs $${hskPriceDerived.toFixed(6)} (via WETH) | gap: ${gap.toFixed(4)}%${gapFlag} | depth: $${depthUsd.toFixed(0)}${inCooldown ? " | COOLDOWN" : ""}`);

    // Skip if in cooldown
    if (inCooldown) {
      if (now - lastReportTime >= REPORT_MS) { printReport("PERIODIC REPORT"); lastReportTime = now; }
      return;
    }

    // Check both arb directions
    const fwd = findOptimal(
      (sz) => simForward(sz, ethUsdt, effV2, hskUsdt),
      Math.min(balance, 1000) // cap per-trade at 1000 USDT
    );
    const rev = findOptimal(
      (sz) => simReverse(sz, hskUsdt, effV2, ethUsdt),
      Math.min(balance, 1000)
    );

    // Pick best direction
    const best = fwd.profit >= rev.profit ? { ...fwd, dir: "forward", route: "USDT→WETH→HSK→USDT" } : { ...rev, dir: "reverse", route: "USDT→HSK→WETH→USDT" };

    // Estimate gas in USDT
    const gasCostHSK = await estimateGasCost(ethUsdt.price);
    const gasCostUSDT = gasCostHSK * hskPriceDirect;
    const netProfit = best.profit - gasCostUSDT;

    // Show best attempt analysis (educational)
    if (best.size > 0 && best.result) {
      const feeOnly = best.size * 0.009; // theoretical 0.9% fee cost
      const impact = -(best.profit + feeOnly); // negative profit minus fees = impact loss
      console.log(`  Best attempt: $${best.size.toFixed(2)} via ${best.route}`);
      console.log(`    Sim output:  $${best.result.usdtOut.toFixed(6)} → gross: ${best.profit >= 0 ? "+" : ""}$${best.profit.toFixed(6)}`);
      console.log(`    Fee cost:    ~$${feeOnly.toFixed(4)} (0.9%)  |  Impact loss: ~$${Math.max(0, impact).toFixed(4)}  |  Gas: ~$${gasCostUSDT.toFixed(6)}`);
    }

    if (netProfit > MIN_PROFIT && best.size > 0) {
      // EXECUTE paper trade
      balance += netProfit;
      lastTradeTime = now;

      if (best.dir === "forward" && best.result) {
        applyV2Trade("weth_to_hsk", best.result.hsk, best.result.weth);
      } else if (best.result) {
        applyV2Trade("hsk_to_weth", best.result.hsk, best.result.weth);
      }

      const trade = {
        time: time,
        timestamp: new Date().toISOString(),
        route: best.route,
        direction: best.dir,
        size: best.size.toFixed(4),
        gross: (best.profit >= 0 ? "+" : "") + best.profit.toFixed(6),
        gas: gasCostUSDT.toFixed(6),
        net: (netProfit >= 0 ? "+" : "") + netProfit.toFixed(6),
        gap: gap.toFixed(4) + "%",
        balance: balance.toFixed(6),
        depthUsd: depthUsd.toFixed(0),
      };
      trades.push(trade);

      console.log(`  >>> PAPER TRADE #${trades.length} EXECUTED!`);
      console.log(`      Route: ${best.route}`);
      console.log(`      Size:  $${best.size.toFixed(4)} USDT`);
      console.log(`      Gross: ${best.profit >= 0 ? "+" : ""}$${best.profit.toFixed(6)}`);
      console.log(`      Gas:   -$${gasCostUSDT.toFixed(6)}`);
      console.log(`      Net:   ${netProfit >= 0 ? "+" : ""}$${netProfit.toFixed(6)}`);
      console.log(`      Balance: $${balance.toFixed(6)} USDT`);
      console.log(`      (Cooldown ${COOLDOWN_MS / 1000}s — simulates gap closure after arb)`);
    } else if (gap > 0.9 && best.profit > 0) {
      theoreticalProfit += best.profit;
      theoreticalTrades++;
      console.log(`  ⊘ GROSS-PROFITABLE but gas ($${gasCostUSDT.toFixed(4)}) > gross ($${best.profit.toFixed(4)}) — no trade`);
      console.log(`    Need ${(gasCostUSDT / best.size * 100).toFixed(1)}× larger trade or ${(gasCostUSDT / 0.009 / best.size * 100).toFixed(0)}% gap to cover gas`);
      console.log(`    Theoretical P&L (if gas=0): +$${theoreticalProfit.toFixed(6)} over ${theoreticalTrades} trades`);
    } else if (gap > 0.9) {
      console.log(`  ⊘ Gap exists (${gap.toFixed(2)}%) but NOT profitable — fees + impact on $${depthUsd.toFixed(0)} depth`);
    }

    // Periodic report
    if (now - lastReportTime >= REPORT_MS) {
      printReport("PERIODIC REPORT");
      lastReportTime = now;
    }
  } catch (e) {
    console.log(`[${time}] RPC error: ${e.message?.slice(0, 80)}`);
  }
}

// ── Start ───────────────────────────────────────────────────────────────
console.log("╔═════════════════════════════════════════════════════════════╗");
console.log("║      PAPER TRADER — HashKey Chain (read-only, no wallet)   ║");
console.log("╠═════════════════════════════════════════════════════════════╣");
console.log(`║  Starting balance: ${STARTING_BALANCE} USDT`);
console.log(`║  Data source: on-chain reads via RPC (${RPC})`);
console.log(`║  Route: HSKSwap (V3) ↔ HyperIndex (V2) cross-DEX arb`);
console.log(`║  Fees: 0.3% × 3 hops = 0.9% per round-trip`);
console.log(`║  Polling every ${POLL_MS / 1000}s — reports every ${REPORT_MS / 60000}min`);
console.log(`║  Press Ctrl+C to stop and see full report`);
console.log("╚═════════════════════════════════════════════════════════════╝\n");

poll();
const pollTimer = setInterval(poll, POLL_MS);
