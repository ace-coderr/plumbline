// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArbSys} from "../../src/interfaces/IArbSys.sol";

/// @notice Stand-in for Arbitrum's ArbSys precompile, etched at 0x64 in tests. The L2 block number
///         and hashes are set directly, independent of the EVM's `block.number`, as on an Orbit chain.
contract MockArbSys is IArbSys {
    uint256 public number;
    mapping(uint256 => bytes32) public hashes;

    function setNumber(uint256 n) external {
        number = n;
    }

    function setHash(uint256 n, bytes32 h) external {
        hashes[n] = h;
    }

    function arbBlockNumber() external view returns (uint256) {
        return number;
    }

    /// @dev Like ArbSys, only the 256 blocks before the current one have a hash; others revert.
    function arbBlockHash(uint256 n) external view returns (bytes32) {
        require(n < number && number - n <= 256, "invalid block number");
        return hashes[n];
    }
}
