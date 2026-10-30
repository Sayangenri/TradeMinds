# AI Agent Trading Bot — HashKey Chain

An autonomous AI-powered trading bot deployed on HashKey Chain (HSK). The AI agent monitors markets, reads news, detects arbitrage, executes on-chain swaps, and manages risk — all without human intervention.

## Dual-Mode Trading: Trading + Arbitrage in One Agent

This is not a separate trading bot and arb bot — it's **one unified AI agent** that does both simultaneously. Every decision cycle (~30s), the agent receives the full system state and can issue multiple actions at once:

- **Execute an arb route** while simultaneously **buying a token** on bullish news
- **Close a losing position** while **triggering a new arb scan**
- **Hold all positions** if the market is quiet — doing nothing is a valid strategy

The AI decides the optimal mix of trading and arbitrage based on real-time conditions. It doesn't follow rigid rules — it reasons through each situation and adapts.

## Features

### AI Agent Core
- **Autonomous Decision Making** — AI receives full system state (prices, portfolio, positions, news, arb opportunities) and outputs executable multi-step action plans
- **Chain-of-Thought Reasoning** — Every decision includes visible reasoning explaining the agent's logic, displayed live on the dashboard
- **Strategy Adaptation** — Agent dynamically switches between aggressive, defensive, and neutral strategies based on market conditions and recent performance
- **Dynamic Cycle Timing** — Agent decides its own check interval (15–120s) based on market activity

### On-Chain Trading (HSK Testnet)
- **Real Swap Execution** — Executes actual token swaps through Uniswap V3 SwapRouter on-chain
- **Triangular Arbitrage Execution** — Detects and executes 3-pool arb routes (e.g., tUSDT → TALPHA → TBETA → tUSDT) via multi-hop `exactInput`
- **Live Price Reads** — Reads real `slot0()` prices from deployed V3 pools every 5 seconds
- **Token Approval Management** — Automated ERC20 approval flow for all traded tokens
- **On-Chain Balance Tracking** — Reads real ERC20 wallet balances from chain

### Deployed Smart Contracts
- Full Uniswap V3 DEX deployed on HSK Testnet (Chain 133)
- **UniswapV3Factory** — Pool creation
- **SwapRouter** — Trade execution
- **NonfungiblePositionManager** — Liquidity management
- **3 Test Tokens** — TALPHA (18 dec), TBETA (18 dec), tUSDT (6 dec)
- **3 Liquidity Pools** — TALPHA/tUSDT, TBETA/tUSDT, TALPHA/TBETA

### Arbitrage Detection
- **Triangular Route Scanning** — Finds all profitable 3-pool cycles across deployed pools
- **Real-Time Profit Calculation** — Accounts for pool fees (0.3% per hop) and slippage
- **Auto-Execution** — Agent triggers arb when profitable routes are found

### News-Driven Trading
- **Simulated News Feed** — 28 crypto news templates with headline, sentiment, impact level, and affected tokens
- **Sentiment Analysis** — Bullish/bearish/neutral classification with high/medium/low impact scoring
- **News-Reactive Trading** — Agent factors news sentiment into buy/sell decisions with confidence adjustments
- **Real-Time News Display** — News feed on dashboard with sentiment tags

### Risk Management
- **Position Sizing** — Max 5% of balance per position
- **Stop-Loss / Take-Profit** — Automatic position closure at configurable thresholds (3% SL, 5% TP)
- **Daily Loss Limit** — Trading halts at 2% daily drawdown
- **Max Open Positions** — Capped at 3 concurrent positions
- **Portfolio Tracking** — Real-time P&L, daily P&L, total trades, open/closed positions

### Live Dashboard
- **Real-Time Web UI** — Express server with Server-Sent Events (SSE) for instant updates
- **AI Brain Panel** — Shows agent's reasoning, strategy, and market assessment live
- **Portfolio Overview** — Balance, open value, P&L, trade count, on-chain balances
- **Price Display** — Live pool prices with auto-refresh
- **Arbitrage Monitor** — Detected routes with profit percentage and step-by-step paths
- **Position Tracker** — Open positions with entry/current price and unrealized P&L
- **News Feed** — Scrolling feed with sentiment badges and impact tags
- **Activity Log** — Chronological log of all agent actions and events
- **B/W Minimal Design** — Clean black/white theme with Inter + JetBrains Mono typography

### Market Maker
- **On-Chain Price Movement** — Separate script executes random swaps to create realistic price volatility
- **Configurable Intervals** — Adjustable swap frequency and amounts
- **Multi-Pool Coverage** — Trades across all 3 pools to create varied market conditions

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   AI Agent Brain                 │
│         (Claude via OpenRouter API)              │
│                                                  │
│  Input: Full system state (prices, portfolio,    │
│         positions, arb, news, risk limits)       │
│                                                  │
│  Output: JSON action plan (trade, execute_arb,   │
│          close_position, adjust_risk, hold)       │
└──────────────────────┬──────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
   ┌────────────┐ ┌─────────┐ ┌─────────────┐
   │  Executor  │ │  Risk   │ │  Arb Engine │
   │ (on-chain) │ │ Manager │ │  (scanner)  │
   └─────┬──────┘ └────┬────┘ └──────┬──────┘
         │              │             │
         ▼              ▼             ▼
   ┌────────────────────────────────────────┐
   │      HSK Testnet (Chain 133)           │
   │  Uniswap V3 Pools + SwapRouter        │
   │  TALPHA/tUSDT | TBETA/tUSDT | A/B     │
   └────────────────────────────────────────┘
         │
         ▼
   ┌────────────────────────────────────────┐
   │     Dashboard (localhost:3456)         │
   │  Express + SSE — Real-time updates    │
   └────────────────────────────────────────┘
```

## Tech Stack

- **Blockchain** — HashKey Chain Testnet (EVM, Chain ID 133)
- **DEX** — Uniswap V3 (Factory, SwapRouter, NonfungiblePositionManager)
- **Smart Contracts** — Solidity 0.7.6 / 0.8.24 via Hardhat
- **AI** — Claude (via OpenRouter API)
- **Backend** — Node.js, Express, ethers.js v6
- **Frontend** — Single-page dashboard with SSE, Inter + JetBrains Mono fonts
- **Tooling** — Hardhat, dotenv

## Setup

### Prerequisites
- Node.js 18+
- HSK testnet tokens (get from faucet)
- OpenRouter API key

### Install
```bash
npm install
```

### Configure
Create `.env`:
```env
NETWORK=testnet
MODE=live
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=your-key-here
PRIVATE_KEY=your-wallet-private-key
SWAP_ROUTER=0xe4f185a337211019ac116f35267c932979Edd5e7
```

### Deploy Contracts (if needed)
```bash
npx hardhat run scripts/deploy_testnet_dex.js --network hsk_testnet
```

### Approve Tokens (one-time)
```bash
npm run approve
```

### Add Liquidity (if needed)
```bash
node scripts/add_liquidity.js
```

## Usage

### Live Mode (On-Chain Execution)

Terminal 1 — Start market maker for price movement:
```bash
npm run market-maker
```

Terminal 2 — Start dashboard + trading bot:
```bash
npm run dashboard:live
```

Open `http://localhost:3456` to view the dashboard.

### Simulate Mode (Paper Trading)
```bash
npm run dashboard
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dashboard:live` | Dashboard + bot with on-chain execution |
| `npm run dashboard` | Dashboard + bot in simulate mode |
| `npm run market-maker` | On-chain price movement generator |
| `npm run approve` | Approve tokens for SwapRouter |
| `npm run agent:live` | CLI bot with on-chain execution (no dashboard) |
| `npm run agent` | CLI bot in simulate mode (no dashboard) |

## Project Structure

```
├── dashboard.js          # Express dashboard + SSE + trading loop
├── index.js              # CLI entry point (no dashboard)
├── src/
│   ├── agent.js          # AI Agent orchestrator
│   ├── arb.js            # Triangular arbitrage detection
│   ├── chain.js          # RPC reader for V3 pools
│   ├── config.js         # Central configuration
│   ├── executor.js       # Trade execution (live + paper)
│   ├── history.js        # Price history + persistence
│   ├── news.js           # Simulated news feed
│   ├── risk.js           # Risk management + balance tracking
│   └── simulator.js      # Price movement overlay (simulate mode)
├── scripts/
│   ├── approve_tokens.js # One-time token approvals
│   ├── market_maker.js   # On-chain random swap generator
│   ├── add_liquidity.js  # Pool liquidity management
│   └── deploy_testnet_dex.js  # Full DEX deployment
├── contracts/            # Solidity contracts (MockERC20, WETH9)
├── testnet_deployment.json    # Deployed contract addresses
└── .env                  # Environment configuration
```

## Deployed Contracts (HSK Testnet)

| Contract | Address |
|----------|---------|
| Factory | `0xB862231b343231E456DF47E520b57e32AE079dD6` |
| SwapRouter | `0xe4f185a337211019ac116f35267c932979Edd5e7` |
| NPM | `0x628f0750881A90eB26bd30775E00a3eB3811dbb5` |
| TALPHA | `0x747e0179896617E3AcEC745BEEb22696fc849848` |
| TBETA | `0xe326f0606E27c34a29DEB9E72a0cCdecA6cA6593` |
| tUSDT | `0x7de25caAc85194219bAbbDC2106c49fF91784cB6` |

## License

MIT
