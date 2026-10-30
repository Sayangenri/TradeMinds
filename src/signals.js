const config = require("./config");
const history = require("./history");

let Anthropic;
try { Anthropic = require("@anthropic-ai/sdk"); } catch { Anthropic = null; }

async function callOpenRouter(prompt) {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.AI_MODEL,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.choices[0].message.content.trim();
}

async function callAnthropic(prompt) {
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const resp = await client.messages.create({
    model: config.AI_MODEL,
    max_tokens: 200,
    messages: [{ role: "user", content: prompt }],
  });
  return resp.content[0].text.trim();
}

function ruleBased(poolName) {
  const s30 = history.getStats(poolName, 30);
  const s5  = history.getStats(poolName, 5);
  if (!s30 || !s5) return { action: "hold", reason: "Not enough data yet", confidence: 0 };

  if (s5.changePct <= -1.0 && s30.volatility > 0.3) {
    return { action: "buy", reason: `Mean reversion: ${s5.changePct.toFixed(2)}% drop in 5min, vol ${s30.volatility.toFixed(2)}%`, confidence: 0.6 };
  }
  if (s5.changePct >= 1.5 && s30.volatility > 0.3) {
    return { action: "sell", reason: `Take profit: ${s5.changePct.toFixed(2)}% rise in 5min`, confidence: 0.6 };
  }
  if (s30.volatility < 0.05) {
    return { action: "hold", reason: `Low volatility (${s30.volatility.toFixed(3)}%), no opportunity`, confidence: 0.8 };
  }

  return { action: "hold", reason: `No clear signal (5m: ${s5.changePct.toFixed(2)}%, vol: ${s30.volatility.toFixed(2)}%)`, confidence: 0.5 };
}

function hasAI() {
  if (config.AI_PROVIDER === "openrouter" && config.OPENROUTER_API_KEY) return true;
  if (config.ANTHROPIC_API_KEY && Anthropic) return true;
  return false;
}

async function aiSignal(poolName) {
  if (!hasAI()) {
    return { ...ruleBased(poolName), source: "rule-based" };
  }

  const stats30 = history.getStats(poolName, 30);
  const stats60 = history.getStats(poolName, 60);
  const prices  = history.getPriceArray(poolName, 60, 20);

  if (!stats30) return { action: "hold", reason: "Insufficient data for AI", confidence: 0, source: "ai-skipped" };

  const prompt = `You are a trading signal engine for a DEX (decentralized exchange) trading bot.
Analyze this market data and return a JSON object with: action ("buy"|"sell"|"hold"), reason (1 sentence), confidence (0-1).

Pool: ${poolName}
Current price: $${stats30.latest.toFixed(6)}
30min stats: change ${stats30.changePct.toFixed(3)}%, volatility ${stats30.volatility.toFixed(3)}%, min $${stats30.min.toFixed(6)}, max $${stats30.max.toFixed(6)}, samples: ${stats30.samples}
${stats60 ? `60min stats: change ${stats60.changePct.toFixed(3)}%, volatility ${stats60.volatility.toFixed(3)}%` : "60min stats: not available yet"}
Recent prices (oldest→newest): [${prices.map(p => p.toFixed(6)).join(", ")}]

Rules:
- Only recommend buy/sell when confidence > 0.6
- This is a low-liquidity DEX; slippage and gas matter
- Conservative approach: prefer hold when uncertain
- Consider mean reversion, momentum, and volatility patterns

Return ONLY valid JSON, no markdown.`;

  try {
    let text = config.AI_PROVIDER === "openrouter"
      ? await callOpenRouter(prompt)
      : await callAnthropic(prompt);
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const signal = JSON.parse(text);
    return {
      action: signal.action || "hold",
      reason: signal.reason || "AI signal",
      confidence: signal.confidence || 0,
      source: "ai",
    };
  } catch (e) {
    console.error("  AI signal error:", e.message);
    return { ...ruleBased(poolName), source: "rule-fallback" };
  }
}

async function getSignals(poolNames) {
  const results = {};
  for (const name of poolNames) {
    results[name] = await aiSignal(name);
  }
  return results;
}

module.exports = { getSignals, ruleBased, aiSignal };
