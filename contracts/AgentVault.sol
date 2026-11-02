// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

contract AgentVault is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    address public owner;
    address public agent;
    address public allowedRouter;

    uint256 public maxPositionPct;   // basis points (e.g. 500 = 5%)
    uint256 public dailyLossCapPct;  // basis points (e.g. 200 = 2%)
    uint256 public cooldownSeconds;

    uint256 public dailyLossAccumulator;
    uint256 public dailyResetTimestamp;
    uint256 public lastTradeTimestamp;
    uint256 public totalDeposited;

    mapping(address => uint256) public tokenBalances;
    address[] public depositedTokens;
    mapping(address => bool) private tokenExists;

    event Deposited(address indexed token, uint256 amount);
    event Withdrawn(address indexed token, uint256 amount);
    event TradeExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event ArbExecuted(uint256 amountIn, uint256 amountOut);
    event LimitsUpdated(uint256 maxPosPct, uint256 dailyLossPct, uint256 cooldown);
    event AgentUpdated(address indexed oldAgent, address indexed newAgent);
    event RouterUpdated(address indexed oldRouter, address indexed newRouter);
    event VaultPaused(address indexed by);
    event VaultUnpaused(address indexed by);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyAgent() {
        require(msg.sender == agent, "Not agent");
        _;
    }

    modifier onlyOwnerOrAgent() {
        require(msg.sender == owner || msg.sender == agent, "Not owner or agent");
        _;
    }

    constructor(
        address _agent,
        address _router,
        uint256 _maxPositionPct,
        uint256 _dailyLossCapPct,
        uint256 _cooldownSeconds
    ) {
        owner = msg.sender;
        agent = _agent;
        allowedRouter = _router;
        maxPositionPct = _maxPositionPct;
        dailyLossCapPct = _dailyLossCapPct;
        cooldownSeconds = _cooldownSeconds;
        dailyResetTimestamp = block.timestamp;
    }

    function deposit(address token, uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Zero amount");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        tokenBalances[token] += amount;
        totalDeposited += amount;
        if (!tokenExists[token]) {
            depositedTokens.push(token);
            tokenExists[token] = true;
        }
        emit Deposited(token, amount);
    }

    function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {
        require(tokenBalances[token] >= amount, "Insufficient balance");
        tokenBalances[token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(token, amount);
    }

    function emergencyWithdraw(address token) external onlyOwner nonReentrant {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) {
            tokenBalances[token] = 0;
            IERC20(token).safeTransfer(msg.sender, bal);
            emit Withdrawn(token, bal);
        }
    }

    function executeTrade(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) external onlyAgent nonReentrant whenNotPaused returns (uint256 amountOut) {
        _checkAndResetDaily();
        require(block.timestamp >= lastTradeTimestamp + cooldownSeconds, "Cooldown active");

        uint256 totalVal = _totalValue();
        uint256 maxAmount = (totalVal * maxPositionPct) / 10000;
        require(amountIn <= maxAmount, "Exceeds max position size");
        require(tokenBalances[tokenIn] >= amountIn, "Insufficient token balance");

        tokenBalances[tokenIn] -= amountIn;

        IERC20(tokenIn).approve(allowedRouter, amountIn);

        amountOut = ISwapRouter(allowedRouter).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                deadline: block.timestamp + 300,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );

        tokenBalances[tokenOut] += amountOut;
        lastTradeTimestamp = block.timestamp;

        if (amountOut < amountIn) {
            dailyLossAccumulator += (amountIn - amountOut);
            uint256 lossCap = (totalVal * dailyLossCapPct) / 10000;
            require(dailyLossAccumulator <= lossCap, "Daily loss cap exceeded");
        }

        emit TradeExecuted(tokenIn, tokenOut, amountIn, amountOut);
    }

    function executeArb(
        bytes calldata path,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) external onlyAgent nonReentrant whenNotPaused returns (uint256 amountOut) {
        _checkAndResetDaily();
        require(block.timestamp >= lastTradeTimestamp + cooldownSeconds, "Cooldown active");

        address tokenIn;
        assembly { tokenIn := shr(96, calldataload(path.offset)) }

        require(tokenBalances[tokenIn] >= amountIn, "Insufficient token balance");
        tokenBalances[tokenIn] -= amountIn;

        IERC20(tokenIn).approve(allowedRouter, amountIn);

        amountOut = ISwapRouter(allowedRouter).exactInput(
            ISwapRouter.ExactInputParams({
                path: path,
                recipient: address(this),
                deadline: block.timestamp + 300,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum
            })
        );

        address tokenOut;
        assembly { tokenOut := shr(96, calldataload(add(path.offset, sub(path.length, 20)))) }

        tokenBalances[tokenOut] += amountOut;
        lastTradeTimestamp = block.timestamp;

        emit ArbExecuted(amountIn, amountOut);
    }

    function setLimits(
        uint256 _maxPositionPct,
        uint256 _dailyLossCapPct,
        uint256 _cooldownSeconds
    ) external onlyOwner {
        maxPositionPct = _maxPositionPct;
        dailyLossCapPct = _dailyLossCapPct;
        cooldownSeconds = _cooldownSeconds;
        emit LimitsUpdated(_maxPositionPct, _dailyLossCapPct, _cooldownSeconds);
    }

    function tightenLimits(
        uint256 _maxPositionPct,
        uint256 _dailyLossCapPct,
        uint256 _cooldownSeconds
    ) external onlyAgent {
        require(_maxPositionPct <= maxPositionPct, "Can only tighten max position");
        require(_dailyLossCapPct <= dailyLossCapPct, "Can only tighten daily loss");
        require(_cooldownSeconds >= cooldownSeconds, "Can only increase cooldown");
        maxPositionPct = _maxPositionPct;
        dailyLossCapPct = _dailyLossCapPct;
        cooldownSeconds = _cooldownSeconds;
        emit LimitsUpdated(_maxPositionPct, _dailyLossCapPct, _cooldownSeconds);
    }

    function setAgent(address _agent) external onlyOwner {
        emit AgentUpdated(agent, _agent);
        agent = _agent;
    }

    function setRouter(address _router) external onlyOwner {
        emit RouterUpdated(allowedRouter, _router);
        allowedRouter = _router;
    }

    function pause() external onlyOwnerOrAgent {
        _pause();
        emit VaultPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        _unpause();
        emit VaultUnpaused(msg.sender);
    }

    function getVaultState() external view returns (
        address _owner,
        address _agent,
        address _router,
        uint256 _maxPositionPct,
        uint256 _dailyLossCapPct,
        uint256 _cooldownSeconds,
        uint256 _dailyLoss,
        uint256 _lastTrade,
        bool _paused
    ) {
        return (owner, agent, allowedRouter, maxPositionPct, dailyLossCapPct, cooldownSeconds, dailyLossAccumulator, lastTradeTimestamp, paused());
    }

    function getTokenBalance(address token) external view returns (uint256) {
        return tokenBalances[token];
    }

    function getDepositedTokens() external view returns (address[] memory) {
        return depositedTokens;
    }

    function _totalValue() internal view returns (uint256) {
        uint256 total = 0;
        for (uint256 i = 0; i < depositedTokens.length; i++) {
            total += tokenBalances[depositedTokens[i]];
        }
        return total;
    }

    function _checkAndResetDaily() internal {
        if (block.timestamp >= dailyResetTimestamp + 1 days) {
            dailyLossAccumulator = 0;
            dailyResetTimestamp = block.timestamp;
        }
    }
}
