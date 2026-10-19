// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlumbQuote} from "./PlumbQuote.sol";

/// @title PlumbQuoteFactory
/// @notice Deploys PlumbQuote vaults and keeps the per-pair list the router and campaigns read from.
/// @dev Ownerless. Each pair lists at most `MAX_LISTED` vaults so routing and probing stay bounded.
///      A vault whose quote has been dead for `PRUNE_AFTER` can be delisted by anyone to free its
///      slot, and its owner can relist it later.
contract PlumbQuoteFactory {
    /// @notice A listed trading pair.
    struct Pair {
        address base;
        address quote;
    }

    /// @notice Maximum listed vaults per pair.
    uint256 public constant MAX_LISTED = 32;
    /// @notice Seconds a vault's quote must be dead before anyone may delist it.
    uint256 public constant PRUNE_AFTER = 1 hours;

    /// @notice Freshness window given to every vault, in seconds.
    uint32 public immutable maxAge;
    /// @notice Withdrawal timelock given to every vault, in seconds.
    uint32 public immutable withdrawDelay;

    /// @notice True for every vault this factory deployed.
    mapping(address => bool) public isVault;
    /// @notice Timestamp each vault was created.
    mapping(address => uint64) public createdAt;
    /// @notice True while a vault is listed for routing.
    mapping(address => bool) public isListed;

    mapping(bytes32 => address[]) internal _listed;
    mapping(bytes32 => bool) internal _pairKnown;
    Pair[] internal _pairs;
    address[] internal _allVaults;

    /// @notice Emitted when a vault is deployed.
    event VaultCreated(
        address indexed vault,
        address indexed owner,
        address indexed base,
        address quote,
        address quoter
    );
    /// @notice Emitted the first time a pair gets a vault.
    event PairListed(address indexed base, address indexed quote, uint256 index);
    /// @notice Emitted when a vault leaves its pair's routing list.
    event VaultDelisted(address indexed vault, address indexed by);
    /// @notice Emitted when a vault rejoins its pair's routing list.
    event VaultRelisted(address indexed vault);

    error PairFull();
    error NotVault();
    error NotPrunable();
    error NotVaultOwner();
    error AlreadyListed();

    /// @param maxAge_ Freshness window for vault quotes, in seconds (Plumbline uses 2).
    /// @param withdrawDelay_ Withdrawal timelock for vault inventory, in seconds.
    constructor(uint32 maxAge_, uint32 withdrawDelay_) {
        maxAge = maxAge_;
        withdrawDelay = withdrawDelay_;
    }

    /// @notice Deploy a vault owned by the caller and list it for `base`/`quote`.
    /// @param base Base token.
    /// @param quote Quote token.
    /// @param quoter Hot key allowed to post quotes (may be zero).
    /// @return vault The new vault.
    function createVault(address base, address quote, address quoter) external returns (address vault) {
        bytes32 key = pairKey(base, quote);
        if (_listed[key].length >= MAX_LISTED) revert PairFull();
        vault = address(new PlumbQuote(msg.sender, quoter, base, quote, maxAge, withdrawDelay));
        isVault[vault] = true;
        createdAt[vault] = uint64(block.timestamp);
        _allVaults.push(vault);
        if (!_pairKnown[key]) {
            _pairKnown[key] = true;
            _pairs.push(Pair(base, quote));
            emit PairListed(base, quote, _pairs.length - 1);
        }
        _list(key, vault);
        emit VaultCreated(vault, msg.sender, base, quote, quoter);
    }

    /// @notice Delist a vault whose quote has been dead for at least `PRUNE_AFTER`.
    function prune(address vault) external {
        if (!isListed[vault]) revert NotVault();
        PlumbQuote v = PlumbQuote(vault);
        uint64 last = v.quote().updatedAt;
        uint256 since = last > createdAt[vault] ? last : createdAt[vault];
        if (block.timestamp < since + PRUNE_AFTER) revert NotPrunable();
        _delist(vault);
        emit VaultDelisted(vault, msg.sender);
    }

    /// @notice Owner-initiated delist.
    function delist(address vault) external {
        if (!isListed[vault]) revert NotVault();
        if (PlumbQuote(vault).owner() != msg.sender) revert NotVaultOwner();
        _delist(vault);
        emit VaultDelisted(vault, msg.sender);
    }

    /// @notice Put a delisted vault back on its pair's routing list.
    function relist(address vault) external {
        if (!isVault[vault]) revert NotVault();
        if (isListed[vault]) revert AlreadyListed();
        PlumbQuote v = PlumbQuote(vault);
        if (v.owner() != msg.sender) revert NotVaultOwner();
        bytes32 key = pairKey(address(v.baseToken()), address(v.quoteToken()));
        if (_listed[key].length >= MAX_LISTED) revert PairFull();
        _list(key, vault);
        emit VaultRelisted(vault);
    }

    /// @notice Listed vaults for a pair.
    function vaultsOf(address base, address quote) external view returns (address[] memory) {
        return _listed[pairKey(base, quote)];
    }

    /// @notice Every pair that has ever had a vault.
    function pairs() external view returns (Pair[] memory) {
        return _pairs;
    }

    /// @notice Number of vaults ever created.
    function vaultCount() external view returns (uint256) {
        return _allVaults.length;
    }

    /// @notice Vault by creation index.
    function vaultAt(uint256 i) external view returns (address) {
        return _allVaults[i];
    }

    /// @notice Directional key for a pair. Base and quote are not interchangeable.
    function pairKey(address base, address quote) public pure returns (bytes32) {
        return keccak256(abi.encode(base, quote));
    }

    function _list(bytes32 key, address vault) internal {
        _listed[key].push(vault);
        isListed[vault] = true;
    }

    function _delist(address vault) internal {
        PlumbQuote v = PlumbQuote(vault);
        address[] storage list = _listed[pairKey(address(v.baseToken()), address(v.quoteToken()))];
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            if (list[i] == vault) {
                list[i] = list[n - 1];
                list.pop();
                break;
            }
        }
        isListed[vault] = false;
    }
}
