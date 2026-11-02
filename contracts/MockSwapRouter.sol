// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockSwapRouter {
    uint256 public returnAmount;

    function setReturnAmount(uint256 _amount) external {
        returnAmount = _amount;
    }

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

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        amountOut = returnAmount > 0 ? returnAmount : params.amountIn;
        IERC20(params.tokenOut).transfer(params.recipient, amountOut);
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        bytes calldata p = params.path;
        address tokenIn = _toAddress(p, 0);
        address tokenOut = _toAddress(p, p.length - 20);

        IERC20(tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        amountOut = returnAmount > 0 ? returnAmount : params.amountIn;
        IERC20(tokenOut).transfer(params.recipient, amountOut);
    }

    function _toAddress(bytes calldata data, uint256 start) internal pure returns (address addr) {
        bytes20 b;
        assembly {
            b := calldataload(add(data.offset, start))
        }
        addr = address(b);
    }
}
