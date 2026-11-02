const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");
const config = require("./config");
const { getProvider } = require("./chain");
const { encodeArbPath, withGasHeadroom } = require("./executor");

const VAULT_ABI = [
  "function getUsers() view returns (address[])",
  "function balanceOf(address) view returns (uint256)",
  "function maxTradeAmount() view returns (uint256)",
  "function paused() view returns (bool)",
  "function executeArbFor(address user, bytes path, uint256 amountIn, uint256 amountOutMinimum) returns (uint256)",
  "event ArbExecuted(address indexed user, uint256 amountIn, uint256 amountOut, uint256 profit)",
];

const MIN_TRADE = ethers.parseUnits("1", 6);
const MAX_USERS_PER_CYCLE = 20;

function getUserVaultAddress() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "testnet_deployment.json"), "utf8"));
  return dep.contracts.userVault || null;
}

async function runUserArbs(opportunities) {
  const vaultAddr = getUserVaultAddress();
  if (!vaultAddr || !config.PRIVATE_KEY) return [];

  const opp = (opportunities || []).find(o => o.steps[0].inToken === "tUSDT" && o.profitPct > 0);
  if (!opp) return [];

  const wallet = new ethers.Wallet(config.PRIVATE_KEY, getProvider());
  const vault = new ethers.Contract(vaultAddr, VAULT_ABI, wallet);
  if (await vault.paused()) return [];

  const arbPath = encodeArbPath(opp.steps);
  const [users, maxTrade] = await Promise.all([vault.getUsers(), vault.maxTradeAmount()]);
  const balances = await Promise.all(users.map(u => vault.balanceOf(u)));

  const results = [];
  for (let i = 0; i < users.length && results.length < MAX_USERS_PER_CYCLE; i++) {
    const user = users[i];
    const amountIn = balances[i] < maxTrade ? balances[i] : maxTrade;
    if (amountIn < MIN_TRADE) continue;

    // Estimating gas also simulates the trade, so an unprofitable size costs nothing.
    let gasLimit;
    try {
      gasLimit = withGasHeadroom(await vault.executeArbFor.estimateGas(user, arbPath, amountIn, amountIn));
    } catch {
      results.push({ user, executed: false, reason: "not profitable at this size" });
      continue;
    }

    try {
      const tx = await vault.executeArbFor(user, arbPath, amountIn, amountIn, { gasLimit });
      const receipt = await tx.wait();
      const ev = receipt.logs
        .map(l => { try { return vault.interface.parseLog(l); } catch { return null; } })
        .find(p => p && p.name === "ArbExecuted");
      const profit = ev ? Number(ethers.formatUnits(ev.args.profit, 6)) : 0;
      const amount = Number(ethers.formatUnits(amountIn, 6));
      console.log(`  👤 USER ARB ${user.slice(0, 6)}...${user.slice(-4)}: ${amount} tUSDT → +${profit.toFixed(4)} (tx ${tx.hash.slice(0, 12)}...)`);
      results.push({ user, executed: true, txHash: tx.hash, amountIn: amount, profit });
    } catch (e) {
      console.log(`  ❌ USER ARB ${user.slice(0, 6)}... failed: ${(e.shortMessage || e.message).slice(0, 80)}`);
      results.push({ user, executed: false, reason: e.shortMessage || e.message });
    }
  }
  return results;
}

module.exports = { runUserArbs, getUserVaultAddress, VAULT_ABI };
