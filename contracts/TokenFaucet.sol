// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract TokenFaucet is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    uint256 public dripAmount;
    uint256 public cooldown;

    mapping(address => uint256) public lastClaim;

    event Claimed(address indexed recipient, uint256 amount);
    event ConfigUpdated(uint256 dripAmount, uint256 cooldown);
    event Withdrawn(address indexed to, uint256 amount);

    constructor(IERC20 _token, uint256 _dripAmount, uint256 _cooldown) Ownable(msg.sender) {
        token = _token;
        dripAmount = _dripAmount;
        cooldown = _cooldown;
    }

    function claim() external {
        _drip(msg.sender);
    }

    // Lets a relayer pay gas for users who hold no native HSK yet.
    function claimFor(address recipient) external {
        _drip(recipient);
    }

    function nextClaimAt(address recipient) public view returns (uint256) {
        uint256 last = lastClaim[recipient];
        return last == 0 ? 0 : last + cooldown;
    }

    function setConfig(uint256 _dripAmount, uint256 _cooldown) external onlyOwner {
        dripAmount = _dripAmount;
        cooldown = _cooldown;
        emit ConfigUpdated(_dripAmount, _cooldown);
    }

    function withdraw(uint256 amount) external onlyOwner {
        token.safeTransfer(owner(), amount);
        emit Withdrawn(owner(), amount);
    }

    function _drip(address recipient) internal {
        require(recipient != address(0), "Zero address");
        require(block.timestamp >= nextClaimAt(recipient), "Cooldown active");
        require(token.balanceOf(address(this)) >= dripAmount, "Faucet empty");
        lastClaim[recipient] = block.timestamp;
        token.safeTransfer(recipient, dripAmount);
        emit Claimed(recipient, dripAmount);
    }
}
