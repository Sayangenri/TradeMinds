/**
 * Scan deployed testnet pools for triangular arbitrage opportunities.
 *
 * Usage:
 *   node scripts/scan_arb.js
 *
 * Reads pool addresses from testnet_deployment.json (created by deploy_testnet_dex.js).
 * Set NETWORK=testnet in .env to point at HSK testnet, or leave as mainnet for HSKSwap pools.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { scanArbitrage } = require("../src/arb");

(async () => {
  const deployFile = path.join(__dirname, "..", "testnet_deployment.json");

  let poolAddresses;

  if (fs.existsSync(deployFile) && process.env.NETWORK === "testnet") {
    const deployment = JSON.parse(fs.readFileSync(deployFile, "utf8"));
    poolAddresses = Object.values(deployment.pools).map(p => p.address);
    console.log(`\n  Using testnet deployment (${poolAddresses.length} pools)`);
    console.log(`  RPC: https://testnet.hsk.xyz\n`);
  } else {
    const config = require("../src/config");
    poolAddresses = config.POOLS.map(p => p.addr);
    console.log(`\n  Using ${config.POOLS.length} HSKSwap ${process.env.NETWORK || "mainnet"} pools`);
    console.log(`  RPC: ${config.RPC_URL}\n`);
  }

  const opportunities = await scanArbitrage(poolAddresses, 1000);

  if (opportunities.length > 0) {
    console.log("  Best opportunity summary:");
    const best = opportunities[0];
    console.log(`  $${best.startAmount} → $${best.endAmount.toFixed(2)} = $${best.profit.toFixed(2)} profit (${best.profitPct.toFixed(2)}%)`);
  }

  process.exit(0);
})();
