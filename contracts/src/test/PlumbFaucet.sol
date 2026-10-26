// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title PlumbFaucet
/// @notice A faucet for the Plumbline demo token (PLUMBUSD), so nobody has to be sent tokens by hand.
///         `claim()` sends a fixed amount to the caller, at most once per cooldown per address.
/// @dev Demo-only, under `src/test/` with `DemoQuoteToken`: the token has no value. There are no owner
///      functions: the token, the amount and the cooldown are immutable, and the pool is simply the
///      token balance this contract holds, topped up by anyone transferring to it. The cooldown is per
///      address, so one person with many addresses can claim many times; it limits casual repeat claims,
///      not a determined drainer. State is updated before the transfer (checks, effects, interactions).
contract PlumbFaucet {
    using SafeERC20 for IERC20;

    /// @notice The token handed out.
    IERC20 public immutable token;
    /// @notice Raw token units sent per claim.
    uint256 public immutable amount;
    /// @notice Seconds an address must wait between claims.
    uint256 public immutable cooldown;

    /// @notice When each address last claimed, in unix seconds; zero if it never has.
    mapping(address => uint256) public lastClaimAt;

    /// @notice Emitted for every claim.
    /// @param account The claimer, who received `amount`.
    /// @param value Raw token units sent.
    /// @param nextClaimAt When `account` can claim again.
    event Claimed(address indexed account, uint256 value, uint256 nextClaimAt);

    /// @notice The caller claimed too recently; they can claim again at `nextClaimAt`.
    error CooldownActive(uint256 nextClaimAt);
    /// @notice The pool holds less than one claim.
    error PoolEmpty();
    /// @notice A constructor argument was zero.
    error BadConfig();

    /// @param token_ The token to hand out.
    /// @param amount_ Raw units per claim (100 PLUMBUSD is 100e6).
    /// @param cooldown_ Seconds between claims for one address.
    constructor(IERC20 token_, uint256 amount_, uint256 cooldown_) {
        if (address(token_) == address(0) || amount_ == 0 || cooldown_ == 0) revert BadConfig();
        token = token_;
        amount = amount_;
        cooldown = cooldown_;
    }

    /// @notice Send `amount` of the token to the caller, once per `cooldown`.
    /// @dev Reverts with `CooldownActive` if the caller claimed within the cooldown, or `PoolEmpty` if the
    ///      pool holds less than `amount`. A claim is never partial.
    function claim() external {
        uint256 next = nextClaimAt(msg.sender);
        if (block.timestamp < next) revert CooldownActive(next);
        if (token.balanceOf(address(this)) < amount) revert PoolEmpty();

        lastClaimAt[msg.sender] = block.timestamp;
        emit Claimed(msg.sender, amount, block.timestamp + cooldown);
        token.safeTransfer(msg.sender, amount);
    }

    /// @notice When `account` may next claim: zero if it never has (it may claim now).
    function nextClaimAt(address account) public view returns (uint256) {
        uint256 last = lastClaimAt[account];
        return last == 0 ? 0 : last + cooldown;
    }

    /// @notice Raw token units available to claim.
    function poolBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
