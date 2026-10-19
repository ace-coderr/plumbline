// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPlumbPenalizer
/// @notice What the router needs from the campaign layer to punish a quote that failed to fill.
interface IPlumbPenalizer {
    /// @notice Slash every bond backing `vault` after a verified failed fill.
    /// @dev Must never revert for a vault that has no bonds, so a failed fill can always be reported.
    /// @param vault The vault whose live quote could not be honoured.
    /// @param reporter The taker whose fill failed; receives a share of the slash.
    function penalize(address vault, address reporter) external;
}
