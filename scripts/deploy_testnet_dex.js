/**
 * Deploy a full Uniswap V3 DEX + test tokens + pools on HSK testnet.
 *
 * Usage:
 *   npx hardhat run scripts/deploy_testnet_dex.js --network hsk_testnet
 *
 * Prerequisites:
 *   - PRIVATE_KEY in .env with testnet HSK for gas
 *
 * What it deploys:
 *   1. WETH9 (wrapped HSK)
 *   2. UniswapV3Factory
 *   3. SwapRouter
 *   4. NonfungiblePositionManager
 *   5. Three test tokens: TALPHA (18 dec), TBETA (18 dec), tUSDT (6 dec)
 *   6. Three pools with liquidity:
 *      - TALPHA/tUSDT @ $2.50
 *      - TBETA/tUSDT  @ $1.00
 *      - TALPHA/TBETA  @ $2.50
 *   7. Intentional mispricings for arbitrage detection
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const V3Factory = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const V3Router = require("@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json");
const V3NPM = require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");

function encodeSqrtPrice(price, dec0, dec1) {
  const rawPrice = price * Math.pow(10, dec1 - dec0);
  return BigInt(Math.floor(Math.sqrt(rawPrice) * 2 ** 96));
}

async function deployContract(name, abi, bytecode, signer, args = []) {
  console.log(`  Deploying ${name}...`);
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  console.log(`  ${name}: ${contract.target}`);
  return contract;
}

async function main() {
  const [signer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(signer.address);
  const network = await ethers.provider.getNetwork();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  DEX DEPLOYMENT — HSK ${network.chainId === 133n ? "Testnet" : "Chain " + network.chainId}`);
  console.log(`  Deployer: ${signer.address}`);
  console.log(`  Balance:  ${ethers.formatEther(balance)} HSK`);
  console.log(`${"=".repeat(60)}\n`);

  if (balance === 0n) {
    console.error("  ERROR: No HSK balance. Get testnet HSK from the faucet first.");
    process.exit(1);
  }

  // --- Step 1: Deploy infrastructure ---
  console.log("=== Step 1: Deploy DEX Infrastructure ===\n");

  const weth9 = await deployContract("WETH9",
    (await ethers.getContractFactory("WETH9")).interface.formatJson(),
    (await ethers.getContractFactory("WETH9")).bytecode,
    signer
  );

  const factory = await deployContract("UniswapV3Factory", V3Factory.abi, V3Factory.bytecode, signer);

  const router = await deployContract("SwapRouter", V3Router.abi, V3Router.bytecode, signer, [
    factory.target, weth9.target,
  ]);

  const npm = await deployContract("NonfungiblePositionManager", V3NPM.abi, V3NPM.bytecode, signer, [
    factory.target, weth9.target, signer.address,
  ]);

  // --- Step 2: Deploy test tokens ---
  console.log("\n=== Step 2: Deploy Test Tokens ===\n");

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const talpha = await MockERC20.deploy("Test Alpha", "TALPHA", 18);
  await talpha.waitForDeployment();
  console.log(`  TALPHA: ${talpha.target} (18 decimals)`);

  const tbeta = await MockERC20.deploy("Test Beta", "TBETA", 18);
  await tbeta.waitForDeployment();
  console.log(`  TBETA:  ${tbeta.target} (18 decimals)`);

  const tusdt = await MockERC20.deploy("Test USDT", "tUSDT", 6);
  await tusdt.waitForDeployment();
  console.log(`  tUSDT:  ${tusdt.target} (6 decimals)`);

  // Mint tokens
  const MINT_18 = ethers.parseUnits("10000000", 18);
  const MINT_6 = ethers.parseUnits("10000000", 6);
  await (await talpha.mint(signer.address, MINT_18)).wait();
  await (await tbeta.mint(signer.address, MINT_18)).wait();
  await (await tusdt.mint(signer.address, MINT_6)).wait();
  console.log("  Minted 10M of each token");

  // --- Step 3: Create pools ---
  console.log("\n=== Step 3: Create Pools ===\n");

  const factoryContract = new ethers.Contract(factory.target, V3Factory.abi, signer);
  const FEE = 3000;

  async function createPool(tokenA, tokenB, nameA, nameB, decA, decB, priceAinB) {
    const tx = await factoryContract.createPool(tokenA, tokenB, FEE);
    await tx.wait();
    const poolAddr = await factoryContract.getPool(tokenA, tokenB, FEE);
    console.log(`  ${nameA}/${nameB} pool: ${poolAddr}`);

    const poolAbi = [
      "function initialize(uint160 sqrtPriceX96) external",
      "function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)",
      "function token0() view returns (address)",
      "function token1() view returns (address)",
    ];
    const pool = new ethers.Contract(poolAddr, poolAbi, signer);
    const token0 = await pool.token0();
    const isAToken0 = token0.toLowerCase() === tokenA.toLowerCase();

    const sqrtPrice = isAToken0
      ? encodeSqrtPrice(priceAinB, decA, decB)
      : encodeSqrtPrice(1 / priceAinB, decB, decA);

    await (await pool.initialize(sqrtPrice)).wait();

    const slot0 = await pool.slot0();
    const sqrtP = Number(slot0[0]) / 2 ** 96;
    const d0 = isAToken0 ? decA : decB;
    const d1 = isAToken0 ? decB : decA;
    const price = sqrtP * sqrtP * Math.pow(10, d0 - d1);
    console.log(`  Initialized at price: ${price.toFixed(6)} ${nameB} per ${nameA}`);

    return { poolAddr, pool, token0, isAToken0, tick: Number(slot0[1]) };
  }

  // Create 3 pools with specific prices
  // TALPHA/tUSDT: 1 TALPHA = 2.50 tUSDT
  const pool1 = await createPool(talpha.target, tusdt.target, "TALPHA", "tUSDT", 18, 6, 2.50);
  // TBETA/tUSDT: 1 TBETA = 1.00 tUSDT
  const pool2 = await createPool(tbeta.target, tusdt.target, "TBETA", "tUSDT", 18, 6, 1.00);
  // TALPHA/TBETA: 1 TALPHA = 2.60 TBETA (intentional mispricing! should be 2.50)
  const pool3 = await createPool(talpha.target, tbeta.target, "TALPHA", "TBETA", 18, 18, 2.60);

  console.log("\n  ** ARBITRAGE OPPORTUNITY CREATED **");
  console.log("  TALPHA via tUSDT: $2.50");
  console.log("  TALPHA via TBETA: $2.60 (1 TALPHA = 2.60 TBETA × $1.00 = $2.60)");
  console.log("  → Buy TALPHA for $2.50 tUSDT, sell for 2.60 TBETA ($2.60) → $0.10 profit per TALPHA");

  // --- Step 4: Add liquidity ---
  console.log("\n=== Step 4: Add Liquidity ===\n");

  const npmContract = new ethers.Contract(npm.target, V3NPM.abi, signer);

  await (await talpha.approve(npm.target, ethers.MaxUint256)).wait();
  await (await tbeta.approve(npm.target, ethers.MaxUint256)).wait();
  await (await tusdt.approve(npm.target, ethers.MaxUint256)).wait();
  console.log("  Approved NPM for all tokens");

  const TICK_SPACING = 60;

  async function addLiquidity(poolInfo, name, token0Addr, token1Addr, amount0, amount1) {
    const tickLower = Math.floor((poolInfo.tick - 6000) / TICK_SPACING) * TICK_SPACING;
    const tickUpper = Math.ceil((poolInfo.tick + 6000) / TICK_SPACING) * TICK_SPACING;

    const [sorted0, sorted1] = token0Addr.toLowerCase() < token1Addr.toLowerCase()
      ? [token0Addr, token1Addr]
      : [token1Addr, token0Addr];
    const [amt0, amt1] = token0Addr.toLowerCase() < token1Addr.toLowerCase()
      ? [amount0, amount1]
      : [amount1, amount0];

    try {
      const tx = await npmContract.mint({
        token0: sorted0,
        token1: sorted1,
        fee: FEE,
        tickLower,
        tickUpper,
        amount0Desired: amt0,
        amount1Desired: amt1,
        amount0Min: 0,
        amount1Min: 0,
        recipient: signer.address,
        deadline: Math.floor(Date.now() / 1000) + 600,
      });
      const receipt = await tx.wait();
      console.log(`  ${name}: Liquidity added (tx: ${receipt.hash.slice(0, 10)}...)`);
    } catch (e) {
      console.error(`  ${name}: Liquidity failed — ${e.message.slice(0, 100)}`);
    }
  }

  await addLiquidity(pool1, "TALPHA/tUSDT", talpha.target, tusdt.target,
    ethers.parseUnits("100000", 18), ethers.parseUnits("250000", 6));
  await addLiquidity(pool2, "TBETA/tUSDT", tbeta.target, tusdt.target,
    ethers.parseUnits("200000", 18), ethers.parseUnits("200000", 6));
  await addLiquidity(pool3, "TALPHA/TBETA", talpha.target, tbeta.target,
    ethers.parseUnits("100000", 18), ethers.parseUnits("260000", 18));

  // --- Step 5: Save deployment info ---
  const deployment = {
    network: network.chainId.toString(),
    deployer: signer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      weth9: weth9.target,
      factory: factory.target,
      router: router.target,
      npm: npm.target,
    },
    tokens: {
      TALPHA: { address: talpha.target, decimals: 18 },
      TBETA: { address: tbeta.target, decimals: 18 },
      tUSDT: { address: tusdt.target, decimals: 6 },
    },
    pools: {
      "TALPHA/tUSDT": { address: pool1.poolAddr, price: "2.50 tUSDT per TALPHA" },
      "TBETA/tUSDT": { address: pool2.poolAddr, price: "1.00 tUSDT per TBETA" },
      "TALPHA/TBETA": { address: pool3.poolAddr, price: "2.60 TBETA per TALPHA (mispriced!)" },
    },
  };

  const outPath = path.join(__dirname, "..", "testnet_deployment.json");
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2));

  console.log(`\n${"=".repeat(60)}`);
  console.log("  DEPLOYMENT COMPLETE!");
  console.log(`${"=".repeat(60)}`);
  console.log(`\n  Saved to: testnet_deployment.json`);
  console.log(`\n  To use with the trading bot, update .env:`);
  console.log(`    NETWORK=testnet`);
  console.log(`    SWAP_ROUTER=${router.target}`);
  console.log(`\n  And add pools to src/config.js.`);
  console.log(`\n  Arbitrage path:`);
  console.log(`    1. Buy TALPHA with tUSDT @ $2.50 (pool 1)`);
  console.log(`    2. Sell TALPHA for TBETA @ 2.60 (pool 3)`);
  console.log(`    3. Sell TBETA for tUSDT @ $1.00 (pool 2)`);
  console.log(`    4. Net: $2.50 in → $2.60 out = $0.10 profit per TALPHA`);
  console.log(`       (minus 3 × 0.3% fees = ~$0.0225 → net ~$0.077 profit)\n`);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
