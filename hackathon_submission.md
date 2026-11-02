# SynapseFi — AI Trading Agent on HashKey Chain

**Autonomous AI trading agent that combines triangular arbitrage detection across Uniswap V3 pools with news-driven directional trading — all executed on-chain through AgentVault smart contract with real-time risk enforcement.**

## The Problem

Crypto trading requires 24/7 monitoring, fast execution, and disciplined risk management — things humans struggle with. Most retail traders lose money due to emotional decisions, slow reaction times, and inability to monitor markets around the clock. Meanwhile, triangular arbitrage opportunities across DEX pools appear and disappear in seconds — too fast for manual execution.

## How It Works

An autonomous AI agent (powered by Claude via OpenRouter) receives the full system state every ~30 seconds — live pool prices, portfolio, open positions, triangular arbitrage opportunities, and real-time news — and outputs executable multi-step action plans in JSON. The agent doesn't follow rigid rules; it reasons through each situation, explains its logic, and adapts its strategy dynamically.

**Two trading modes working simultaneously:**
- **Triangular Arbitrage** — Scans all 3-pool cycles (e.g., tUSDT → TALPHA → TBETA → tUSDT), calculates profit after fees, and executes profitable routes via multi-hop `exactInput` swaps
- **Directional Trading** — AI reads news sentiment (bullish/bearish/neutral) and executes buy/sell trades on tokens showing strong catalysts

All trades are routed through **AgentVault**, a custom smart contract that enforces risk limits on-chain: max position size, daily loss cap, trade cooldown, and router whitelisting. The owner deposits funds and sets limits; the AI agent can only trade within those constraints — it can never withdraw or loosen limits.

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
- **7 verified on-chain transactions** across 2 live test sessions
- Triangular arbitrage: tUSDT → TALPHA → TBETA → tUSDT via multi-hop `exactInput`
- Directional trades: AI buys/sells tokens based on news sentiment analysis
- All routed through AgentVault smart contract

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
- Dynamic cycle timing (15–120s) based on market activity

### Chat Control — Natural Language Agent Interface
Talk to your AI agent in real-time through the dashboard chat panel:
- **Built-in Commands** — `status`, `balance`, `positions`, `history`, `arb`, `limits`, `pause`, `resume`, `help`
- **Natural Language** — Ask questions like "how is my portfolio doing?", "why did you sell TALPHA?", "show me arb opportunities"
- **Pause/Resume Trading** — Control the agent directly from chat: type `pause` to stop trading, `resume` to restart
- **Agent Reasoning** — Ask "why" to see the agent's last decision reasoning and chain-of-thought
- **Real-Time Responses** — Agent processes commands and returns live data from the system state

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

### Test Session 1: 5-Minute Arb-Only Run
| Metric | Result |
|--------|--------|
| Duration | 5 minutes |
| Agent Cycles | 18 |
| Arb Executions | 5 on-chain transactions |
| Starting Balance | $10,000.00 |
| **Total Profit** | **+$120.06 (+1.2%)** |
| Strategy | Defensive (bearish news → arb only) |

### Test Session 2: Arb + Directional Trading
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

## Tech Stack

- **Blockchain** — HashKey Chain Testnet (EVM, Chain ID 133)
- **DEX** — Uniswap V3 (full deployment: Factory, SwapRouter, NPM)
- **Smart Contracts** — Solidity 0.7.6 / 0.8.24, Hardhat, OpenZeppelin
- **AI** — Claude (via OpenRouter API) with structured JSON output
- **Backend** — Node.js, Express, ethers.js v6, Server-Sent Events
- **Frontend** — Single-page dashboard with EIP-6963 wallet discovery
- **Testing** — Hardhat + Chai (21 contract tests)

## What Makes This Different

1. **Real on-chain execution** — not paper trading or simulations. 7 verified testnet transactions.
2. **AI reasons, doesn't just execute rules** — chain-of-thought reasoning visible on dashboard, adapts strategy to market conditions and news.
3. **On-chain risk enforcement** — AgentVault contract means the AI can never exceed risk limits, even if compromised. Owner always retains control.
4. **Full-stack DeFi** — deployed our own DEX, tokens, pools, vault, and trading infrastructure on HSK Chain.
