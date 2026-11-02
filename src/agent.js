const config = require("./config");
const history = require("./history");
const risk = require("./risk");
const { scanArbitrage, getPoolPrice } = require("./arb");
const { execute, executeArbLive } = require("./executor");
const { runUserArbs } = require("./userVaults");
const { nextPrice, isSimulating } = require("./simulator");
const { readPool } = require("./chain");
const { getNewsSummaryForAgent } = require("./news");

const actionLog = [];
const MAX_LOG = 200;

function log(entry) {
  entry.ts = Date.now();
  actionLog.push(entry);
  if (actionLog.length > MAX_LOG) actionLog.splice(0, actionLog.length - MAX_LOG);
}

function getActionLog() { return actionLog; }

function gatherSystemState(prices, arbOpportunities) {
  const riskState = risk.getState();
  const marketStats = history.getAllStats(30);
  const recentTrades = riskState.closedToday.slice(-5);

  const positionsSummary = riskState.positions.map(p => ({
    token: p.token,
    entry: p.entryPrice.toFixed(6),
    current: p.currentPrice.toFixed(6),
    pnl: `$${p.unrealizedPnl.toFixed(2)} (${p.unrealizedPct.toFixed(1)}%)`,
    stopLoss: p.stopLoss.toFixed(6),
    takeProfit: p.takeProfit.toFixed(6),
    holdingTime: `${((Date.now() - p.openedAt) / 60000).toFixed(1)}min`,
  }));

  const marketSummary = {};
  for (const [name, st] of Object.entries(marketStats)) {
    marketSummary[name] = {
      price: `$${st.latest.toFixed(6)}`,
      change30m: `${st.changePct.toFixed(3)}%`,
      volatility: `${st.volatility.toFixed(3)}%`,
      range: `$${st.min.toFixed(6)} – $${st.max.toFixed(6)}`,
      samples: st.samples,
    };
  }

  const arbSummary = (arbOpportunities || []).slice(0, 3).map(opp => ({
    profit: `$${opp.profit.toFixed(2)} (${opp.profitPct.toFixed(2)}%)`,
    steps: opp.steps.map(s => `${s.pool}: ${s.in} → ${s.out}`),
  }));

  const recentTradesSummary = recentTrades.map(t => ({
    token: t.token,
    action: t.pnl >= 0 ? "profit" : "loss",
    pnl: `$${t.pnl.toFixed(2)} (${t.pnlPct.toFixed(1)}%)`,
    reason: t.reason,
  }));

  const newsSummary = getNewsSummaryForAgent();

  return {
    timestamp: new Date().toISOString(),
    mode: config.MODE,
    news: newsSummary,
    portfolio: {
      balance: `$${riskState.balance.toFixed(2)}`,
      openValue: `$${riskState.openValue.toFixed(2)}`,
      totalValue: `$${riskState.totalValue.toFixed(2)}`,
      dailyPnl: `$${riskState.dailyPnl.toFixed(2)}`,
      totalPnl: `$${riskState.totalPnl.toFixed(2)}`,
      totalTrades: riskState.totalTrades,
      openPositions: riskState.positions.length,
      maxPositions: config.MAX_OPEN_POSITIONS,
      onChainBalances: riskState.onChainBalances || {},
    },
    positions: positionsSummary,
    market: marketSummary,
    arbitrage: arbSummary,
    recentTrades: recentTradesSummary,
    riskLimits: {
      maxPositionPct: config.MAX_POSITION_PCT,
      stopLossPct: config.STOP_LOSS_PCT,
      takeProfitPct: config.TAKE_PROFIT_PCT,
      dailyLossLimitPct: config.DAILY_LOSS_LIMIT_PCT,
    },
  };
}

function buildAgentPrompt(systemState) {
  return `You are an autonomous AI trading agent managing a DeFi portfolio on HashKey Chain (Uniswap V3 pools).

You are THE DECISION MAKER. You see the full system state and decide what actions to take. You don't just give signals — you issue executable commands.

## CURRENT SYSTEM STATE
${JSON.stringify(systemState, null, 2)}

## YOUR CAPABILITIES (available actions)
You can issue multiple actions per decision cycle. Return a JSON object with:
- "reasoning": Your chain-of-thought analysis (2-3 sentences explaining your logic)
- "strategy": Current strategy assessment ("aggressive" | "defensive" | "neutral")
- "actions": Array of action objects, each with:
  - {"type": "trade", "action": "buy"|"sell", "pool": "<pool name>", "confidence": 0-1, "reason": "..."}
  - {"type": "execute_arb", "route_index": 0, "reason": "..."}  (execute detected arb opportunity)
  - {"type": "close_position", "token": "<token>", "reason": "..."}  (manually close a position)
  - {"type": "adjust_risk", "param": "stop_loss"|"take_profit", "token": "<token>", "value": <number>, "reason": "..."}
  - {"type": "hold", "reason": "..."}  (explicitly decide to do nothing)
  - {"type": "scan_arb", "reason": "..."}  (trigger an arb scan now)
- "next_check_seconds": How soon to run the next decision cycle (15-120)
- "market_assessment": One sentence on the current market condition

## CRITICAL: PROFIT-FIRST RULES
- This is a TESTNET — gas fees are essentially zero. Even small arbitrage profits are worth executing.
- ARBITRAGE is your primary profit source. ALWAYS execute profitable arb routes immediately — they are risk-free and gas-free on testnet.
- Each swap costs 0.3% in pool fees. A buy+sell round trip costs ~0.6%. NEVER enter a directional trade unless you expect at least 1% price movement.
- Directional trades are SECONDARY. Only buy/sell when volatility is high AND there is a strong catalyst.
- In flat/low-volatility markets: execute arb if available, otherwise HOLD.
- NEVER close a position at a loss unless it hits stop-loss.
- If recent trades lost money, switch to DEFENSIVE and only do arb until you recover.

## NEWS-DRIVEN TRADING
If the "news" field contains recent headlines, factor them into your decisions:
- HIGH impact BULLISH news on a token → consider buying ONLY if price shows momentum (change > 0.3%)
- HIGH impact BEARISH news on a token → avoid buying, consider closing existing positions
- Reference the specific headline in your reasoning when news influences a decision
- News alone is NOT enough to trade — you also need price movement or arb opportunity

## DECISION RULES
1. ALWAYS provide reasoning before actions — explain your thought process
2. You can issue multiple actions (e.g., close one position AND open another AND execute an arb)
3. PRIORITY ORDER: execute arb > hold profitable positions > close at take-profit > open new trade
4. For arb: if ANY profitable opportunity exists (even 0.01%), ALWAYS execute it — gas is free on testnet
5. For trades: only trade when confidence > 0.7 AND price volatility > 0.3%
6. NEVER sell at a loss unless stop-loss is hit — hold and wait for recovery
7. If volatility is low and no arb, say "hold" — being idle is the correct strategy
8. When news is present, mention it in your reasoning — show that you read and reacted to it
9. Prefer fewer, higher-quality trades over many small trades

Return ONLY valid JSON. No markdown, no code fences.`;
}

async function callAI(prompt) {
  if (config.AI_PROVIDER === "openrouter" && config.OPENROUTER_API_KEY) {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.AI_MODEL,
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) throw new Error(`OpenRouter ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return data.choices[0].message.content.trim();
  }

  if (config.ANTHROPIC_API_KEY) {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: config.AI_MODEL,
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });
    return resp.content[0].text.trim();
  }

  throw new Error("No AI provider configured");
}

function fallbackDecision(systemState) {
  const actions = [];
  const reasoning = [];

  if (systemState.arbitrage.length > 0) {
    reasoning.push(`Found ${systemState.arbitrage.length} arb opportunities.`);
    actions.push({ type: "execute_arb", route_index: 0, reason: "Profitable arb detected" });
  }

  for (const [name, m] of Object.entries(systemState.market)) {
    const change = parseFloat(m.change30m);
    const vol = parseFloat(m.volatility);

    if (change <= -1.0 && vol > 0.3) {
      actions.push({ type: "trade", action: "buy", pool: name, confidence: 0.65, reason: `Mean reversion: ${m.change30m} drop` });
      reasoning.push(`${name} dropped ${m.change30m}, mean reversion signal.`);
    } else if (change >= 1.5 && vol > 0.3) {
      actions.push({ type: "trade", action: "sell", pool: name, confidence: 0.65, reason: `Take profit: ${m.change30m} rise` });
      reasoning.push(`${name} up ${m.change30m}, taking profit.`);
    }
  }

  if (actions.length === 0) {
    actions.push({ type: "hold", reason: "No clear signals, staying defensive" });
    reasoning.push("Markets quiet, holding positions.");
  }

  return {
    reasoning: reasoning.join(" "),
    strategy: "neutral",
    actions,
    next_check_seconds: 30,
    market_assessment: "Rule-based fallback — AI unavailable",
  };
}

async function runAgentCycle(prices, arbOpportunities) {
  const systemState = gatherSystemState(prices, arbOpportunities);

  log({ type: "cycle_start", state: systemState });

  let decision;
  try {
    const prompt = buildAgentPrompt(systemState);
    let text = await callAI(prompt);
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    decision = JSON.parse(text);
    decision.source = "ai";
  } catch (e) {
    console.error(`  Agent AI error: ${e.message}`);
    decision = fallbackDecision(systemState);
    decision.source = "fallback";
  }

  log({ type: "decision", decision });

  console.log(`\n  🤖 AGENT REASONING: ${decision.reasoning}`);
  console.log(`  📊 Strategy: ${decision.strategy} | Source: ${decision.source}`);
  console.log(`  🌐 Market: ${decision.market_assessment}`);

  const results = [];
  for (const action of decision.actions) {
    try {
      const result = await executeAction(action, prices, arbOpportunities);
      results.push(result);
      log({ type: "action_result", action, result });
    } catch (e) {
      console.error(`  Action failed: ${e.message}`);
      log({ type: "action_error", action, error: e.message });
      results.push({ executed: false, reason: e.message });
    }
  }

  return {
    decision,
    results,
    systemState,
    nextCheckMs: (decision.next_check_seconds || 30) * 1000,
  };
}

async function executeAction(action, prices, arbOpportunities) {
  switch (action.type) {
    case "trade": {
      const token = action.pool.split("/")[0];
      const price = prices[token];
      if (!price) return { executed: false, reason: `No price for ${token}` };
      const signal = { action: action.action, confidence: action.confidence || 0.7, reason: action.reason };
      const result = await execute(signal, action.pool, price);
      if (result.executed) {
        console.log(`  ✅ TRADE: ${result.action.toUpperCase()} ${result.token} @ $${price.toFixed(6)} | ${result.mode}`);
      } else {
        console.log(`  ⏭️  Skipped ${action.pool}: ${result.reason}`);
      }
      return result;
    }

    case "execute_arb": {
      const idx = action.route_index || 0;
      if (!arbOpportunities || !arbOpportunities[idx]) {
        console.log("  ⏭️  No arb opportunity at index", idx);
        return { executed: false, reason: "No arb opportunity available" };
      }
      const opp = arbOpportunities[idx];
      // Users' vault balances trade first so the house trade doesn't eat their edge.
      const userArbs = await runUserArbs(arbOpportunities);
      console.log(`  🔄 EXECUTING ARB: $${opp.profit.toFixed(2)} profit (${opp.profitPct.toFixed(2)}%)`);
      for (const step of opp.steps) {
        console.log(`     ${step.pool}: ${step.in} → ${step.out}`);
      }
      const arbResult = await executeArbLive(opp);
      if (arbResult.executed) {
        console.log(`  💰 ARB LIVE TX: ${arbResult.txHash}`);
      } else {
        console.log(`  ❌ ARB FAILED: ${arbResult.reason}`);
      }
      return { ...arbResult, userArbs };
    }

    case "close_position": {
      const price = prices[action.token];
      if (!price) return { executed: false, reason: `No price for ${action.token}` };
      const result = risk.closePosition(action.token, price, action.reason || "agent-close");
      if (result) {
        console.log(`  🔴 CLOSED ${action.token} @ $${price.toFixed(6)} | PnL: $${result.pnl.toFixed(2)} (${result.pnlPct.toFixed(1)}%) | ${action.reason}`);
        return { executed: true, ...result };
      }
      return { executed: false, reason: `No position in ${action.token}` };
    }

    case "adjust_risk": {
      const pos = risk.getState().positions.find(p => p.token === action.token);
      if (!pos) return { executed: false, reason: `No position in ${action.token}` };
      if (action.param === "stop_loss") {
        pos.stopLoss = action.value;
        console.log(`  ⚙️  Adjusted ${action.token} stop-loss to $${action.value.toFixed(6)}`);
      } else if (action.param === "take_profit") {
        pos.takeProfit = action.value;
        console.log(`  ⚙️  Adjusted ${action.token} take-profit to $${action.value.toFixed(6)}`);
      }
      return { executed: true, action: "adjust_risk", token: action.token, param: action.param, value: action.value };
    }

    case "scan_arb": {
      console.log("  🔍 Agent triggered arb scan");
      const poolAddrs = config.POOLS.map(p => p.addr);
      const opps = await scanArbitrage(poolAddrs, 200);
      return { executed: true, action: "scan_arb", opportunities: opps.length, found: opps };
    }

    case "hold":
      console.log(`  ⏸️  HOLD: ${action.reason}`);
      return { executed: true, action: "hold", reason: action.reason };

    default:
      return { executed: false, reason: `Unknown action type: ${action.type}` };
  }
}

module.exports = { runAgentCycle, gatherSystemState, getActionLog, log };
