require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "testnet_deployment.json"), "utf8"));

const provider = new ethers.JsonRpcProvider("https://testnet.hsk.xyz");
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const ROUTER = dep.contracts.router;

const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];

const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);

const ERC20_ABI = [
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
];

const TOKENS = {
  TALPHA: { addr: dep.tokens.TALPHA.address, decimals: 18 },
  TBETA:  { addr: dep.tokens.TBETA.address,  decimals: 18 },
  tUSDT:  { addr: dep.tokens.tUSDT.address,  decimals: 6 },
};

const SWAPS = [
  { name: "Buy TALPHA",   tokenIn: "tUSDT",  tokenOut: "TALPHA", amount: "800",  decIn: 6,  fee: 3000 },
  { name: "Sell TALPHA",  tokenIn: "TALPHA", tokenOut: "tUSDT",  amount: "300",  decIn: 18, fee: 3000 },
  { name: "Buy TBETA",    tokenIn: "tUSDT",  tokenOut: "TBETA",  amount: "600",  decIn: 6,  fee: 3000 },
  { name: "Sell TBETA",   tokenIn: "TBETA",  tokenOut: "tUSDT",  amount: "600",  decIn: 18, fee: 3000 },
  { name: "TALPHA→TBETA", tokenIn: "TALPHA", tokenOut: "TBETA",  amount: "200",  decIn: 18, fee: 3000 },
  { name: "TBETA→TALPHA", tokenIn: "TBETA",  tokenOut: "TALPHA", amount: "400",  decIn: 18, fee: 3000 },
];

const INTERVAL_MS = 20_000;

async function doRandomSwap() {
  const swap = SWAPS[Math.floor(Math.random() * SWAPS.length)];
  const amountVariation = (0.5 + Math.random()) * parseFloat(swap.amount);
  const amountIn = ethers.parseUnits(amountVariation.toFixed(Math.min(swap.decIn, 6)), swap.decIn);

  const params = {
    tokenIn: TOKENS[swap.tokenIn].addr,
    tokenOut: TOKENS[swap.tokenOut].addr,
    fee: swap.fee,
    recipient: wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 300,
    amountIn,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  };

  try {
    const tx = await router.exactInputSingle(params);
    const receipt = await tx.wait();
    console.log(`[${new Date().toLocaleTimeString()}] ${swap.name}: ${amountVariation.toFixed(2)} ${swap.tokenIn} (tx: ${receipt.hash.slice(0, 10)}...)`);
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString()}] ${swap.name} failed: ${e.message.slice(0, 80)}`);
  }
}

async function main() {
  console.log("Market Maker — HSK Testnet");
  console.log(`Wallet: ${wallet.address}`);
  console.log(`Swap interval: ${INTERVAL_MS / 1000}s\n`);

  // Swaps fail with "STF" if any router allowance has been overwritten with a finite amount.
  for (const [name, info] of Object.entries(TOKENS)) {
    const token = new ethers.Contract(info.addr, ERC20_ABI, wallet);
    if ((await token.allowance(wallet.address, ROUTER)) < ethers.MaxUint256 / 2n) {
      await (await token.approve(ROUTER, ethers.MaxUint256)).wait();
      console.log(`Re-approved router for ${name}`);
    }
  }

  while (true) {
    await doRandomSwap();
    const jitter = INTERVAL_MS * (0.5 + Math.random());
    await new Promise(r => setTimeout(r, jitter));
  }
}

main().catch(console.error);
