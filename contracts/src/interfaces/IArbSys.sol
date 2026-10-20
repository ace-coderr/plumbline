// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IArbSys
/// @notice The two read calls Plumbline uses from Arbitrum's ArbSys precompile, which every Arbitrum
///         Orbit chain (Elysium included) serves at address 0x64.
/// @dev On an Orbit chain the EVM's `block.number` and `blockhash` follow the parent chain. These
///      return the chain's own (L2) block number and hashes.
interface IArbSys {
    /// @notice The current L2 block number.
    function arbBlockNumber() external view returns (uint256);

    /// @notice Hash of L2 block `arbBlockNum`; reverts unless it is one of the 256 blocks before the
    ///         current one.
    function arbBlockHash(uint256 arbBlockNum) external view returns (bytes32);
}
