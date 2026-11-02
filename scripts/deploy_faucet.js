const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const DRIP_AMOUNT = "50";
const FUND_AMOUNT = "1000000";
const COOLDOWN_SECONDS = 24 * 60 * 60;

async function main() {
  const depFile = path.join(__dirname, "..", "testnet_deployment.json");
  const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));
  const { address: tusdtAddr, decimals } = dep.tokens.tUSDT;

  const [signer] = await ethers.getSigners();
  console.log(`Deployer: ${signer.address}`);

  const Faucet = await ethers.getContractFactory("TokenFaucet");
  const faucet = await Faucet.deploy(tusdtAddr, ethers.parseUnits(DRIP_AMOUNT, decimals), COOLDOWN_SECONDS);
  await faucet.waitForDeployment();
  const faucetAddr = await faucet.getAddress();
  console.log(`TokenFaucet: ${faucetAddr}`);

  const tusdt = await ethers.getContractAt("MockERC20", tusdtAddr);
  await (await tusdt.mint(faucetAddr, ethers.parseUnits(FUND_AMOUNT, decimals))).wait();
  const bal = await tusdt.balanceOf(faucetAddr);
  console.log(`Faucet balance: ${ethers.formatUnits(bal, decimals)} tUSDT`);

  dep.contracts.faucet = faucetAddr;
  fs.writeFileSync(depFile, JSON.stringify(dep, null, 2) + "\n");
  console.log("Saved faucet address to testnet_deployment.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
