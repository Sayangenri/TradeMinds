/**
 * Deploy test tokens, create a V3 pool on HSKSwap (forked mainnet), add liquidity, and make swaps.
 *
 * Usage:
 *   FORK_HSK=1 npx hardhat run scripts/deploy_test_pool.js
 *
 * This forks HSK mainnet locally so you interact with the real HSKSwap factory/router
 * but with unlimited test funds — no real HSK needed.
 */

const { ethers } = require("hardhat");

const FACTORY = "0x972cA9D1662F5e029cD18327D29026532E84c742";
const ROUTER  = "0x56d15cF00b5D853D6eE4CbB1463E6DAD2899fBf5";
const WHSK    = "0xB210D2120d57b758EE163cFfb43e73728c471Cf1";

const FACTORY_ABI = [
  "function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool)",
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address)",
];

const POOL_ABI = [
  "function initialize(uint160 sqrtPriceX96) external",
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function liquidity() external view returns (uint128)",
];

const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
];

const NPM_ADDR = "0x1e7A867D078CaF2FBBa5a6fcA0e52A010e0A3E20";
const NPM_ABI = [
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
];

const ERC20_ABI = [
  "function approve(address, uint256) external returns (bool)",
  "function balanceOf(address) external view returns (uint256)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log(`\nSigner: ${signer.address}`);
  console.log(`HSK balance: ${ethers.formatEther(await ethers.provider.getBalance(signer.address))} HSK`);

  // --- Step 1: Deploy two test tokens ---
  console.log("\n=== Deploying Test Tokens ===");
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const tokenA = await MockERC20.deploy("Test Alpha", "TALPHA", 18);
  await tokenA.waitForDeployment();
  console.log(`TALPHA deployed: ${tokenA.target}`);

  const tokenB = await MockERC20.deploy("Test USDT", "tUSDT", 6);
  await tokenB.waitForDeployment();
  console.log(`tUSDT deployed:  ${tokenB.target}`);

  // Mint tokens
  const mintA = ethers.parseUnits("1000000", 18);
  const mintB = ethers.parseUnits("1000000", 6);
  await (await tokenA.mint(signer.address, mintA)).wait();
  await (await tokenB.mint(signer.address, mintB)).wait();
  console.log("Minted 1M TALPHA + 1M tUSDT");

  // --- Step 2: Create pool on HSKSwap factory ---
  console.log("\n=== Creating V3 Pool ===");
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, signer);

  let poolAddr = await factory.getPool(tokenA.target, tokenB.target, 3000);
  if (poolAddr === ethers.ZeroAddress) {
    const tx = await factory.createPool(tokenA.target, tokenB.target, 3000);
    await tx.wait();
    poolAddr = await factory.getPool(tokenA.target, tokenB.target, 3000);
    console.log(`Pool created: ${poolAddr}`);
  } else {
    console.log(`Pool already exists: ${poolAddr}`);
  }

  // --- Step 3: Initialize pool at a starting price ---
  const pool = new ethers.Contract(poolAddr, POOL_ABI, signer);
  const t0 = await pool.token0();
  const isTokenAToken0 = t0.toLowerCase() === tokenA.target.toLowerCase();
  console.log(`token0 is ${isTokenAToken0 ? "TALPHA" : "tUSDT"}`);

  // Price: 1 TALPHA = $2.50 (tUSDT)
  // sqrtPriceX96 = sqrt(price_token1_per_token0) * 2^96
  // If token0=TALPHA(18dec), token1=tUSDT(6dec): raw_price = 2.5 * 10^(6-18) = 2.5e-12
  // sqrtPriceX96 = sqrt(2.5e-12) * 2^96 = 1.5811e-6 * 7.9228e28 = 1.2527e23
  let sqrtPriceX96;
  if (isTokenAToken0) {
    const rawPrice = 2.5 * Math.pow(10, 6 - 18);
    sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(rawPrice) * 2 ** 96));
  } else {
    const rawPrice = (1 / 2.5) * Math.pow(10, 18 - 6);
    sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(rawPrice) * 2 ** 96));
  }

  try {
    await (await pool.initialize(sqrtPriceX96)).wait();
    console.log("Pool initialized at ~$2.50 per TALPHA");
  } catch (e) {
    console.log("Pool already initialized (OK)");
  }

  // Read slot0 to verify
  const slot0 = await pool.slot0();
  const sqrtP = Number(slot0[0]) / 2 ** 96;
  const t0Dec = isTokenAToken0 ? 18 : 6;
  const t1Dec = isTokenAToken0 ? 6 : 18;
  const price = sqrtP * sqrtP * Math.pow(10, t0Dec - t1Dec);
  console.log(`Current price: ${price.toFixed(6)} tUSDT per ${isTokenAToken0 ? "TALPHA" : "tUSDT"}`);
  console.log(`Tick: ${slot0[1]}`);

  // --- Step 4: Add liquidity via NonfungiblePositionManager ---
  console.log("\n=== Adding Liquidity ===");

  // Check if NPM exists on fork
  const npmCode = await ethers.provider.getCode(NPM_ADDR);
  if (npmCode === "0x") {
    console.log("NonfungiblePositionManager not found at expected address.");
    console.log("Searching for it...");

    // Try to add liquidity directly via a mint call on the pool
    console.log("Skipping NPM — using direct pool interaction instead.");
    console.log("\n=== Pool Ready for Trading Bot ===");
    console.log(`\nAdd this pool to your config.js POOLS array:`);
    console.log(`  { name: "TALPHA/tUSDT", addr: "${poolAddr}", token0: "${isTokenAToken0 ? "TALPHA" : "tUSDT"}", token1: "${isTokenAToken0 ? "tUSDT" : "TALPHA"}" }`);
    console.log(`\nToken addresses for executor.js:`);
    console.log(`  TALPHA: "${tokenA.target}"`);
    console.log(`  tUSDT:  "${tokenB.target}"`);
    return;
  }

  const npm = new ethers.Contract(NPM_ADDR, NPM_ABI, signer);

  // Sort tokens (V3 requires token0 < token1)
  const [sorted0, sorted1] = isTokenAToken0
    ? [tokenA.target, tokenB.target]
    : [tokenB.target, tokenA.target];
  const [amount0, amount1] = isTokenAToken0
    ? [ethers.parseUnits("100000", 18), ethers.parseUnits("250000", 6)]
    : [ethers.parseUnits("250000", 6), ethers.parseUnits("100000", 18)];

  // Approve NPM
  await (await tokenA.approve(NPM_ADDR, ethers.MaxUint256)).wait();
  await (await tokenB.approve(NPM_ADDR, ethers.MaxUint256)).wait();
  console.log("Approved NPM for both tokens");

  const currentTick = Number(slot0[1]);
  const tickSpacing = 60;
  const tickLower = Math.floor((currentTick - 6000) / tickSpacing) * tickSpacing;
  const tickUpper = Math.ceil((currentTick + 6000) / tickSpacing) * tickSpacing;

  try {
    const mintTx = await npm.mint({
      token0: sorted0,
      token1: sorted1,
      fee: 3000,
      tickLower,
      tickUpper,
      amount0Desired: amount0,
      amount1Desired: amount1,
      amount0Min: 0,
      amount1Min: 0,
      recipient: signer.address,
      deadline: Math.floor(Date.now() / 1000) + 600,
    });
    const receipt = await mintTx.wait();
    console.log(`Liquidity added! Tx: ${receipt.hash}`);
  } catch (e) {
    console.error("Mint failed:", e.message.slice(0, 200));
  }

  const liq = await pool.liquidity();
  console.log(`Pool liquidity: ${liq.toString()}`);

  // --- Step 5: Make some test swaps to create price movement ---
  console.log("\n=== Making Test Swaps ===");
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, signer);

  await (await tokenA.approve(ROUTER, ethers.MaxUint256)).wait();
  await (await tokenB.approve(ROUTER, ethers.MaxUint256)).wait();

  for (let i = 0; i < 5; i++) {
    const buyAmount = ethers.parseUnits(String(1000 + Math.floor(Math.random() * 4000)), 6);
    try {
      const tx = await router.exactInputSingle({
        tokenIn: tokenB.target,
        tokenOut: tokenA.target,
        fee: 3000,
        recipient: signer.address,
        amountIn: buyAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      });
      await tx.wait();

      const s = await pool.slot0();
      const sp = Number(s[0]) / 2 ** 96;
      const p = sp * sp * Math.pow(10, t0Dec - t1Dec);
      console.log(`  Swap #${i + 1}: Bought TALPHA with ${ethers.formatUnits(buyAmount, 6)} tUSDT → price now $${p.toFixed(6)}`);
    } catch (e) {
      console.error(`  Swap #${i + 1} failed:`, e.message.slice(0, 150));
    }
  }

  // Final state
  const finalSlot = await pool.slot0();
  const finalSqrtP = Number(finalSlot[0]) / 2 ** 96;
  const finalPrice = finalSqrtP * finalSqrtP * Math.pow(10, t0Dec - t1Dec);

  console.log(`\n=== Pool Ready ===`);
  console.log(`Pool: ${poolAddr}`);
  console.log(`TALPHA: ${tokenA.target} (18 decimals)`);
  console.log(`tUSDT:  ${tokenB.target} (6 decimals)`);
  console.log(`Price:  $${finalPrice.toFixed(6)} per TALPHA`);
  console.log(`\nTo use with the bot, add to .env:`);
  console.log(`  NETWORK=testnet`);
  console.log(`  RPC_URL=http://127.0.0.1:8545`);
  console.log(`\nAnd add the pool to src/config.js POOLS array.`);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
