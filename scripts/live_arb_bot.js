// scripts/live_arb_bot.js
//
// Deploys 4 V2 pools at different prices, simulates random market trades
// that shift prices each cycle, then auto-detects and executes arbitrage.
// All on the in-process Hardhat network — pure learning sandbox.
//
// Run:  npx hardhat run scripts/live_arb_bot.js
// Stop: Ctrl+C (prints final stats)

const hre = require("hardhat");
const { ethers } = hre;

// ═══ CONFIG — tweak these to experiment ═════════════════════════════════
const POOLS = [
  { name: "Pool-A", tkn: 1000,  usdcPerTkn: 2000 },  // baseline
  { name: "Pool-B", tkn: 1000,  usdcPerTkn: 2030 },  // slightly higher
  { name: "Pool-C", tkn: 800,   usdcPerTkn: 1985 },   // lower, shallower
  { name: "Pool-D", tkn: 1200,  usdcPerTkn: 2050 },   // higher, deeper
];
const ARB_SIZE_USDC   = 5000;    // USDC per arb trade
const MIN_PROFIT_USDC = 0.50;    // min profit to bother executing
const CYCLE_MS        = 2500;    // ms between cycles
const NOISE_PER_CYCLE = 2;       // random market trades per cycle
const NOISE_MIN_USDC  = 500;     // smallest noise trade (USDC equiv)
const NOISE_MAX_USDC  = 20000;   // largest noise trade — big ones create arb!
// ════════════════════════════════════════════════════════════════════════

const DEC_TKN  = 18n;
const DEC_USDC = 6n;

const toRaw = (n, dec) => ethers.parseUnits(n.toString(), Number(dec));
const toNum = (raw, dec) => Number(ethers.formatUnits(raw, Number(dec)));
const spot  = (rTkn, rUsdc) => toNum(rUsdc, DEC_USDC) / toNum(rTkn, DEC_TKN);
const rand  = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;

function amtOut(amtIn, rIn, rOut) {
  const fee = amtIn * 997n;
  return (fee * rOut) / (rIn * 1000n + fee);
}

// ── Stats ───────────────────────────────────────────────────────────────
let totalProfit = 0, trades = 0, wins = 0, losses = 0, skips = 0;
const tradeLog = [];

function printFinalStats() {
  console.log("\n\n╔═══════════════════════════════════════════════════════╗");
  console.log("║                    FINAL REPORT                       ║");
  console.log("╠═══════════════════════════════════════════════════════╣");
  console.log(`║  Total trades executed: ${trades}`);
  console.log(`║  Wins: ${wins}   Losses: ${losses}   Skipped: ${skips}`);
  console.log(`║  Win rate: ${trades > 0 ? ((wins / trades) * 100).toFixed(1) : "—"}%`);
  console.log(`║  Total P&L: ${totalProfit >= 0 ? "+" : ""}${totalProfit.toFixed(2)} USDC`);
  console.log(`║  Avg profit/trade: ${trades > 0 ? (totalProfit / trades).toFixed(2) : "—"} USDC`);
  console.log("╚═══════════════════════════════════════════════════════╝");
  if (tradeLog.length > 0) {
    console.log("\nTrade history:");
    tradeLog.forEach((t, i) => {
      const sign = t.pnl >= 0 ? "+" : "";
      console.log(`  ${i + 1}. ${t.buy} -> ${t.sell} | gap ${t.gap}% | ${sign}${t.pnl} USDC ${t.pnl > 0 ? "✅" : "❌"}`);
    });
  }
}

process.on("SIGINT", () => {
  printFinalStats();
  process.exit(0);
});

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const trader   = signers[1];  // noise / market maker
  const bot      = signers[2];  // our arb bot

  // Deploy tokens
  const ERC20 = await ethers.getContractFactory("MockERC20");
  const tkn  = await ERC20.deploy("Token", "TKN", 18);
  const usdc = await ERC20.deploy("USDC", "USDC", 6);
  await tkn.waitForDeployment();
  await usdc.waitForDeployment();
  const tknAddr  = await tkn.getAddress();
  const usdcAddr = await usdc.getAddress();

  // Deploy & seed pools
  const Pair = await ethers.getContractFactory("MockV2Pair");
  const pools = [];

  for (const cfg of POOLS) {
    const pool = await Pair.deploy(tknAddr, usdcAddr);
    await pool.waitForDeployment();
    const addr = await pool.getAddress();
    const usdcLiq = cfg.tkn * cfg.usdcPerTkn;

    await (await tkn.mint(deployer.address, toRaw(cfg.tkn, DEC_TKN))).wait();
    await (await usdc.mint(deployer.address, toRaw(usdcLiq, DEC_USDC))).wait();
    await (await tkn.approve(addr, toRaw(cfg.tkn, DEC_TKN))).wait();
    await (await usdc.approve(addr, toRaw(usdcLiq, DEC_USDC))).wait();
    await (await pool.addLiquidity(toRaw(cfg.tkn, DEC_TKN), toRaw(usdcLiq, DEC_USDC))).wait();

    pools.push({ name: cfg.name, pool, addr });
    console.log(`  ${cfg.name} deployed — ${cfg.tkn} TKN + ${usdcLiq.toLocaleString()} USDC (price: ${cfg.usdcPerTkn})`);
  }

  // Fund noise trader & bot with plenty of both tokens
  for (const signer of [trader, bot]) {
    await (await usdc.mint(signer.address, toRaw(50_000_000, DEC_USDC))).wait();
    await (await tkn.mint(signer.address, toRaw(100_000, DEC_TKN))).wait();
    for (const p of pools) {
      await (await usdc.connect(signer).approve(p.addr, ethers.MaxUint256)).wait();
      await (await tkn.connect(signer).approve(p.addr, ethers.MaxUint256)).wait();
    }
  }

  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║        LIVE ARB BOT — Learning Sandbox                   ║");
  console.log("║  " + pools.map(p => p.name).join("  |  ").padEnd(55) + "║");
  console.log("║  Arb size: " + `${ARB_SIZE_USDC} USDC   Min profit: ${MIN_PROFIT_USDC} USDC`.padEnd(45) + "║");
  console.log("║  Press Ctrl+C to stop and see final stats                ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");

  let cycle = 0;

  // ── Loop ──────────────────────────────────────────────────────────────
  while (true) {
    cycle++;
    console.log(`\n━━━ Cycle ${cycle} ${"━".repeat(50)}`);

    // 1. NOISE — random trades shift pool prices (simulates other traders)
    for (let n = 0; n < NOISE_PER_CYCLE; n++) {
      const p = pools[rand(0, pools.length - 1)];
      const buyTkn = Math.random() > 0.5;
      const sizeUsdc = rand(NOISE_MIN_USDC, NOISE_MAX_USDC);

      try {
        if (buyTkn) {
          await (await p.pool.connect(trader).swapExactIn(usdcAddr, toRaw(sizeUsdc, DEC_USDC))).wait();
          console.log(`  [Market] ${p.name}: bought TKN with ${sizeUsdc.toLocaleString()} USDC`);
        } else {
          const tknAmt = (sizeUsdc / 2000).toFixed(6);
          await (await p.pool.connect(trader).swapExactIn(tknAddr, toRaw(tknAmt, DEC_TKN))).wait();
          console.log(`  [Market] ${p.name}: sold ${tknAmt} TKN for USDC`);
        }
      } catch {
        // reserve too low for this trade, skip silently
      }
    }

    // 2. READ all pool prices
    const states = [];
    for (const p of pools) {
      const [r0, r1] = await p.pool.getReserves();
      states.push({ ...p, r0, r1, price: spot(r0, r1) });
    }

    const prices = states.map(s => s.price);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const spread = ((maxP - minP) / minP * 100).toFixed(3);

    console.log(`\n  Prices (spread: ${spread}%):`);
    for (const s of states) {
      const depth = toNum(s.r1, DEC_USDC);
      const bar = "█".repeat(Math.min(30, Math.round(depth / 80000)));
      console.log(`    ${s.name}: ${s.price.toFixed(2).padStart(9)} USDC/TKN  ${bar} ${(depth / 1000).toFixed(0)}k`);
    }

    // 3. DETECT — check all pool pairs, both directions, find best arb
    let best = null;
    for (let i = 0; i < states.length; i++) {
      for (let j = i + 1; j < states.length; j++) {
        for (const [buy, sell] of [[states[i], states[j]], [states[j], states[i]]]) {
          if (buy.price >= sell.price) continue;

          // Simulate: USDC → TKN on cheap pool, TKN → USDC on expensive pool
          const uIn   = toRaw(ARB_SIZE_USDC, DEC_USDC);
          const tOut  = amtOut(uIn, buy.r1, buy.r0);     // buy TKN
          const uBack = amtOut(tOut, sell.r0, sell.r1);   // sell TKN
          const profit = toNum(uBack, DEC_USDC) - ARB_SIZE_USDC;

          if (profit > MIN_PROFIT_USDC && (!best || profit > best.profit)) {
            best = {
              buy, sell, profit,
              gap: ((sell.price - buy.price) / buy.price * 100).toFixed(3),
              uIn, tOut,
            };
          }
        }
      }
    }

    // 4. EXECUTE or skip
    if (best) {
      console.log(`\n  >>> ARB DETECTED!`);
      console.log(`      Buy  ${best.buy.name} @ ${best.buy.price.toFixed(2)}`);
      console.log(`      Sell ${best.sell.name} @ ${best.sell.price.toFixed(2)}`);
      console.log(`      Gap: ${best.gap}%  |  Est. profit: +${best.profit.toFixed(2)} USDC`);

      try {
        // Track balances precisely
        const usdcBefore = await usdc.balanceOf(bot.address);
        const tknBefore  = await tkn.balanceOf(bot.address);

        // Leg 1: buy TKN on cheap pool
        await (await best.buy.pool.connect(bot).swapExactIn(usdcAddr, best.uIn)).wait();
        const tknAfter = await tkn.balanceOf(bot.address);
        const tknReceived = tknAfter - tknBefore;

        // Leg 2: sell received TKN on expensive pool
        await (await best.sell.pool.connect(bot).swapExactIn(tknAddr, tknReceived)).wait();
        const usdcAfter = await usdc.balanceOf(bot.address);

        const actual = toNum(usdcAfter - usdcBefore, DEC_USDC);
        trades++;
        if (actual > 0) wins++; else losses++;
        totalProfit += actual;

        const icon = actual > 0 ? "✅" : "❌";
        console.log(`      Executed! Actual P&L: ${actual >= 0 ? "+" : ""}${actual.toFixed(2)} USDC  ${icon}`);
        if (Math.abs(actual - best.profit) > 0.01) {
          console.log(`      (predicted ${best.profit.toFixed(2)}, got ${actual.toFixed(2)} — diff from reserves shifting between read & swap)`);
        }

        tradeLog.push({
          cycle,
          buy: best.buy.name,
          sell: best.sell.name,
          gap: best.gap,
          predicted: best.profit.toFixed(2),
          pnl: actual.toFixed(2),
        });
      } catch (e) {
        console.log(`      Execution FAILED: ${e.message?.slice(0, 80)}`);
      }
    } else {
      skips++;
      console.log(`\n  [Bot] No profitable arb (gaps don't cover the 0.6% fee floor)`);
    }

    // 5. Running stats
    const wr = trades > 0 ? ((wins / trades) * 100).toFixed(0) + "%" : "—";
    const pnlStr = (totalProfit >= 0 ? "+" : "") + totalProfit.toFixed(2);
    console.log(`\n  Trades: ${trades}  |  Wins: ${wins}  |  Win rate: ${wr}  |  Total P&L: ${pnlStr} USDC`);

    await new Promise(r => setTimeout(r, CYCLE_MS));
  }
}

main().catch(console.error);
