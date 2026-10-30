// Deploy two V2-style mock pools for the SAME pair at DIFFERENT prices,
// then detect the arbitrage by reading getReserves() off-chain — exactly
// like you'd read a real pool over RPC — and run the profitability filter.
//
// Run with:  npx hardhat run scripts/deploy_and_detect.js
// (uses the in-process Hardhat network, so no separate node required)

const hre = require("hardhat");
const { ethers } = hre;

// ---- helpers -------------------------------------------------------------

const DEC_TOKEN = 18n; // WETH-like
const DEC_USDC = 6n;   // USDC-like

// scale a human number to raw token units
function units(amount, decimals) {
  return ethers.parseUnits(amount.toString(), Number(decimals));
}

// spot price of TOKEN in USDC from raw reserves, decimals handled
function spotPrice(reserveToken, reserveUsdc) {
  const rt = Number(ethers.formatUnits(reserveToken, Number(DEC_TOKEN)));
  const ru = Number(ethers.formatUnits(reserveUsdc, Number(DEC_USDC)));
  return ru / rt;
}

// off-chain mirror of the pool's getAmountOut (0.3% fee), in human units
function getAmountOut(amountIn, reserveIn, reserveOut) {
  const amountInWithFee = amountIn * 997;
  return (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);
}

// ---- main ----------------------------------------------------------------

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address, "\n");

  // 1. Deploy two tokens: TOKEN (18 dec) and USDC (6 dec)
  const ERC20 = await ethers.getContractFactory("MockERC20");
  const token = await ERC20.deploy("Mock Token", "TKN", Number(DEC_TOKEN));
  const usdc = await ERC20.deploy("Mock USDC", "USDC", Number(DEC_USDC));
  await token.waitForDeployment();
  await usdc.waitForDeployment();

  // token0/token1 ordering: Uniswap sorts by address. We keep it simple and
  // just pass (token, usdc) — our detector reads which is which from the pair.
  const tokenAddr = await token.getAddress();
  const usdcAddr = await usdc.getAddress();

  // 2. Deploy two pairs
  const Pair = await ethers.getContractFactory("MockV2Pair");
  const poolA = await Pair.deploy(tokenAddr, usdcAddr);
  const poolB = await Pair.deploy(tokenAddr, usdcAddr);
  await poolA.waitForDeployment();
  await poolB.waitForDeployment();

  // 3. Seed liquidity so the two pools price TOKEN differently.
  //    Pool A: 1000 TKN + 2,000,000 USDC  -> 2000 USDC/TKN
  //    Pool B: 1000 TKN + 2,060,000 USDC  -> 2060 USDC/TKN  (3% higher)
  async function seed(pool, tknAmt, usdcAmt) {
    const poolAddr = await pool.getAddress();
    await (await token.mint(deployer.address, units(tknAmt, DEC_TOKEN))).wait();
    await (await usdc.mint(deployer.address, units(usdcAmt, DEC_USDC))).wait();
    await (await token.approve(poolAddr, units(tknAmt, DEC_TOKEN))).wait();
    await (await usdc.approve(poolAddr, units(usdcAmt, DEC_USDC))).wait();
    await (await pool.addLiquidity(units(tknAmt, DEC_TOKEN), units(usdcAmt, DEC_USDC))).wait();
  }
  await seed(poolA, 1000, 2000000);
  await seed(poolB, 1000, 2060000);

  console.log("Pools deployed and seeded.");
  console.log("Pool A:", await poolA.getAddress());
  console.log("Pool B:", await poolB.getAddress(), "\n");

  // 4. DETECT — read reserves off-chain, just like reading a live pool via RPC.
  //    getReserves() returns (reserve0, reserve1). token0 == TOKEN here.
  const [a0, a1] = await poolA.getReserves();
  const [b0, b1] = await poolB.getReserves();

  const priceA = spotPrice(a0, a1); // a0 = TOKEN reserve, a1 = USDC reserve
  const priceB = spotPrice(b0, b1);
  console.log(`Pool A spot: ${priceA.toFixed(4)} USDC/TKN`);
  console.log(`Pool B spot: ${priceB.toFixed(4)} USDC/TKN`);
  const gapPct = (Math.abs(priceA - priceB) / Math.min(priceA, priceB)) * 100;
  console.log(`Raw gap:     ${gapPct.toFixed(3)}%\n`);

  // 5. PROFITABILITY FILTER — buy on the cheaper pool, sell on the dearer one.
  const usdcToSpend = 20000; // try changing this!
  const buyIsA = priceA < priceB;
  const [buyPool, sellPool] = buyIsA ? [poolA, poolB] : [poolB, poolA];
  const [bTok, bUsdc] = buyIsA ? [a0, a1] : [b0, b1];
  const [sTok, sUsdc] = buyIsA ? [b0, b1] : [a0, a1];

  const buyTokRes = Number(ethers.formatUnits(bTok, Number(DEC_TOKEN)));
  const buyUsdcRes = Number(ethers.formatUnits(bUsdc, Number(DEC_USDC)));
  const sellTokRes = Number(ethers.formatUnits(sTok, Number(DEC_TOKEN)));
  const sellUsdcRes = Number(ethers.formatUnits(sUsdc, Number(DEC_USDC)));

  const tokenBought = getAmountOut(usdcToSpend, buyUsdcRes, buyTokRes);
  const usdcBack = getAmountOut(tokenBought, sellTokRes, sellUsdcRes);
  const gross = usdcBack - usdcToSpend;

  console.log(`Buy  on pool ${buyIsA ? "A" : "B"}: ${usdcToSpend} USDC -> ${tokenBought.toFixed(6)} TKN`);
  console.log(`Sell on pool ${buyIsA ? "B" : "A"}: ${tokenBought.toFixed(6)} TKN -> ${usdcBack.toFixed(2)} USDC`);
  console.log(`\nPredicted gross P&L: ${gross.toFixed(2)} USDC`);

  // 6. PROVE IT ON-CHAIN — actually execute both swaps and compare to prediction.
  //    This is the payoff: your off-chain math must match the real contract.
  await (await usdc.mint(deployer.address, units(usdcToSpend, DEC_USDC))).wait();
  await (await usdc.approve(await buyPool.getAddress(), units(usdcToSpend, DEC_USDC))).wait();

  const tokBefore = await token.balanceOf(deployer.address);
  await (await buyPool.swapExactIn(usdcAddr, units(usdcToSpend, DEC_USDC))).wait();
  const tokAfter = await token.balanceOf(deployer.address);
  const tokReceived = tokAfter - tokBefore;

  await (await token.approve(await sellPool.getAddress(), tokReceived)).wait();
  const usdcBefore = await usdc.balanceOf(deployer.address);
  await (await sellPool.swapExactIn(tokenAddr, tokReceived)).wait();
  const usdcAfter = await usdc.balanceOf(deployer.address);
  const usdcReceived = Number(ethers.formatUnits(usdcAfter - usdcBefore, Number(DEC_USDC)));

  const realGross = usdcReceived - usdcToSpend;
  console.log(`Actual on-chain gross P&L: ${realGross.toFixed(2)} USDC`);
  console.log(realGross > 0 ? "PROFITABLE on-chain ✅" : "NOT profitable ❌");
  console.log("\n(Off-chain prediction vs on-chain reality should match closely —");
  console.log(" small differences come from reserves shifting after the first swap.)");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
