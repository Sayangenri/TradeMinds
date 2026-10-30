const { ethers } = require("ethers");
const config = require("./config");

const V3_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
];

const provider = new ethers.JsonRpcProvider(config.RPC_URL);
const tokenCache = {};

async function tokenInfo(addr) {
  if (tokenCache[addr]) return tokenCache[addr];
  const c = new ethers.Contract(addr, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
  tokenCache[addr] = { symbol, decimals: Number(decimals), addr };
  return tokenCache[addr];
}

async function readPool(poolAddr) {
  const pool = new ethers.Contract(poolAddr, V3_ABI, provider);
  const [slot0, t0a, t1a, fee, liq] = await Promise.all([
    pool.slot0(), pool.token0(), pool.token1(), pool.fee(), pool.liquidity(),
  ]);
  const t0 = await tokenInfo(t0a);
  const t1 = await tokenInfo(t1a);

  const sqrtP = Number(slot0[0]) / 2 ** 96;
  const price = sqrtP * sqrtP * Math.pow(10, t0.decimals - t1.decimals);
  const vr0 = (Number(liq) / sqrtP) / 10 ** t0.decimals;
  const vr1 = (Number(liq) * sqrtP) / 10 ** t1.decimals;

  return {
    addr: poolAddr,
    token0: t0, token1: t1,
    price,
    fee: Number(fee),
    liquidity: Number(liq),
    vr0, vr1,
    tvlUsdt: vr1 * 2,
  };
}

async function getGasPrice() {
  try {
    const fee = await provider.getFeeData();
    return Number(fee.gasPrice || 0n);
  } catch { return 0; }
}

module.exports = { readPool, tokenInfo, getGasPrice, getProvider: () => provider, ERC20_ABI };
