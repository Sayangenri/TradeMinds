const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const MAX_TRADE_AMOUNT = "1000";

async function main() {
  const depFile = path.join(__dirname, "..", "testnet_deployment.json");
  const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));
  const { address: tusdtAddr, decimals } = dep.tokens.tUSDT;

  const [signer] = await ethers.getSigners();
  console.log(`Deployer / agent: ${signer.address}`);

  const Vault = await ethers.getContractFactory("MultiUserVault");
  const vault = await Vault.deploy(
    tusdtAddr,
    signer.address,
    dep.contracts.router,
    ethers.parseUnits(MAX_TRADE_AMOUNT, decimals)
  );
  const receipt = await vault.deploymentTransaction().wait();
  const vaultAddr = await vault.getAddress();
  console.log(`MultiUserVault: ${vaultAddr} (block ${receipt.blockNumber})`);

  dep.contracts.userVault = vaultAddr;
  dep.contracts.userVaultDeployBlock = receipt.blockNumber;
  fs.writeFileSync(depFile, JSON.stringify(dep, null, 2) + "\n");
  console.log("Saved to testnet_deployment.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
