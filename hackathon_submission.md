# TradeMinds — AI Agent Trading Bot on HashKey Chain

**Autonomous AI trading agent that combines triangular arbitrage detection across Uniswap V3 pools with news-driven directional trading — all executed on-chain through AgentVault smart contract with real-time risk enforcement.**

## The Problem

Crypto trading requires 24/7 monitoring, fast execution, and disciplined risk management — things humans struggle with. Most retail traders lose money due to emotional decisions, slow reaction times, and inability to monitor markets around the clock. Meanwhile, triangular arbitrage opportunities across DEX pools appear and disappear in seconds — too fast for manual execution.

## How It Works

An autonomous AI agent (powered by DeepSeek via OpenRouter) receives the full system state every ~30 seconds — live pool prices, portfolio, open positions, triangular arbitrage opportunities, and real-time news — and outputs executable multi-step action plans in JSON. The agent doesn't follow rigid rules; it reasons through each situation, explains its logic, and adapts its strategy dynamically.

**Two trading modes working simultaneously:**
- **Triangular Arbitrage** — Scans all 3-pool cycles (e.g., tUSDT → TALPHA → TBETA → tUSDT), calculates profit after fees, and executes profitable routes via multi-hop `exactInput` swaps through AgentVault
- **Directional Trading** — AI reads news sentiment (bullish/bearish/neutral) and executes buy/sell trades on tokens showing strong catalysts with >1% expected price movement

All trades are routed through **AgentVault**, a custom smart contract that enforces risk limits on-chain: max position size, daily loss cap, trade cooldown, and router whitelisting. The owner deposits funds and sets limits; the AI agent can only trade within those constraints — it can never withdraw or loosen limits.

**How Triangular Arbitrage Makes Profit:**
```
Pool prices:  TALPHA/tUSDT = $2.509  |  TBETA/tUSDT = $1.017  |  TALPHA/TBETA = 2.577

Implied cross-rate: 2.509 ÷ 1.017 = 2.467
Actual TALPHA/TBETA pool price: 2.577
Price gap: ~4.5% → TALPHA is overpriced in the TALPHA/TBETA pool

Step 1: Buy TALPHA cheap     → 200 tUSDT → 79.47 TALPHA    (TALPHA/tUSDT pool)
Step 2: Sell TALPHA expensive → 79.47 TALPHA → 204.21 TBETA (TALPHA/TBETA pool — overpriced)
Step 3: Cash out             → 204.21 TBETA → 200.26 tUSDT  (TBETA/tUSDT pool)

Gain: ~1.03% from price gap
Cost: ~0.9% in fees (0.3% × 3 hops)
Net profit: +$0.26 per round trip (0.13%)
```

**Architecture:**
```
User (Owner) → Deposits into AgentVault → AI Agent trades via vault → Uniswap V3 Pools on HSK
```

## Key Features

### Dual-Mode Trading: Triangular Arbitrage + Directional
One unified AI agent that does both simultaneously — not a separate arb bot and trading bot. Every cycle, it can:
- Execute triangular arb routes while buying a token on bullish news
- Close a losing position while triggering a new arb scan
- Hold all positions if the market is quiet — doing nothing is a valid strategy

### On-Chain Execution (HSK Testnet)
- **10 verified on-chain transactions** across 3 live test sessions
- Triangular arbitrage: tUSDT → TALPHA → TBETA → tUSDT via multi-hop `exactInput`
- Directional trades: AI buys/sells tokens based on news sentiment analysis
- All routed through AgentVault smart contract — zero losses

### AgentVault — On-Chain Risk Enforcement
- Smart contract vault with owner/agent role separation
- Max position size, daily loss cap, cooldown timer enforced on-chain
- Agent can tighten limits but never loosen them
- Emergency withdraw always available to owner, even when paused
- 21 Hardhat tests covering security and access control

### AI Brain with Chain-of-Thought Reasoning
- Every decision includes visible reasoning displayed live on dashboard
- Strategy adaptation: aggressive, defensive, neutral based on market conditions
- News-reactive trading with sentiment analysis (bullish/bearish/neutral)
- Profit-first rules: prioritize arb over directional trades, never trade in flat markets
- Dynamic cycle timing (15–120s) based on market activity

### Chat Control — Natural Language Agent Interface
Talk to your AI agent in real-time through the dashboard chat panel:
- **Built-in Commands** — `status`, `balance`, `positions`, `history`, `arb`, `limits`, `pause`, `resume`, `help`
- **Natural Language** — Ask questions like "how is my portfolio doing?", "why did you sell TALPHA?", "show me arb opportunities"
- **Pause/Resume Trading** — Control the agent directly from chat
- **Agent Reasoning** — Ask "why" to see the agent's last decision reasoning

### Live Dashboard with Wallet Connect
- Real-time web UI with Server-Sent Events (SSE) for instant updates
- MetaMask/OKX wallet connection via EIP-6963 discovery
- Vault management: deposit, withdraw, emergency withdraw, pause/unpause
- Trade history panel with P&L tracking and win rate
- AI Brain panel showing live reasoning, strategy, and market assessment
- Arbitrage monitor, position tracker, news feed, activity log

### Full DEX Deployment
- Complete Uniswap V3 DEX deployed on HSK Testnet (Chain 133)
- UniswapV3Factory, SwapRouter, NonfungiblePositionManager
- 3 test tokens (TALPHA, TBETA, tUSDT) with 3 liquidity pools
- Market maker script for realistic on-chain price movement

## Live Test Results

### Latest Session: 100% Win Rate Arb Run

| Metric | Result |
|--------|--------|
| **Net Profit** | **+$0.79** |
| **Win Rate** | **100% (3/3 trades)** |
| **Losses** | **0** |
| Agent Cycles | 10 AI decision cycles |
| Strategy | Triangular Arbitrage via AgentVault |
| Mode | Fully on-chain (no paper trading) |

| # | Tx Hash | Profit | Route |
|---|---------|--------|-------|
| 1 | `0x9aeaaed1e3b3a701868121da2684fcd03dcc8783a2193a768d77e697227b6d67` | +$0.26 | tUSDT → TALPHA → TBETA → tUSDT |
| 2 | `0x0a78472e9adc2c6c452745edbb72ce770e92137ca84746d2a94b7157b852048f` | +$0.26 | TBETA → tUSDT → TALPHA → TBETA |
| 3 | `0x5f730e0ee0879c203b2ea651090b52a3b31271d19e88f2a9453ad1fe337ae209` | +$0.26 | TBETA → tUSDT → TALPHA → TBETA |

### Dashboard Screenshots

![Dashboard — AI Brain, Live Prices, Portfolio](screenshots/dashboard-top.jpg)
*Live dashboard showing AI agent reasoning (Cycle #10), real-time pool prices, and portfolio with +$0.79 P&L*

![Dashboard — Trade History with On-Chain Tx Hashes](screenshots/dashboard-trades.jpg)
*Trade history showing 3 successful triangular arb trades via AgentVault, each with verifiable on-chain tx hash, 100% win rate*

### Earlier Sessions

**Session 1: 5-Minute Arb-Only Run**
| Metric | Result |
|--------|--------|
| Duration | 5 minutes |
| Agent Cycles | 18 |
| Arb Executions | 5 on-chain transactions |
| Starting Balance | $10,000.00 |
| **Total Profit** | **+$120.06 (+1.2%)** |
| Strategy | Defensive (bearish news → arb only) |

**Session 2: Arb + Directional Trading**
| Metric | Result |
|--------|--------|
| Arb Executions | 1 on-chain (0.42% profit) |
| Directional Trade | BUY TALPHA via vault (bullish accumulation news) |
| Strategy | Aggressive (bullish news → buy + arb) |

### All On-Chain Transaction Hashes (HSK Testnet)

| # | Type | Hash |
|---|------|------|
| 1 | ARB | `0x06a46cc85beea5fad2c848d77ad2376694a57349c8363db3f2e5b4c6c3bf096e` |
| 2 | ARB | `0xf6ee5e687fe976aeb8ea521fd56443691c125a1529873fab8333fd752f5cae1f` |
| 3 | ARB | `0x33b4bafc7c0c87ca0124429a93fae2e9a61398cc508d3448f9f873449090b214` |
| 4 | ARB | `0xcc876f4c73de5fd785e40cf892ee44c9f92205415de839b84e8600f8867da5b3` |
| 5 | ARB | `0x3574a5319c283f33f58fca636cc38c3b8c47ceba29f7542ad1370a7a0925a3e3` |
| 6 | ARB | `0x18691be038156c4adc0db34a3366f278be58873c9ee7e8b86adcfc502b287d8e` |
| 7 | BUY | `0x5f4cc05cf48ea4af0a4387a59ce5322865d73c7aeb1237b3557a59b73b8d1aab` |
| 8 | ARB | `0x9aeaaed1e3b3a701868121da2684fcd03dcc8783a2193a768d77e697227b6d67` |
| 9 | ARB | `0x0a78472e9adc2c6c452745edbb72ce770e92137ca84746d2a94b7157b852048f` |
| 10 | ARB | `0x5f730e0ee0879c203b2ea651090b52a3b31271d19e88f2a9453ad1fe337ae209` |

## Deployed Contracts (HSK Testnet — Chain 133)

| Contract | Address |
|----------|---------|
| UniswapV3Factory | `0xB862231b343231E456DF47E520b57e32AE079dD6` |
| SwapRouter | `0xe4f185a337211019ac116f35267c932979Edd5e7` |
| NonfungiblePositionManager | `0x628f0750881A90eB26bd30775E00a3eB3811dbb5` |
| AgentVault | `0xd980018422ee5b535e107b0Feb66a04438d30a4e` |
| TALPHA | `0x747e0179896617E3AcEC745BEEb22696fc849848` |
| TBETA | `0xe326f0606E27c34a29DEB9E72a0cCdecA6cA6593` |
| tUSDT | `0x7de25caAc85194219bAbbDC2106c49fF91784cB6` |

### Liquidity Pools

| Pool | Address |
|------|---------|
| TALPHA/tUSDT | `0x6133D76B308556eE4115B5ED2BD59c03f260867a` |
| TBETA/tUSDT | `0x3cA388AC01b332b09EFC00D87eBFDDFdA0749Bc2` |
| TALPHA/TBETA | `0xC28Cb933EE9411e6B5e18736CbacF2d01c9D263d` |

## Tech Stack

- **Blockchain** — HashKey Chain Testnet (EVM, Chain ID 133)
- **DEX** — Uniswap V3 (full deployment: Factory, SwapRouter, NPM)
- **Smart Contracts** — Solidity 0.7.6 / 0.8.24, Hardhat, OpenZeppelin
- **AI** — DeepSeek (via OpenRouter API) with structured JSON output
- **Backend** — Node.js, Express, ethers.js v6, Server-Sent Events
- **Frontend** — Single-page dashboard with EIP-6963 wallet discovery
- **Testing** — Hardhat + Chai (21 contract tests)
- **Explorer** — [HSK Testnet Explorer](https://testnet-explorer.hskchain.net)

## What Makes TradeMinds Different

1. **Real on-chain execution** — not paper trading or simulations. 10 verified testnet transactions with 100% win rate on latest session.
2. **AI reasons, doesn't just execute rules** — chain-of-thought reasoning visible on dashboard, adapts strategy to market conditions and news.
3. **On-chain risk enforcement** — AgentVault contract means the AI can never exceed risk limits, even if compromised. Owner always retains control.
4. **Profit-first strategy** — Agent prioritizes risk-free arbitrage, only takes directional trades when strong catalysts + price momentum confirm. Zero losses in latest test.
5. **Full-stack DeFi** — deployed our own DEX, tokens, pools, vault, and trading infrastructure on HSK Chain.
6. **Natural language control** — Chat with your AI agent in real-time to query portfolio, pause trading, or ask why it made a decision.
