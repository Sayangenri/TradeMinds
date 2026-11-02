// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IV3SwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// Each user deposits the asset; the agent may only run arb cycles that start and
/// end in the asset and never return less than they put in. Only the user can withdraw.
contract MultiUserVault is ReentrancyGuard, Pausable, Ownable {
    using SafeERC20 for IERC20;

    uint256 private constant ADDR_LEN = 20;
    uint256 private constant HOP_LEN = 23;
    uint256 private constant MAX_HOPS = 4;

    IERC20 public immutable asset;
    address public agent;
    address public router;
    uint256 public maxTradeAmount;

    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public totalDeposited;
    mapping(address => uint256) public totalWithdrawn;
    mapping(address => uint256) public totalProfit;
    mapping(address => uint256) public tradeCount;
    uint256 public totalBalances;

    address[] private users;
    mapping(address => bool) private isUser;

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event ArbExecuted(address indexed user, uint256 amountIn, uint256 amountOut, uint256 profit);
    event AgentUpdated(address indexed agent);
    event RouterUpdated(address indexed router);
    event MaxTradeAmountUpdated(uint256 amount);

    modifier onlyAgent() {
        require(msg.sender == agent, "Not agent");
        _;
    }

    constructor(IERC20 _asset, address _agent, address _router, uint256 _maxTradeAmount) Ownable(msg.sender) {
        asset = _asset;
        agent = _agent;
        router = _router;
        maxTradeAmount = _maxTradeAmount;
    }

    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Zero amount");
        asset.safeTransferFrom(msg.sender, address(this), amount);
        if (!isUser[msg.sender]) {
            isUser[msg.sender] = true;
            users.push(msg.sender);
        }
        balanceOf[msg.sender] += amount;
        totalDeposited[msg.sender] += amount;
        totalBalances += amount;
        emit Deposited(msg.sender, amount);
    }

    // Deliberately not gated by pause: users can always exit.
    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        totalWithdrawn[msg.sender] += amount;
        totalBalances -= amount;
        asset.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function executeArbFor(
        address user,
        bytes calldata path,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) external onlyAgent nonReentrant whenNotPaused returns (uint256 amountOut) {
        require(amountIn > 0, "Zero amount");
        require(amountIn <= balanceOf[user], "Insufficient balance");
        require(amountIn <= maxTradeAmount, "Exceeds max trade");
        _checkPath(path);

        uint256 before = asset.balanceOf(address(this));
        asset.forceApprove(router, amountIn);
        IV3SwapRouter(router).exactInput(
            IV3SwapRouter.ExactInputParams({
                path: path,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum > amountIn ? amountOutMinimum : amountIn
            })
        );
        // Never leave a standing allowance on the router.
        asset.forceApprove(router, 0);

        // Measured from our own balance so a bad router return value can't fake a profit.
        uint256 afterBal = asset.balanceOf(address(this));
        require(afterBal >= before, "Unprofitable");
        uint256 profit = afterBal - before;
        amountOut = amountIn + profit;

        balanceOf[user] += profit;
        totalProfit[user] += profit;
        tradeCount[user] += 1;
        totalBalances += profit;
        emit ArbExecuted(user, amountIn, amountOut, profit);
    }

    function getUsers() external view returns (address[] memory) {
        return users;
    }

    function getUserStats(address user) external view returns (
        uint256 balance,
        uint256 deposited,
        uint256 withdrawn,
        uint256 profit,
        uint256 trades
    ) {
        return (balanceOf[user], totalDeposited[user], totalWithdrawn[user], totalProfit[user], tradeCount[user]);
    }

    function setAgent(address _agent) external onlyOwner {
        agent = _agent;
        emit AgentUpdated(_agent);
    }

    function setRouter(address _router) external onlyOwner {
        router = _router;
        emit RouterUpdated(_router);
    }

    function setMaxTradeAmount(uint256 amount) external onlyOwner {
        maxTradeAmount = amount;
        emit MaxTradeAmountUpdated(amount);
    }

    function pause() external {
        require(msg.sender == owner() || msg.sender == agent, "Not owner or agent");
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _checkPath(bytes calldata path) private view {
        require(path.length > ADDR_LEN && (path.length - ADDR_LEN) % HOP_LEN == 0, "Bad path");
        uint256 hops = (path.length - ADDR_LEN) / HOP_LEN;
        require(hops >= 2 && hops <= MAX_HOPS, "Bad hop count");
        require(address(bytes20(path[:ADDR_LEN])) == address(asset), "Path must start with asset");
        require(address(bytes20(path[path.length - ADDR_LEN:])) == address(asset), "Path must end with asset");
    }
}
