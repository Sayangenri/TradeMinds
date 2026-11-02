require("dotenv").config();
const fs = require("fs");
const path = require("path");

const isTestnet = process.env.NETWORK === "testnet";

const MAINNET_POOLS = [
  { name: "HSK/USDT",  addr: "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc", token0: "HSK",  token1: "USDT" },
  { name: "WBTC/USDT", addr: "0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a", token0: "WBTC", token1: "USDT" },
  { name: "WETH/USDT", addr: "0xb92b79ed6b370d5cfee2e14b1d0983c258304c16", token0: "WETH", token1: "USDT" },
  { name: "TSLA/USDT", addr: "0x959438caea85ca4766f3ecd4f943ea9767af93ce", token0: "TSLA", token1: "USDT" },
  { name: "QQQ/USDT",  addr: "0x0f10e271790a5d56df49c42647759766d5506dbf", token0: "QQQ",  token1: "USDT" },
  { name: "AAPL/USDT", addr: "0x41767b8a9959b04c7edb42ca7f0d5e97f73d719f", token0: "AAPL", token1: "USDT" },
  { name: "NVDA/USDT", addr: "0xa3a69eb7a1cd69008b06487dd78105f4ce5582af", token0: "NVDA", token1: "USDT" },
  { name: "CRCL/USDT", addr: "0xfc777c8c5345490648d0292c5ba40661be7209ce", token0: "CRCL", token1: "USDT" },
  { name: "USDC.e/HSK", addr: "0xb580d654ce892181937aac80ea165950cb7d0e02", token0: "USDC.e", token1: "HSK" },
];

function loadTestnetPools() {
  try {
    const deployFile = path.join(__dirname, "..", "testnet_deployment.json");
    if (fs.existsSync(deployFile)) {
      const dep = JSON.parse(fs.readFileSync(deployFile, "utf8"));
      return Object.entries(dep.pools).map(([name, info]) => {
        const [t0, t1] = name.split("/");
        return { name, addr: info.address, token0: t0, token1: t1 };
      });
    }
  } catch {}
  return [];
}

module.exports = {
  RPC_URL: isTestnet ? "https://testnet.hsk.xyz" : "https://mainnet.hsk.xyz",
  CHAIN_ID: isTestnet ? 133 : 177,

  POOLS: isTestnet ? loadTestnetPools() : MAINNET_POOLS,

  POLL_MS:      (process.env.MODE === "simulate") ? 5_000 : 15_000,
  SIGNAL_MS:    (process.env.MODE === "simulate") ? 30_000 : 5 * 60_000,
  REPORT_MS:    (process.env.MODE === "simulate") ? 60_000 : 5 * 60_000,
  ARB_SCAN_MS:  (process.env.MODE === "simulate") ? 30_000 : 2 * 60_000,

  STARTING_BALANCE:    10_000,
  MAX_POSITION_PCT:    3,
  STOP_LOSS_PCT:       1.5,
  TAKE_PROFIT_PCT:     3,
  DAILY_LOSS_LIMIT_PCT: 1,
  MAX_OPEN_POSITIONS:  2,

  MODE: process.env.MODE || "live",  // "live" | "simulate"
  PRIVATE_KEY: process.env.PRIVATE_KEY || null,
  SWAP_ROUTER: process.env.SWAP_ROUTER || "0x56d15cF00b5D853D6eE4CbB1463E6DAD2899fBf5",
  SLIPPAGE_PCT: 1,

  AI_PROVIDER: process.env.AI_PROVIDER || "anthropic",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || null,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || null,
  AI_MODEL: (() => {
    const provider = process.env.AI_PROVIDER || "anthropic";
    const fallback = provider === "openrouter" ? "deepseek/deepseek-chat-v3-0324" : "claude-sonnet-4-20250514";
    const model = process.env.AI_MODEL || fallback;
    if (provider === "openrouter" && !model.includes("/")) return "anthropic/" + model;
    return model;
  })(),
};
