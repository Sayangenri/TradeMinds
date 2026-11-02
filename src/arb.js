const { ethers } = require("ethers");
const config = require("./config");

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
];

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

function getProvider() {
  return new ethers.JsonRpcProvider(config.RPC_URL);
}

async function getPoolPrice(poolAddr) {
  const provider = getProvider();
  const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const [slot0, t0, t1, fee, liq] = await Promise.all([
    pool.slot0(), pool.token0(), pool.token1(), pool.fee(), pool.liquidity(),
  ]);

  const t0c = new ethers.Contract(t0, ERC20_ABI, provider);
  const t1c = new ethers.Contract(t1, ERC20_ABI, provider);
  const [d0, d1, s0, s1] = await Promise.all([
    t0c.decimals(), t1c.decimals(), t0c.symbol(), t1c.symbol(),
  ]);

  const sqrtP = Number(slot0[0]) / 2 ** 96;
  const price = sqrtP * sqrtP * Math.pow(10, Number(d0) - Number(d1));

  return {
    addr: poolAddr,
    token0: { addr: t0, decimals: Number(d0), symbol: s0 },
    token1: { addr: t1, decimals: Number(d1), symbol: s1 },
    price,
    fee: Number(fee),
    liquidity: Number(liq),
  };
}

function findTriangularRoutes(pools) {
  const routes = [];
  const n = pools.length;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;

        const p1 = pools[i];
        const p2 = pools[j];
        const p3 = pools[k];

        const t0s = [p1.token0.addr.toLowerCase(), p1.token1.addr.toLowerCase()];
        const t1s = [p2.token0.addr.toLowerCase(), p2.token1.addr.toLowerCase()];
        const t2s = [p3.token0.addr.toLowerCase(), p3.token1.addr.toLowerCase()];

        for (const startToken of t0s) {
          const endP1 = t0s.find(t => t !== startToken);
          if (!endP1) continue;

          if (!t1s.includes(endP1)) continue;
          const endP2 = t1s.find(t => t !== endP1);
          if (!endP2) continue;

          if (!t2s.includes(endP2)) continue;
          const endP3 = t2s.find(t => t !== endP2);
          if (!endP3) continue;

          if (endP3 === startToken) {
            routes.push({
              pools: [p1, p2, p3],
              path: [startToken, endP1, endP2, startToken],
            });
          }
        }
      }
    }
  }

  return routes;
}

function getSwapOutput(pool, tokenIn, amountIn) {
  const isToken0In = pool.token0.addr.toLowerCase() === tokenIn.toLowerCase();
  const feeMultiplier = 1 - pool.fee / 1_000_000;

  let amountOut;
  if (isToken0In) {
    amountOut = amountIn * pool.price * feeMultiplier;
  } else {
    amountOut = (amountIn / pool.price) * feeMultiplier;
  }
  return amountOut;
}

function calculateArbProfit(route, startAmount) {
  let amount = startAmount;
  const steps = [];

  for (let i = 0; i < route.pools.length; i++) {
    const pool = route.pools[i];
    const tokenIn = route.path[i];
    const tokenOut = route.path[i + 1];
    const amountOut = getSwapOutput(pool, tokenIn, amount);

    const inSymbol = pool.token0.addr.toLowerCase() === tokenIn.toLowerCase()
      ? pool.token0.symbol : pool.token1.symbol;
    const outSymbol = pool.token0.addr.toLowerCase() === tokenOut.toLowerCase()
      ? pool.token0.symbol : pool.token1.symbol;

    steps.push({
      pool: `${pool.token0.symbol}/${pool.token1.symbol}`,
      poolAddr: pool.addr,
      in: `${amount.toFixed(4)} ${inSymbol}`,
      out: `${amountOut.toFixed(4)} ${outSymbol}`,
      inToken: inSymbol,
      outToken: outSymbol,
    });

    amount = amountOut;
  }

  const profit = amount - startAmount;
  const profitPct = (profit / startAmount) * 100;

  return { startAmount, endAmount: amount, profit, profitPct, steps };
}

async function scanArbitrage(poolAddresses, startAmount = 1000) {
  console.log(`\n  Scanning ${poolAddresses.length} pools for triangular arbitrage...`);

  const pools = [];
  for (const addr of poolAddresses) {
    try {
      pools.push(await getPoolPrice(addr));
    } catch (e) {
      console.error(`  Error reading pool ${addr}: ${e.message}`);
    }
  }

  const routes = findTriangularRoutes(pools);
  console.log(`  Found ${routes.length} possible triangular routes`);

  const opportunities = [];
  for (const route of routes) {
    const result = calculateArbProfit(route, startAmount);
    if (result.profitPct > 0) {
      opportunities.push(result);
    }
  }

  opportunities.sort((a, b) => b.profitPct - a.profitPct);

  if (opportunities.length === 0) {
    console.log("  No profitable arbitrage found\n");
  } else {
    console.log(`\n  ** ${opportunities.length} ARBITRAGE OPPORTUNITIES **\n`);
    for (const opp of opportunities.slice(0, 5)) {
      console.log(`  Profit: $${opp.profit.toFixed(4)} (${opp.profitPct.toFixed(3)}%) on $${opp.startAmount}`);
      for (const step of opp.steps) {
        console.log(`    ${step.pool}: ${step.in} → ${step.out}`);
      }
      console.log();
    }
  }

  return opportunities;
}

module.exports = { scanArbitrage, getPoolPrice, findTriangularRoutes, calculateArbProfit };
