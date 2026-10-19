// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReferencePrice} from "../../src/interfaces/IReferencePrice.sol";

/// @notice Settable reference price standing in for a future HyperCore oracle adapter.
contract MockReference is IReferencePrice {
    uint256 public px;
    uint64 public at;
    bool public broken;

    function set(uint256 px_, uint64 at_) external {
        px = px_;
        at = at_;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function referencePrice(address, address) external view returns (uint256, uint64) {
        require(!broken, "broken");
        return (px, at);
    }
}
