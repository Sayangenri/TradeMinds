// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title MockV2Pair — a simplified Uniswap-V2-style constant-product pool.
/// It holds reserves of token0 and token1, exposes getReserves(), and swaps
/// using the real x*y=k math with a 0.3% fee. This is deliberately NOT the
/// full Uniswap pair (no LP tokens, no flash swaps, no TWAP oracle) — just
/// enough to read reserves and trade against honest AMM pricing.
contract MockV2Pair {
    address public immutable token0;
    address public immutable token1;

    uint112 private reserve0;
    uint112 private reserve1;

    // Uniswap V2 fee: 0.3% => you keep 99.7% of the input (997/1000).
    uint256 public constant FEE_NUMERATOR = 997;
    uint256 public constant FEE_DENOMINATOR = 1000;

    event Sync(uint112 reserve0, uint112 reserve1);
    event Swap(address indexed sender, uint256 amountIn, uint256 amountOut, address tokenIn);

    constructor(address _token0, address _token1) {
        require(_token0 != _token1, "IDENTICAL_TOKENS");
        token0 = _token0;
        token1 = _token1;
    }

    /// Same shape as the real Uniswap V2 getReserves().
    function getReserves() public view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast) {
        return (reserve0, reserve1, uint32(block.timestamp));
    }

    /// Seed or top up liquidity. Caller must have approved this pair first.
    /// In real Uniswap this mints LP tokens; here we just pull tokens and sync.
    function addLiquidity(uint256 amount0, uint256 amount1) external {
        IERC20Minimal(token0).transferFrom(msg.sender, address(this), amount0);
        IERC20Minimal(token1).transferFrom(msg.sender, address(this), amount1);
        _update();
    }

    /// Pure-math quote: how much tokenOut for a given tokenIn, with fee.
    /// amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public
        pure
        returns (uint256)
    {
        require(amountIn > 0, "INSUFFICIENT_INPUT");
        require(reserveIn > 0 && reserveOut > 0, "INSUFFICIENT_LIQUIDITY");
        uint256 amountInWithFee = amountIn * FEE_NUMERATOR;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * FEE_DENOMINATOR + amountInWithFee;
        return numerator / denominator;
    }

    /// Swap an exact amount of one token for the other.
    /// tokenIn must be token0 or token1. Caller must have approved this pair.
    function swapExactIn(address tokenIn, uint256 amountIn) external returns (uint256 amountOut) {
        require(tokenIn == token0 || tokenIn == token1, "BAD_TOKEN");
        (uint112 r0, uint112 r1, ) = getReserves();

        bool zeroForOne = tokenIn == token0;
        (uint256 reserveIn, uint256 reserveOut) = zeroForOne ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));

        amountOut = getAmountOut(amountIn, reserveIn, reserveOut);

        address tokenOut = zeroForOne ? token1 : token0;
        IERC20Minimal(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20Minimal(tokenOut).transfer(msg.sender, amountOut);

        _update();
        emit Swap(msg.sender, amountIn, amountOut, tokenIn);
    }

    /// Re-read actual balances into the reserves (keeps reserves honest).
    function _update() internal {
        uint256 bal0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 bal1 = IERC20Minimal(token1).balanceOf(address(this));
        require(bal0 <= type(uint112).max && bal1 <= type(uint112).max, "OVERFLOW");
        reserve0 = uint112(bal0);
        reserve1 = uint112(bal1);
        emit Sync(reserve0, reserve1);
    }
}
