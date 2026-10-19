// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title DemoQuoteToken
/// @notice DEMO ASSET. NOT PART OF THE PLUMBLINE PROTOCOL. HAS NO VALUE.
/// @dev Canonical USDC is not faucet-available on Elysium testnet, so the seeded demo market quotes
///      WHYPE against this mintable stand-in instead. It is a plain 6-decimal ERC-20 whose owner can
///      mint freely. Nothing in Plumbline depends on which quote asset a market uses: vaults, the
///      router and campaigns read decimals on-chain and treat every ERC-20 the same way. It lives under
///      src/test/ so it is never mistaken for product code.
contract DemoQuoteToken is ERC20, Ownable {
    constructor(address owner_) ERC20("Plumbline Demo Dollar", "PLUMBUSD") Ownable(owner_) {}

    /// @notice 6 decimals, matching the USDC it stands in for.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint demo dollars. Owner only.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
