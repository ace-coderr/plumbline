// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IReferencePrice
/// @notice Seam for an on-chain reference price that probes can score spread against.
/// @dev HYPERCORE SEAM. Elysium's HyperCore market-data precompile is not live yet. Until it is, a
///      campaign leaves its reference source unset and spread is measured around each quote's own
///      mid. Once the precompile ships, an adapter implementing this interface over HyperCore's
///      oracle price can be set on new campaigns, and PlumbScore will measure each quote's distance
///      from that oracle price instead. Nothing else in the protocol changes.
interface IReferencePrice {
    /// @notice Reference price for a pair.
    /// @param base Base token of the pair.
    /// @param quote Quote token of the pair.
    /// @return px Quote-per-base price in human units scaled by 1e18.
    /// @return updatedAt Timestamp of the reading, used to reject stale references.
    function referencePrice(address base, address quote) external view returns (uint256 px, uint64 updatedAt);
}
