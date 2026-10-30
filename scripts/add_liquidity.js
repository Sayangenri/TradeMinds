require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "testnet_deployment.json"), "utf8"));
const V3NPM = require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");

const provider = new ethers.JsonRpcProvider("https://testnet.hsk.xyz");
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const npm = new ethers.Contract(dep.contracts.npm, V3NPM.abi, wallet);

const ERC20_ABI = [
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
];

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function initialize(uint160 sqrtPriceX96) external",
];

const TICK_SPACING = 60;
const MIN_TICK = -887220;
const MAX_TICK = 887220;

function encodeSqrtPrice(price, dec0, dec1) {
  const rawPrice = price * Math.pow(10, dec1 - dec0);
  return BigInt(Math.floor(Math.sqrt(rawPrice) * 2 ** 96));
}

async function main() {
  console.log("Adding full-range liquidity to testnet pools\n");
  console.log(`Wallet: ${wallet.address}`);

  for (const [name, info] of Object.entries(dep.tokens)) {
    const token = new ethers.Contract(info.address, ERC20_ABI, wallet);
    const allowance = await token.allowance(wallet.address, dep.contracts.npm);
    if (allowance === 0n) {
      console.log(`Approving ${name} for NPM...`);
      await (await token.approve(dep.contracts.npm, ethers.MaxUint256)).wait();
    }
  }
  console.log("Token approvals OK\n");

  const pools = [
    {
      name: "TALPHA/tUSDT",
      addr: dep.pools["TALPHA/tUSDT"].address,
      tokenA: dep.tokens.TALPHA.address,
      tokenB: dep.tokens.tUSDT.address,
      decA: 18, decB: 6,
      targetPrice: 2.50,
      amountA: ethers.parseUnits("500000", 18),
      amountB: ethers.parseUnits("1250000", 6),
    },
    {
      name: "TBETA/tUSDT",
      addr: dep.pools["TBETA/tUSDT"].address,
      tokenA: dep.tokens.TBETA.address,
      tokenB: dep.tokens.tUSDT.address,
      decA: 18, decB: 6,
      targetPrice: 1.00,
      amountA: ethers.parseUnits("500000", 18),
      amountB: ethers.parseUnits("500000", 6),
    },
    {
      name: "TALPHA/TBETA",
      addr: dep.pools["TALPHA/TBETA"].address,
      tokenA: dep.tokens.TALPHA.address,
      tokenB: dep.tokens.TBETA.address,
      decA: 18, decB: 18,
      targetPrice: 2.60,
      amountA: ethers.parseUnits("500000", 18),
      amountB: ethers.parseUnits("1300000", 18),
    },
  ];

  for (const p of pools) {
    console.log(`--- ${p.name} ---`);
    const pool = new ethers.Contract(p.addr, POOL_ABI, wallet);
    const slot0 = await pool.slot0();
    const currentTick = Number(slot0[1]);
    const token0 = await pool.token0();
    const isAToken0 = token0.toLowerCase() === p.tokenA.toLowerCase();

    console.log(`  Current tick: ${currentTick}`);

    const tickLower = Math.ceil(MIN_TICK / TICK_SPACING) * TICK_SPACING;
    const tickUpper = Math.floor(MAX_TICK / TICK_SPACING) * TICK_SPACING;

    const [sorted0, sorted1] = p.tokenA.toLowerCase() < p.tokenB.toLowerCase()
      ? [p.tokenA, p.tokenB] : [p.tokenB, p.tokenA];
    const [amt0, amt1] = p.tokenA.toLowerCase() < p.tokenB.toLowerCase()
      ? [p.amountA, p.amountB] : [p.amountB, p.amountA];

    try {
      const tx = await npm.mint({
        token0: sorted0,
        token1: sorted1,
        fee: 3000,
        tickLower,
        tickUpper,
        amount0Desired: amt0,
        amount1Desired: amt1,
        amount0Min: 0,
        amount1Min: 0,
        recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 600,
      });
      const receipt = await tx.wait();
      console.log(`  Full-range liquidity added (tx: ${receipt.hash.slice(0, 14)}...)`);
    } catch (e) {
      console.error(`  Failed: ${e.message.slice(0, 120)}`);
    }
  }

  console.log("\nVerifying prices...");
  const { readPool } = require("../src/chain");
  for (const [name, info] of Object.entries(dep.pools)) {
    const data = await readPool(info.address);
    console.log(`  ${name}: $${data.price.toFixed(6)}`);
  }

  console.log("\nDone! Pools now have full-range liquidity for stable trading.");
}

main().catch(console.error);
