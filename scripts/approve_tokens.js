require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "testnet_deployment.json"), "utf8"));

const provider = new ethers.JsonRpcProvider("https://testnet.hsk.xyz");
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const ROUTER = dep.contracts.router;

const ERC20_ABI = [
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
  "function symbol() view returns (string)",
];

async function main() {
  console.log(`Wallet: ${wallet.address}`);
  console.log(`Router: ${ROUTER}\n`);

  for (const [name, info] of Object.entries(dep.tokens)) {
    const token = new ethers.Contract(info.address, ERC20_ABI, wallet);
    const allowance = await token.allowance(wallet.address, ROUTER);

    if (allowance > 0n) {
      console.log(`${name}: already approved (${ethers.formatUnits(allowance, info.decimals)})`);
      continue;
    }

    console.log(`${name}: approving router...`);
    const tx = await token.approve(ROUTER, ethers.MaxUint256);
    const receipt = await tx.wait();
    console.log(`${name}: approved (tx: ${receipt.hash})`);
  }

  console.log("\nAll tokens approved for router.");
}

main().catch(console.error);
