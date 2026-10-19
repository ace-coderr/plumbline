// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PlumbQuote} from "./PlumbQuote.sol";
import {PlumbQuoteFactory} from "./PlumbQuoteFactory.sol";
import {IPlumbPenalizer} from "./interfaces/IPlumbPenalizer.sol";
import {PlumbScore} from "./libraries/PlumbScore.sol";

/// @title PlumbRouter
/// @notice Fills takers against the best live quotes listed for a pair, and reports quotes that look
///         fillable but are not.
/// @dev For each swap the router ranks every live vault by price, then fills from the best one down
///      until the input is used up. When a vault's fill reverts, the router checks for itself whether
///      the vault is short of the inventory its quote advertises. Only that verifiable shortfall is
///      penalized, so a taker cannot get an honest maker slashed by starving the fill of gas or by
///      choosing a recipient the token refuses.
///
///      A swap normally reverts unless it fills completely. If a dishonest vault was penalized along
///      the way, the swap instead succeeds with a partial fill and refunds the rest, so the penalty
///      is not rolled back. Either way the average price over what was filled is no worse than
///      `minOut / amountIn`.
contract PlumbRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice One vault's side of the book, for display and routing.
    struct BookEntry {
        address vault;
        address owner;
        PlumbQuote.Quote quote;
        bool live;
        uint256 freeBase;
        uint256 freeQuote;
    }

    struct Candidate {
        PlumbQuote vault;
        uint256 px;
        uint256 maxIn;
    }

    /// @notice Vault registry.
    PlumbQuoteFactory public immutable factory;
    /// @notice Campaign layer that slashes bonds on verified failed fills.
    IPlumbPenalizer public immutable penalizer;

    /// @notice Emitted once per swap.
    event Swapped(
        address indexed taker,
        address indexed base,
        address indexed quote,
        bool buyingBase,
        uint256 amountIn,
        uint256 amountOut,
        uint256 refunded,
        address recipient
    );
    /// @notice Emitted for every vault fill inside a swap.
    event RoutedFill(address indexed vault, address indexed taker, uint256 amountIn, uint256 amountOut, uint256 px);
    /// @notice Emitted when a vault whose quote looked fillable reverted.
    /// @param status The vault's own diagnosis after the revert (see `PlumbQuote.FillStatus`).
    /// @param selector First four bytes of the revert data.
    /// @param penalized True when the failure was a verified inventory shortfall and bonds were slashed.
    event FillFailed(
        address indexed vault,
        address indexed taker,
        uint256 amountIn,
        uint8 status,
        bytes4 selector,
        bool penalized
    );

    error ZeroAmount();
    error NoLiquidity();
    error InsufficientOutput();

    /// @param factory_ The vault factory.
    /// @param penalizer_ The PlumbCampaigns contract.
    constructor(PlumbQuoteFactory factory_, IPlumbPenalizer penalizer_) {
        factory = factory_;
        penalizer = penalizer_;
    }

    /// @notice Swap an exact input against the pair's live quotes.
    /// @param base Base token of the pair.
    /// @param quote Quote token of the pair.
    /// @param buyingBase True to pay quote and receive base; false to pay base and receive quote.
    /// @param amountIn Raw input units pulled from the caller.
    /// @param minOut Minimum output for the full `amountIn`; also sets the worst acceptable price.
    /// @param to Recipient of the output.
    /// @return amountOut Raw output units delivered to `to`.
    /// @return refunded Input returned to the caller (non-zero only after a penalized failure).
    function swapExactIn(
        address base,
        address quote,
        bool buyingBase,
        uint256 amountIn,
        uint256 minOut,
        address to
    ) external nonReentrant returns (uint256 amountOut, uint256 refunded) {
        if (amountIn == 0) revert ZeroAmount();
        IERC20 tokenIn = IERC20(buyingBase ? quote : base);
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);

        Candidate[] memory book = _rank(base, quote, buyingBase);
        uint256 remaining = amountIn;
        bool anyPenalty;

        for (uint256 i; i < book.length && remaining > 0; ++i) {
            Candidate memory c = book[i];
            uint256 chunk = remaining < c.maxIn ? remaining : c.maxIn;
            if (chunk == 0) continue;
            (uint256 expected,) = c.vault.previewFill(buyingBase, chunk);

            tokenIn.forceApprove(address(c.vault), chunk);
            try c.vault.fill(buyingBase, chunk, expected, to) returns (uint256 got) {
                amountOut += got;
                remaining -= chunk;
                emit RoutedFill(address(c.vault), msg.sender, chunk, got, c.px);
            } catch (bytes memory reason) {
                tokenIn.forceApprove(address(c.vault), 0);
                (, PlumbQuote.FillStatus status) = c.vault.previewFill(buyingBase, chunk);
                bool shortfall = status == PlumbQuote.FillStatus.InsufficientInventory;
                if (shortfall) {
                    anyPenalty = true;
                    penalizer.penalize(address(c.vault), msg.sender);
                }
                emit FillFailed(address(c.vault), msg.sender, chunk, uint8(status), _selector(reason), shortfall);
            }
        }

        if (remaining > 0) {
            if (!anyPenalty) revert NoLiquidity();
            refunded = remaining;
            tokenIn.safeTransfer(msg.sender, refunded);
        }
        if (amountOut * amountIn < minOut * (amountIn - remaining)) revert InsufficientOutput();
        emit Swapped(msg.sender, base, quote, buyingBase, amountIn, amountOut, refunded, to);
    }

    /// @notice Quote a swap without executing it. Assumes every live quote fills.
    /// @return amountOut Output the swap would deliver.
    /// @return filledIn Input that live quotes can absorb (less than `amountIn` if the book is thin).
    function previewSwap(address base, address quote, bool buyingBase, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint256 filledIn)
    {
        Candidate[] memory book = _rank(base, quote, buyingBase);
        uint256 remaining = amountIn;
        for (uint256 i; i < book.length && remaining > 0; ++i) {
            uint256 chunk = remaining < book[i].maxIn ? remaining : book[i].maxIn;
            (uint256 out, PlumbQuote.FillStatus status) = book[i].vault.previewFill(buyingBase, chunk);
            if (status != PlumbQuote.FillStatus.Ok) continue;
            amountOut += out;
            remaining -= chunk;
        }
        filledIn = amountIn - remaining;
    }

    /// @notice Every listed vault's quote and inventory for a pair, live or not.
    function book(address base, address quote) external view returns (BookEntry[] memory entries) {
        address[] memory vaults = factory.vaultsOf(base, quote);
        entries = new BookEntry[](vaults.length);
        for (uint256 i; i < vaults.length; ++i) {
            PlumbQuote v = PlumbQuote(vaults[i]);
            (PlumbQuote.Quote memory q,, uint256 fb, uint256 fq) = v.probeSnapshot();
            entries[i] = BookEntry(vaults[i], v.owner(), q, v.isLive(), fb, fq);
        }
    }

    /// @dev Live vaults quoting the side the taker wants, best price first.
    function _rank(address base, address quote, bool buyingBase) internal view returns (Candidate[] memory out) {
        address[] memory vaults = factory.vaultsOf(base, quote);
        Candidate[] memory tmp = new Candidate[](vaults.length);
        uint256 n;
        for (uint256 i; i < vaults.length; ++i) {
            PlumbQuote v = PlumbQuote(vaults[i]);
            PlumbQuote.Quote memory q = v.quote();
            if (!PlumbScore.isFresh(q.updatedAt, v.maxAge(), block.timestamp)) continue;
            uint256 px;
            uint256 maxIn;
            if (buyingBase) {
                if (q.askSize == 0) continue;
                px = q.askPx;
                maxIn = PlumbScore.quoteNotional(q.askSize, px, v.baseUnit(), v.quoteUnit());
            } else {
                if (q.bidSize == 0) continue;
                px = q.bidPx;
                maxIn = q.bidSize;
            }
            if (maxIn == 0) continue;
            Candidate memory c = Candidate(v, px, maxIn);
            // Insertion sort: ascending ask when buying, descending bid when selling.
            uint256 j = n;
            while (j > 0 && (buyingBase ? tmp[j - 1].px > px : tmp[j - 1].px < px)) {
                tmp[j] = tmp[j - 1];
                --j;
            }
            tmp[j] = c;
            ++n;
        }
        out = new Candidate[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = tmp[i];
        }
    }

    function _selector(bytes memory reason) internal pure returns (bytes4 sel) {
        if (reason.length >= 4) {
            assembly {
                sel := mload(add(reason, 32))
            }
        }
    }
}
