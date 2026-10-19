// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title PlumbScore
/// @notice Pure scoring and accounting math for Plumbline. Every rule that decides whether a maker
///         earns a point, how a reward pot is split, how much bond is slashed, and whether the probe
///         gate is open lives here so it can be unit-tested and fuzzed in isolation.
/// @dev Prices are human-unit quote-per-base values scaled by `PX_SCALE` (1e18), independent of token
///      decimals. A WHYPE/USDC price of 41.25 is `41.25e18`. Sizes are raw base-token units.
library PlumbScore {
    /// @notice Basis-point denominator.
    uint256 internal constant BPS = 10_000;
    /// @notice Fixed-point scale for prices.
    uint256 internal constant PX_SCALE = 1e18;

    /// @notice Quote age reached `maxAge` (or the quote was never set / was cancelled).
    uint16 internal constant FAIL_STALE = 1 << 0;
    /// @notice Bid is zero, or bid is not strictly below ask.
    uint16 internal constant FAIL_CROSSED = 1 << 1;
    /// @notice Spread wider than the campaign's `maxSpreadBps`.
    uint16 internal constant FAIL_SPREAD = 1 << 2;
    /// @notice Ask size below the campaign's `minDepthBase`.
    uint16 internal constant FAIL_DEPTH_BASE = 1 << 3;
    /// @notice Bid notional below the campaign's `minDepthQuote`.
    uint16 internal constant FAIL_DEPTH_QUOTE = 1 << 4;
    /// @notice Vault does not hold the base inventory its ask advertises.
    uint16 internal constant FAIL_INVENTORY_BASE = 1 << 5;
    /// @notice Vault does not hold the quote inventory its bid advertises.
    uint16 internal constant FAIL_INVENTORY_QUOTE = 1 << 6;
    /// @notice Registration is unbonding or its bond fell below the campaign minimum.
    uint16 internal constant FAIL_BOND = 1 << 7;

    /// @notice Campaign targets a quote is scored against.
    /// @param maxSpreadBps Widest acceptable spread, in bps of the reference price.
    /// @param minDepthBase Minimum ask size in raw base units.
    /// @param minDepthQuote Minimum bid notional in raw quote units.
    struct Targets {
        uint16 maxSpreadBps;
        uint256 minDepthBase;
        uint256 minDepthQuote;
    }

    /// @notice Everything observed about one vault at the instant of a probe.
    /// @param bidPx Bid price (PX_SCALE).
    /// @param askPx Ask price (PX_SCALE).
    /// @param bidSize Bid size in raw base units.
    /// @param askSize Ask size in raw base units.
    /// @param updatedAt Timestamp the quote was last posted.
    /// @param maxAge Seconds after which the vault's quote is stale.
    /// @param freeBase Base balance the vault holds net of pending withdrawals.
    /// @param freeQuote Quote balance the vault holds net of pending withdrawals.
    /// @param referencePx External reference price (PX_SCALE), or 0 to use the quote's own mid.
    /// @param baseUnit 10 ** base decimals.
    /// @param quoteUnit 10 ** quote decimals.
    struct Observation {
        uint128 bidPx;
        uint128 askPx;
        uint128 bidSize;
        uint128 askSize;
        uint64 updatedAt;
        uint32 maxAge;
        uint256 freeBase;
        uint256 freeQuote;
        uint256 referencePx;
        uint256 baseUnit;
        uint256 quoteUnit;
    }

    /// @notice True when a quote posted at `updatedAt` is still fillable at `nowTs`.
    /// @dev A quote is live while its age is strictly less than `maxAge`. `updatedAt == 0` means the
    ///      quote was never posted or was cancelled. Elysium timestamps have one-second resolution, so
    ///      a 2 second `maxAge` admits quotes stamped in the current or previous second.
    function isFresh(uint64 updatedAt, uint32 maxAge, uint256 nowTs) internal pure returns (bool) {
        return updatedAt != 0 && nowTs >= updatedAt && nowTs - updatedAt < maxAge;
    }

    /// @notice Spread of a two-sided quote around a reference price, in bps, rounded up.
    /// @dev Returns `2 * max(|ref - bid|, |ask - ref|) * BPS / ref`. When `ref` is the quote's own mid
    ///      this reduces exactly to `(ask - bid) * BPS / mid`. Measuring against an external reference
    ///      means a quote that is tight but skewed away from the market still scores as wide.
    ///      Rounds up so a quote can never pass a limit on a rounding technicality.
    /// @param bid Bid price (PX_SCALE). Must be below `ask`.
    /// @param ask Ask price (PX_SCALE).
    /// @param ref Reference price (PX_SCALE), or 0 to use the mid of `bid` and `ask`.
    function spreadBps(uint256 bid, uint256 ask, uint256 ref) internal pure returns (uint256) {
        if (ref == 0) {
            // (ask - bid) / ((ask + bid) / 2) without losing the half unit on odd sums.
            return Math.mulDiv(ask - bid, 2 * BPS, ask + bid, Math.Rounding.Ceil);
        }
        uint256 down = ref > bid ? ref - bid : bid - ref;
        uint256 up = ask > ref ? ask - ref : ref - ask;
        uint256 wide = down > up ? down : up;
        return Math.mulDiv(wide, 2 * BPS, ref, Math.Rounding.Ceil);
    }

    /// @notice Raw quote units equivalent to `baseAmount` raw base units at `px`, rounded down.
    function quoteNotional(uint256 baseAmount, uint256 px, uint256 baseUnit, uint256 quoteUnit)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(baseAmount, px * quoteUnit, baseUnit * PX_SCALE);
    }

    /// @notice Raw base units purchasable with `quoteAmount` raw quote units at `px`, rounded down.
    function baseForQuote(uint256 quoteAmount, uint256 px, uint256 baseUnit, uint256 quoteUnit)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(quoteAmount, baseUnit * PX_SCALE, px * quoteUnit);
    }

    /// @notice Score one observation against campaign targets.
    /// @return failMask Bitwise OR of the `FAIL_*` flags that applied; zero means the vault passed.
    /// @return spread Measured spread in bps, or `type(uint256).max` when the quote is crossed.
    function evaluate(Targets memory t, Observation memory o, uint256 nowTs)
        internal
        pure
        returns (uint16 failMask, uint256 spread)
    {
        if (!isFresh(o.updatedAt, o.maxAge, nowTs)) failMask |= FAIL_STALE;

        if (o.bidPx == 0 || o.askPx <= o.bidPx) {
            failMask |= FAIL_CROSSED;
            spread = type(uint256).max;
        } else {
            spread = spreadBps(o.bidPx, o.askPx, o.referencePx);
            if (spread > t.maxSpreadBps) failMask |= FAIL_SPREAD;
        }

        uint256 bidNotional = quoteNotional(o.bidSize, o.bidPx, o.baseUnit, o.quoteUnit);
        if (o.askSize < t.minDepthBase || o.askSize == 0) failMask |= FAIL_DEPTH_BASE;
        if (bidNotional < t.minDepthQuote || bidNotional == 0) failMask |= FAIL_DEPTH_QUOTE;

        // The inventory test is what turns a quote from a claim into a fact.
        if (o.freeBase < o.askSize) failMask |= FAIL_INVENTORY_BASE;
        if (o.freeQuote < bidNotional) failMask |= FAIL_INVENTORY_QUOTE;
    }

    /// @notice Pro-rata share of `pot` for `points` out of `totalPoints`, rounded down.
    /// @dev Rounding down guarantees the sum of all shares never exceeds `pot`.
    function share(uint256 pot, uint256 points, uint256 totalPoints) internal pure returns (uint256) {
        if (totalPoints == 0 || points == 0) return 0;
        return Math.mulDiv(pot, points, totalPoints);
    }

    /// @notice Fee owed to a prober, capped so total probe fees in an epoch never exceed `cap`.
    /// @param rewardPerEpoch The epoch pot the fee is drawn from.
    /// @param probeFeeBps Fee per probe, in bps of `rewardPerEpoch`.
    /// @param alreadyPaid Probe fees already paid this epoch.
    /// @param cap Maximum total probe fees per epoch.
    function probeFee(uint256 rewardPerEpoch, uint16 probeFeeBps, uint256 alreadyPaid, uint256 cap)
        internal
        pure
        returns (uint256)
    {
        if (alreadyPaid >= cap) return 0;
        uint256 fee = Math.mulDiv(rewardPerEpoch, probeFeeBps, BPS);
        uint256 room = cap - alreadyPaid;
        return fee < room ? fee : room;
    }

    /// @notice Split a slash of `bond` into the reporter's cut and the remainder.
    /// @return slashed Total amount removed from the bond.
    /// @return toReporter Portion paid to whoever reported the failed fill.
    /// @return toMakers Portion recycled into the epoch pot for honest makers.
    function slash(uint256 bond, uint16 slashBps, uint16 reporterBps)
        internal
        pure
        returns (uint256 slashed, uint256 toReporter, uint256 toMakers)
    {
        slashed = Math.mulDiv(bond, slashBps, BPS);
        toReporter = Math.mulDiv(slashed, reporterBps, BPS);
        toMakers = slashed - toReporter;
    }

    /// @notice Whether a single recent block hash opens the probe gate.
    /// @dev `seed` is the campaign's gate seed, re-derived from `block.prevrandao` and the previous block
    ///      hash at every probe, and `nonce` changes after every probe, so the same hash cannot open the
    ///      gate twice. Keeping prevrandao in the seed rather than in this check means a hit stays a hit
    ///      for the whole gate window on every chain: on Elysium (Arbitrum Orbit) prevrandao is the
    ///      constant 1, while on chains where it changes every block, mixing the current value in here
    ///      would turn the window into an unpredictable single-block lottery no keeper could land in.
    function gateHit(bytes32 blockHash, bytes32 seed, uint256 campaignId, uint256 nonce, uint256 odds)
        internal
        pure
        returns (bool)
    {
        if (blockHash == bytes32(0)) return false;
        return uint256(keccak256(abi.encode(blockHash, seed, campaignId, nonce))) % odds == 0;
    }

    /// @notice Next gate seed: folds the current prevrandao and the previous block hash into the old seed.
    function nextGateSeed(bytes32 seed, uint256 prevrandao, bytes32 prevBlockHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(seed, prevrandao, prevBlockHash));
    }
}
