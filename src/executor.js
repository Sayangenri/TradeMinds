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
  const router = new ethers.Contract(tokens.router, ROUTER_ABI, wallet);

  if (signal.action === "buy") {
    const check = risk.canOpenPosition(token, price, signal);
    if (!check.ok) return { executed: false, reason: check.reason };

    const amountUsdt = check.maxUsdt;
    const quoteDec = getTokenDecimals(quoteToken);
    const amountIn = ethers.parseUnits(amountUsdt.toFixed(Math.min(quoteDec, 6)), quoteDec);

    const quoteContract = new ethers.Contract(quoteAddr, ERC20_ABI, wallet);
    const allowance = await quoteContract.allowance(wallet.address, tokens.router);
    if (allowance < amountIn) {
      const tx = await quoteContract.approve(tokens.router, ethers.MaxUint256);
      await tx.wait();
    }

    const params = {
      tokenIn: quoteAddr,
      tokenOut: tokenAddr,
      fee: 3000,
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 300,
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    };

    const tx = await router.exactInputSingle(params);
    const receipt = await tx.wait();

    risk.openPosition(token, price, amountUsdt);
    return { executed: true, action: "buy", token, price, cost: amountUsdt, txHash: receipt.hash, mode: "live" };
  }

  if (signal.action === "sell") {
    const pos = risk.getState().positions.find(p => p.token === token);
    if (!pos) return { executed: false, reason: `No open position in ${token}` };

    const tokenDec = getTokenDecimals(token);
    const amountIn = ethers.parseUnits(pos.amount.toFixed(Math.min(tokenDec, 8)), tokenDec);

    const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
    const allowance = await tokenContract.allowance(wallet.address, tokens.router);
    if (allowance < amountIn) {
      const tx = await tokenContract.approve(tokens.router, ethers.MaxUint256);
      await tx.wait();
    }

    const params = {
      tokenIn: tokenAddr,
      tokenOut: quoteAddr,
      fee: 3000,
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 300,
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    };

    const tx = await router.exactInputSingle(params);
    const receipt = await tx.wait();

    const result = risk.closePosition(token, price, "signal-sell");
    return { executed: true, action: "sell", token, price, pnl: result?.pnl || 0, txHash: receipt.hash, mode: "live" };
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
  const router = new ethers.Contract(tokens.router, ROUTER_ABI, wallet);

  const steps = opportunity.steps;
  if (!steps || steps.length === 0) {
    return { executed: false, reason: "No arb steps" };
  }

  const firstIn = steps[0].in;
  const startDec = getTokenDecimals(firstIn);
  const startAddr = getTokenAddr(firstIn);
  const startAmount = ethers.parseUnits(opportunity.startAmount.toFixed(Math.min(startDec, 6)), startDec);

  const startContract = new ethers.Contract(startAddr, ERC20_ABI, wallet);
  const allowance = await startContract.allowance(wallet.address, tokens.router);
  if (allowance < startAmount) {
    const tx = await startContract.approve(tokens.router, ethers.MaxUint256);
    await tx.wait();
  }

  const pathParts = [];
  for (let i = 0; i < steps.length; i++) {
    const inAddr = getTokenAddr(steps[i].in);
    if (i === 0) pathParts.push(inAddr);
    pathParts.push(3000);
    pathParts.push(getTokenAddr(steps[i].out));
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

  const params = {
    path: encodedPath,
    recipient: wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 300,
    amountIn: startAmount,
    amountOutMinimum: startAmount,
  };

  try {
    const tx = await router.exactInput(params);
    const receipt = await tx.wait();

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
      reason: "triangular-arb-live",
      closedAt: Date.now(),
    });

    return { executed: true, action: "arb", profit, profitPct: opportunity.profitPct, txHash: receipt.hash, mode: "live" };
  } catch (e) {
    return { executed: false, reason: `Arb tx failed: ${e.message.slice(0, 100)}` };
  }
}

async function execute(signal, poolName, price) {
  if (config.MODE === "live") return executeLive(signal, poolName, price);
  return executePaper(signal, poolName, price);
}

module.exports = { execute, executePaper, executeLive, executeArbLive };
