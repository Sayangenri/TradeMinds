require("dotenv").config();
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const depFile = path.join(__dirname, "..", "testnet_deployment.json");
  const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));

  const [deployer] = await ethers.getSigners();
  console.log("Deploying AgentVault with:", deployer.address);

  const AgentVault = await ethers.getContractFactory("AgentVault");
  const vault = await AgentVault.deploy(
    deployer.address,         // agent = deployer (same wallet)
    dep.contracts.router,     // allowed router
    500,                      // maxPositionPct = 5%
    200,                      // dailyLossCapPct = 2%
    0                         // cooldownSeconds = 0 for testnet
  );
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log("AgentVault deployed at:", vaultAddr);

  dep.contracts.vault = vaultAddr;
  fs.writeFileSync(depFile, JSON.stringify(dep, null, 2));
  console.log("Updated testnet_deployment.json");

  console.log("\nDepositing tokens into vault...");
  const ERC20_ABI = [
    "function approve(address, uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
  ];

  const tokens = [
    { name: "TALPHA", addr: dep.tokens.TALPHA.address, decimals: 18, depositAmount: "100000" },
    { name: "TBETA",  addr: dep.tokens.TBETA.address,  decimals: 18, depositAmount: "100000" },
    { name: "tUSDT",  addr: dep.tokens.tUSDT.address,  decimals: 6,  depositAmount: "100000" },
  ];

  for (const t of tokens) {
    const token = new ethers.Contract(t.addr, ERC20_ABI, deployer);
    const bal = await token.balanceOf(deployer.address);
    const depositAmt = ethers.parseUnits(t.depositAmount, t.decimals);
    if (bal < depositAmt) {
      console.log(`  ${t.name}: insufficient balance, depositing ${ethers.formatUnits(bal, t.decimals)} instead`);
    }
    const actualDeposit = bal < depositAmt ? bal : depositAmt;
    if (actualDeposit === 0n) { console.log(`  ${t.name}: zero balance, skipping`); continue; }

    await (await token.approve(vaultAddr, actualDeposit)).wait();
    await (await vault.deposit(t.addr, actualDeposit)).wait();
    console.log(`  ${t.name}: deposited ${ethers.formatUnits(actualDeposit, t.decimals)}`);
  }

  console.log("\nDone! AgentVault is ready.");
}

main().catch(console.error);
