const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const risk = require("./risk");
const { getProvider, ERC20_ABI } = require("./chain");

const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)",
];

const VAULT_ABI = [
  "function executeTrade(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 amountOutMinimum) returns (uint256 amountOut)",
  "function executeArb(bytes path, uint256 amountIn, uint256 amountOutMinimum) returns (uint256 amountOut)",
  "function getTokenBalance(address token) view returns (uint256)",
  "function getVaultState() view returns (address, address, address, uint256, uint256, uint256, uint256, uint256, bool)",
];

let TESTNET_TOKENS = null;
function getTestnetTokens() {
  if (TESTNET_TOKENS) return TESTNET_TOKENS;
  const depFile = path.join(__dirname, "..", "testnet_deployment.json");
  const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));
  TESTNET_TOKENS = {};
  for (const [name, info] of Object.entries(dep.tokens)) {
    TESTNET_TOKENS[name] = { addr: info.address, decimals: info.decimals };
  }
  TESTNET_TOKENS.router = dep.contracts.router;
  TESTNET_TOKENS.vault = dep.contracts.vault || null;
  return TESTNET_TOKENS;
}

function getTokenAddr(token) {
  const t = getTestnetTokens();
  return t[token]?.addr || null;
}

function getTokenDecimals(token) {
  const t = getTestnetTokens();
  return t[token]?.decimals ?? 18;
}

function getQuoteToken(poolName) {
  const parts = poolName.split("/");
  return parts[1];
}

async function executePaper(signal, poolName, price) {
  const token = poolName.split("/")[0];
  if (signal.action === "buy") {
    const check = risk.canOpenPosition(token, price, signal);
    if (!check.ok) return { executed: false, reason: check.reason };
    const pos = risk.openPosition(token, price, check.maxUsdt);
    return { executed: true, action: "buy", token, price, amount: pos.amount, cost: pos.costUsdt, mode: "paper" };
  }
  if (signal.action === "sell") {
    const result = risk.closePosition(token, price, "signal-sell");
    if (!result) return { executed: false, reason: `No open position in ${token}` };
    return { executed: true, action: "sell", token, price, pnl: result.pnl, pnlPct: result.pnlPct, mode: "paper" };
  }
  return { executed: false, reason: "Hold signal" };
}

async function executeLive(signal, poolName, price) {
  if (!config.PRIVATE_KEY) {
    return { executed: false, reason: "Live mode not configured (need PRIVATE_KEY)" };
  }

  const token = poolName.split("/")[0];
  const quoteToken = getQuoteToken(poolName);
  const tokenAddr = getTokenAddr(token);
  const quoteAddr = getTokenAddr(quoteToken);

  if (!tokenAddr || !quoteAddr) {
    return { executed: false, reason: `Token address not found for ${token} or ${quoteToken}` };
  }

  const tokens = getTestnetTokens();
  const provider = getProvider();
  const wallet = new ethers.Wallet(config.PRIVATE_KEY, provider);
  const useVault = !!tokens.vault;

  if (signal.action === "buy") {
    const check = risk.canOpenPosition(token, price, signal);
    if (!check.ok) return { executed: false, reason: check.reason };

    const amountUsdt = check.maxUsdt;
    const quoteDec = getTokenDecimals(quoteToken);
    const amountIn = ethers.parseUnits(amountUsdt.toFixed(Math.min(quoteDec, 6)), quoteDec);

    let receipt;
    if (useVault) {
      const vault = new ethers.Contract(tokens.vault, VAULT_ABI, wallet);
      const tx = await vault.executeTrade(quoteAddr, tokenAddr, 3000, amountIn, 0n);
      receipt = await tx.wait();
    } else {
      const router = new ethers.Contract(tokens.router, ROUTER_ABI, wallet);
      const quoteContract = new ethers.Contract(quoteAddr, ERC20_ABI, wallet);
      const allowance = await quoteContract.allowance(wallet.address, tokens.router);
      if (allowance < amountIn) {
        await (await quoteContract.approve(tokens.router, ethers.MaxUint256)).wait();
      }
      const tx = await router.exactInputSingle({
        tokenIn: quoteAddr, tokenOut: tokenAddr, fee: 3000,
        recipient: wallet.address, deadline: Math.floor(Date.now() / 1000) + 300,
        amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
      });
      receipt = await tx.wait();
    }

    risk.openPosition(token, price, amountUsdt);
    return { executed: true, action: "buy", token, price, cost: amountUsdt, txHash: receipt.hash, mode: useVault ? "vault" : "live" };
  }

  if (signal.action === "sell") {
    const pos = risk.getState().positions.find(p => p.token === token);
    if (!pos) return { executed: false, reason: `No open position in ${token}` };

    const tokenDec = getTokenDecimals(token);
    const amountIn = ethers.parseUnits(pos.amount.toFixed(Math.min(tokenDec, 8)), tokenDec);

    let receipt;
    if (useVault) {
      const vault = new ethers.Contract(tokens.vault, VAULT_ABI, wallet);
      const tx = await vault.executeTrade(tokenAddr, quoteAddr, 3000, amountIn, 0n);
      receipt = await tx.wait();
    } else {
      const router = new ethers.Contract(tokens.router, ROUTER_ABI, wallet);
      const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
      const allowance = await tokenContract.allowance(wallet.address, tokens.router);
      if (allowance < amountIn) {
        await (await tokenContract.approve(tokens.router, ethers.MaxUint256)).wait();
      }
      const tx = await router.exactInputSingle({
        tokenIn: tokenAddr, tokenOut: quoteAddr, fee: 3000,
        recipient: wallet.address, deadline: Math.floor(Date.now() / 1000) + 300,
        amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
      });
      receipt = await tx.wait();
    }

    const result = risk.closePosition(token, price, "signal-sell");
    return { executed: true, action: "sell", token, price, pnl: result?.pnl || 0, txHash: receipt.hash, mode: useVault ? "vault" : "live" };
  }

  return { executed: false, reason: "Hold signal" };
}

async function executeArbLive(opportunity) {
  if (!config.PRIVATE_KEY) {
    return { executed: false, reason: "Live mode not configured" };
  }

  const tokens = getTestnetTokens();
  const provider = getProvider();
  const wallet = new ethers.Wallet(config.PRIVATE_KEY, provider);
  const useVault = !!tokens.vault;

  const steps = opportunity.steps;
  if (!steps || steps.length === 0) {
    return { executed: false, reason: "No arb steps" };
  }

  const firstIn = steps[0].inToken || steps[0].in;
  const startDec = getTokenDecimals(firstIn);
  const startAddr = getTokenAddr(firstIn);
  if (!startAddr) return { executed: false, reason: `Token address not found for ${firstIn}` };
  const startAmount = ethers.parseUnits(opportunity.startAmount.toFixed(Math.min(startDec, 6)), startDec);

  const pathParts = [];
  for (let i = 0; i < steps.length; i++) {
    const inAddr = getTokenAddr(steps[i].inToken || steps[i].in);
    if (i === 0) pathParts.push(inAddr);
    pathParts.push(3000);
    pathParts.push(getTokenAddr(steps[i].outToken || steps[i].out));
  }

  const types = [];
  const values = [];
  for (let i = 0; i < pathParts.length; i++) {
    if (i % 2 === 0) {
      types.push("address");
      values.push(pathParts[i]);
    } else {
      types.push("uint24");
      values.push(pathParts[i]);
    }
  }
  const encodedPath = ethers.solidityPacked(types, values);

  try {
    let receipt;
    if (useVault) {
      const vault = new ethers.Contract(tokens.vault, VAULT_ABI, wallet);
      const minOut = startAmount * 98n / 100n;
      const tx = await vault.executeArb(encodedPath, startAmount, minOut);
      receipt = await tx.wait();
    } else {
      const router = new ethers.Contract(tokens.router, ROUTER_ABI, wallet);
      const startContract = new ethers.Contract(startAddr, ERC20_ABI, wallet);
      const allowance = await startContract.allowance(wallet.address, tokens.router);
      if (allowance < startAmount) {
        await (await startContract.approve(tokens.router, ethers.MaxUint256)).wait();
      }
      const tx = await router.exactInput({
        path: encodedPath, recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 300,
        amountIn: startAmount, amountOutMinimum: startAmount * 98n / 100n,
      });
      receipt = await tx.wait();
    }

    const profit = opportunity.profit;
    risk.state.balance += profit;
    risk.state.totalPnl += profit;
    risk.state.dailyPnl += profit;
    risk.state.totalTrades++;
    risk.state.closedToday.push({
      token: "ARB",
      entryPrice: opportunity.startAmount,
      closePrice: opportunity.endAmount,
      amount: 1,
      costUsdt: opportunity.startAmount,
      pnl: profit,
      pnlPct: opportunity.profitPct,
      reason: useVault ? "triangular-arb-vault" : "triangular-arb-live",
      closedAt: Date.now(),
    });

    return { executed: true, action: "arb", profit, profitPct: opportunity.profitPct, txHash: receipt.hash, mode: useVault ? "vault" : "live" };
  } catch (e) {
    return { executed: false, reason: `Arb tx failed: ${e.message.slice(0, 100)}` };
  }
}

async function execute(signal, poolName, price) {
  return executeLive(signal, poolName, price);
}

module.exports = { execute, executePaper, executeLive, executeArbLive };
