const config = require("./config");

const newsHistory = [];
const MAX_NEWS = 50;

const CRYPTO_NEWS_TEMPLATES = [
  { headline: "HashKey Chain announces partnership with major Asian exchange", sentiment: "bullish", impact: "high", tokens: ["HSK"] },
  { headline: "HSK staking rewards increased to 12% APY", sentiment: "bullish", impact: "medium", tokens: ["HSK"] },
  { headline: "Bitcoin breaks above key resistance level", sentiment: "bullish", impact: "high", tokens: ["WBTC", "WETH"] },
  { headline: "Ethereum gas fees drop to 6-month low", sentiment: "bullish", impact: "medium", tokens: ["WETH"] },
  { headline: "Federal Reserve signals potential rate cut in next meeting", sentiment: "bullish", impact: "high", tokens: ["WBTC", "WETH", "HSK"] },
  { headline: "SEC approves new crypto ETF applications", sentiment: "bullish", impact: "high", tokens: ["WBTC", "WETH"] },
  { headline: "Major DeFi protocol suffers $50M exploit", sentiment: "bearish", impact: "high", tokens: ["WETH", "HSK"] },
  { headline: "China tightens crypto trading regulations", sentiment: "bearish", impact: "high", tokens: ["HSK", "WBTC"] },
  { headline: "Whale alert: 10,000 BTC moved to exchange wallet", sentiment: "bearish", impact: "medium", tokens: ["WBTC"] },
  { headline: "HashKey Chain TVL reaches new all-time high", sentiment: "bullish", impact: "medium", tokens: ["HSK"] },
  { headline: "Global crypto market cap surpasses $3 trillion", sentiment: "bullish", impact: "medium", tokens: ["WBTC", "WETH", "HSK"] },
  { headline: "Major bank announces crypto custody service launch", sentiment: "bullish", impact: "medium", tokens: ["WBTC", "WETH"] },
  { headline: "Ethereum network upgrade successfully deployed", sentiment: "bullish", impact: "medium", tokens: ["WETH"] },
  { headline: "Crypto exchange faces regulatory scrutiny in EU", sentiment: "bearish", impact: "medium", tokens: ["WBTC", "WETH"] },
  { headline: "HashKey ecosystem fund allocates $100M for DeFi projects", sentiment: "bullish", impact: "high", tokens: ["HSK"] },
  { headline: "Bitcoin mining difficulty reaches record high", sentiment: "neutral", impact: "low", tokens: ["WBTC"] },
  { headline: "Stablecoin depegging concerns cause brief market dip", sentiment: "bearish", impact: "high", tokens: ["WBTC", "WETH", "HSK"] },
  { headline: "New Layer-2 solution reduces swap fees by 80%", sentiment: "bullish", impact: "medium", tokens: ["WETH"] },
  { headline: "Institutional investors increase crypto allocations by 40%", sentiment: "bullish", impact: "high", tokens: ["WBTC", "WETH"] },
  { headline: "Cross-chain bridge vulnerability discovered, patched", sentiment: "bearish", impact: "medium", tokens: ["WETH", "HSK"] },
  { headline: "TALPHA token listed on major centralized exchange", sentiment: "bullish", impact: "high", tokens: ["TALPHA"] },
  { headline: "TBETA protocol launches new governance proposal", sentiment: "neutral", impact: "low", tokens: ["TBETA"] },
  { headline: "Large sell wall detected on TALPHA/tUSDT pair", sentiment: "bearish", impact: "medium", tokens: ["TALPHA"] },
  { headline: "TBETA liquidity mining rewards doubled for Q4", sentiment: "bullish", impact: "medium", tokens: ["TBETA"] },
  { headline: "Arbitrage opportunity window widening on HSK DEX pools", sentiment: "bullish", impact: "medium", tokens: ["TALPHA", "TBETA"] },
  { headline: "Market-wide flash crash: prices recover within minutes", sentiment: "bearish", impact: "high", tokens: ["TALPHA", "TBETA", "HSK"] },
  { headline: "On-chain analytics show accumulation pattern for TALPHA", sentiment: "bullish", impact: "medium", tokens: ["TALPHA"] },
  { headline: "DEX trading volume spikes 300% on HashKey Chain", sentiment: "bullish", impact: "high", tokens: ["HSK", "TALPHA", "TBETA"] },
];

let lastNewsTime = 0;
const NEWS_INTERVAL_MS = 45_000;

function generateNews() {
  const now = Date.now();
  if (now - lastNewsTime < NEWS_INTERVAL_MS) return null;

  if (Math.random() < 0.35) return null;

  lastNewsTime = now;
  const template = CRYPTO_NEWS_TEMPLATES[Math.floor(Math.random() * CRYPTO_NEWS_TEMPLATES.length)];

  const news = {
    id: `news_${now}`,
    headline: template.headline,
    sentiment: template.sentiment,
    impact: template.impact,
    tokens: template.tokens,
    timestamp: new Date().toISOString(),
    source: pickSource(),
  };

  newsHistory.push(news);
  if (newsHistory.length > MAX_NEWS) newsHistory.splice(0, newsHistory.length - MAX_NEWS);

  return news;
}

function pickSource() {
  const sources = ["CryptoWatch", "DeFi Pulse", "ChainNews", "BlockBeats", "HSK Daily", "TokenInsight", "On-Chain Alert", "Whale Tracker"];
  return sources[Math.floor(Math.random() * sources.length)];
}

function getRecentNews(count = 5) {
  return newsHistory.slice(-count);
}

function getNewsSummaryForAgent() {
  const recent = getRecentNews(5);
  if (recent.length === 0) return null;

  return recent.map(n => ({
    headline: n.headline,
    sentiment: n.sentiment,
    impact: n.impact,
    affectedTokens: n.tokens,
    source: n.source,
    age: `${((Date.now() - new Date(n.timestamp).getTime()) / 60000).toFixed(1)}min ago`,
  }));
}

module.exports = { generateNews, getRecentNews, getNewsSummaryForAgent };
