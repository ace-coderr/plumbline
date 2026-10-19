// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlumbScore} from "../src/libraries/PlumbScore.sol";

/// @notice Unit and fuzz tests for the pure scoring library.
contract PlumbScoreTest is Test {
    uint256 internal constant BU = 1e18; // base unit (18 decimals)
    uint256 internal constant QU = 1e6; // quote unit (6 decimals)

    function _targets() internal pure returns (PlumbScore.Targets memory) {
        return PlumbScore.Targets({maxSpreadBps: 30, minDepthBase: 10e18, minDepthQuote: 400e6});
    }

    /// @dev A quote that passes every check: 40.00 +/- 10 bps, 20 base each side, fully backed.
    function _good(uint256 nowTs) internal pure returns (PlumbScore.Observation memory o) {
        o = PlumbScore.Observation({
            bidPx: 39.96e18,
            askPx: 40.04e18,
            bidSize: 20e18,
            askSize: 20e18,
            updatedAt: uint64(nowTs),
            maxAge: 2,
            freeBase: 20e18,
            freeQuote: 799.2e6,
            referencePx: 0,
            baseUnit: BU,
            quoteUnit: QU
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Freshness
    // ---------------------------------------------------------------------------------------------

    function test_isFresh_window() public pure {
        assertTrue(PlumbScore.isFresh(100, 2, 100));
        assertTrue(PlumbScore.isFresh(100, 2, 101));
        assertFalse(PlumbScore.isFresh(100, 2, 102), "age == maxAge is stale");
        assertFalse(PlumbScore.isFresh(0, 2, 1), "never posted");
        assertFalse(PlumbScore.isFresh(101, 2, 100), "future stamp");
    }

    function testFuzz_isFresh_matchesDefinition(uint64 updatedAt, uint32 maxAge, uint64 nowTs) public pure {
        bool expected = updatedAt != 0 && nowTs >= updatedAt && uint256(nowTs) - updatedAt < maxAge;
        assertEq(PlumbScore.isFresh(updatedAt, maxAge, nowTs), expected);
    }

    // ---------------------------------------------------------------------------------------------
    // Spread
    // ---------------------------------------------------------------------------------------------

    function test_spread_known() public pure {
        // 39.96 / 40.04 around a 40.00 mid = 20 bps exactly.
        assertEq(PlumbScore.spreadBps(39.96e18, 40.04e18, 0), 20);
        // 1 bp-ish wide quote rounds up rather than down.
        assertEq(PlumbScore.spreadBps(100e18, 100.001e18, 0), 1);
        // Against an external reference equal to the mid, the result is identical.
        assertEq(PlumbScore.spreadBps(39.96e18, 40.04e18, 40e18), 20);
        // Tight but skewed: 40.10/40.18 is 20 bps wide, but 45 bps from a 40.00 reference on the far side.
        assertEq(PlumbScore.spreadBps(40.10e18, 40.18e18, 40e18), 90);
    }

    function testFuzz_spread_matchesFormula(uint128 bid, uint128 width) public pure {
        bid = uint128(bound(bid, 1, type(uint128).max / 4));
        width = uint128(bound(width, 1, type(uint128).max / 4));
        uint256 ask = uint256(bid) + width;
        uint256 got = PlumbScore.spreadBps(bid, ask, 0);
        // Exact rational spread is width * 20000 / (bid + ask); got is its ceiling.
        uint256 num = uint256(width) * 20_000;
        uint256 den = uint256(bid) + ask;
        assertGe(got * den, num, "never under-reports");
        assertLt((got - 1) * den, num, "ceiling, not more");
    }

    function testFuzz_spread_monotonicInAsk(uint128 bid, uint128 w1, uint128 w2) public pure {
        bid = uint128(bound(bid, 1e6, 1e30));
        w1 = uint128(bound(w1, 1, 1e30));
        w2 = uint128(bound(w2, w1, 1e30));
        assertLe(PlumbScore.spreadBps(bid, uint256(bid) + w1, 0), PlumbScore.spreadBps(bid, uint256(bid) + w2, 0));
    }

    function testFuzz_spread_referenceNeverHidesWidth(uint128 bid, uint128 width, uint128 ref) public pure {
        bid = uint128(bound(bid, 1e6, 1e30));
        width = uint128(bound(width, 1, 1e30));
        ref = uint128(bound(ref, 1e6, 1e31));
        uint256 ask = uint256(bid) + width;
        // 2 * max(|ref - bid|, |ask - ref|) >= ask - bid for any ref, so measuring against a reference
        // can make a quote look wider (when skewed) but never narrower than its true width.
        uint256 vsRef = PlumbScore.spreadBps(bid, ask, ref);
        assertGe(vsRef * ref, uint256(width) * 10_000);
    }

    // ---------------------------------------------------------------------------------------------
    // Notional conversions
    // ---------------------------------------------------------------------------------------------

    function test_notional_decimals() public pure {
        // 10 WHYPE at 40 USDC = 400 USDC (6 decimals).
        assertEq(PlumbScore.quoteNotional(10e18, 40e18, BU, QU), 400e6);
        assertEq(PlumbScore.baseForQuote(400e6, 40e18, BU, QU), 10e18);
        // 6-decimal base, 18-decimal quote.
        assertEq(PlumbScore.quoteNotional(2e6, 3e18, 1e6, 1e18), 6e18);
    }

    function testFuzz_roundTrip_neverCreatesValue(uint96 baseAmt, uint96 pxWhole, uint8 bd, uint8 qd) public pure {
        bd = uint8(bound(bd, 0, 18));
        qd = uint8(bound(qd, 0, 18));
        uint256 px = bound(pxWhole, 1, 1e12) * 1e15;
        uint256 bu = 10 ** bd;
        uint256 qu = 10 ** qd;
        uint256 q = PlumbScore.quoteNotional(baseAmt, px, bu, qu);
        uint256 back = PlumbScore.baseForQuote(q, px, bu, qu);
        assertLe(back, baseAmt, "selling then buying back never yields more base");
    }

    // ---------------------------------------------------------------------------------------------
    // evaluate
    // ---------------------------------------------------------------------------------------------

    function test_evaluate_pass() public pure {
        (uint16 mask, uint256 spread) = PlumbScore.evaluate(_targets(), _good(1000), 1000);
        assertEq(mask, 0);
        assertEq(spread, 20);
    }

    function test_evaluate_eachFailure() public pure {
        PlumbScore.Targets memory t = _targets();
        PlumbScore.Observation memory o;
        uint16 mask;

        o = _good(1000);
        (mask,) = PlumbScore.evaluate(t, o, 1002);
        assertEq(mask, PlumbScore.FAIL_STALE);

        o = _good(1000);
        o.askPx = o.bidPx;
        (mask,) = PlumbScore.evaluate(t, o, 1000);
        assertTrue(mask & PlumbScore.FAIL_CROSSED != 0);

        o = _good(1000);
        o.bidPx = 39.9e18; // 40 bps wide
        o.freeQuote = 1_000e6;
        (mask,) = PlumbScore.evaluate(t, o, 1000);
        assertEq(mask, PlumbScore.FAIL_SPREAD);

        o = _good(1000);
        o.askSize = 9e18;
        o.freeBase = 9e18;
        (mask,) = PlumbScore.evaluate(t, o, 1000);
        assertEq(mask, PlumbScore.FAIL_DEPTH_BASE);

        o = _good(1000);
        o.bidSize = 10e18; // 399.6 USDC notional < 400
        (mask,) = PlumbScore.evaluate(t, o, 1000);
        assertEq(mask, PlumbScore.FAIL_DEPTH_QUOTE);

        o = _good(1000);
        o.freeBase = 20e18 - 1;
        (mask,) = PlumbScore.evaluate(t, o, 1000);
        assertEq(mask, PlumbScore.FAIL_INVENTORY_BASE);

        o = _good(1000);
        o.freeQuote = 799.2e6 - 1;
        (mask,) = PlumbScore.evaluate(t, o, 1000);
        assertEq(mask, PlumbScore.FAIL_INVENTORY_QUOTE);
    }

    function test_evaluate_zeroSizesFailEvenWithZeroTargets() public pure {
        PlumbScore.Targets memory t = PlumbScore.Targets({maxSpreadBps: 30, minDepthBase: 0, minDepthQuote: 0});
        PlumbScore.Observation memory o = _good(1000);
        o.bidSize = 0;
        o.askSize = 0;
        (uint16 mask,) = PlumbScore.evaluate(t, o, 1000);
        assertEq(mask, PlumbScore.FAIL_DEPTH_BASE | PlumbScore.FAIL_DEPTH_QUOTE);
    }

    /// @dev Core soundness property: whenever evaluate passes a quote, every individual rule holds.
    function testFuzz_evaluate_passImpliesAllRules(
        uint128 bidPx,
        uint128 askPx,
        uint128 bidSize,
        uint128 askSize,
        uint64 age,
        uint256 freeBase,
        uint256 freeQuote,
        uint16 maxSpread
    ) public pure {
        bidPx = uint128(bound(bidPx, 1e12, 1e24));
        askPx = uint128(bound(askPx, 1e12, 1e24));
        bidSize = uint128(bound(bidSize, 0, 1e24));
        askSize = uint128(bound(askSize, 0, 1e24));
        age = uint64(bound(age, 0, 5));
        freeBase = bound(freeBase, 0, 1e25);
        freeQuote = bound(freeQuote, 0, 1e25);
        maxSpread = uint16(bound(maxSpread, 1, 10_000));
        uint256 nowTs = 1_000_000;
        PlumbScore.Targets memory t = PlumbScore.Targets(maxSpread, 1e18, 10e6);
        PlumbScore.Observation memory o = PlumbScore.Observation(
            bidPx, askPx, bidSize, askSize, uint64(nowTs - age), 2, freeBase, freeQuote, 0, BU, QU
        );
        (uint16 mask, uint256 spread) = PlumbScore.evaluate(t, o, nowTs);
        if (mask == 0) {
            assertLt(age, 2, "fresh");
            assertGt(askPx, bidPx, "not crossed");
            assertLe(spread, maxSpread, "tight");
            assertLe(uint256(askPx - bidPx) * 10_000, uint256(maxSpread) * (uint256(askPx) + bidPx) / 2, "tight exact");
            assertGe(askSize, t.minDepthBase, "deep ask");
            uint256 notional = PlumbScore.quoteNotional(bidSize, bidPx, BU, QU);
            assertGe(notional, t.minDepthQuote, "deep bid");
            assertGe(freeBase, askSize, "base backed");
            assertGe(freeQuote, notional, "quote backed");
        }
    }

    /// @dev Removing inventory can only ever turn a pass into a fail, never the reverse.
    function testFuzz_evaluate_lessInventoryNeverHelps(uint256 cutBase, uint256 cutQuote) public pure {
        PlumbScore.Observation memory o = _good(1000);
        (uint16 before,) = PlumbScore.evaluate(_targets(), o, 1000);
        o.freeBase -= bound(cutBase, 0, o.freeBase);
        o.freeQuote -= bound(cutQuote, 0, o.freeQuote);
        (uint16 afterMask,) = PlumbScore.evaluate(_targets(), o, 1000);
        assertEq(afterMask & before, before, "existing failures persist");
    }

    // ---------------------------------------------------------------------------------------------
    // Shares, fees and slashing
    // ---------------------------------------------------------------------------------------------

    function testFuzz_share_sumNeverExceedsPot(uint128 pot, uint64[6] memory pts) public pure {
        uint256 total;
        for (uint256 i; i < pts.length; ++i) {
            pts[i] = uint64(bound(pts[i], 0, 1e6));
            total += pts[i];
        }
        uint256 sum;
        for (uint256 i; i < pts.length; ++i) {
            sum += PlumbScore.share(pot, pts[i], total);
        }
        assertLe(sum, pot);
        if (total > 0) {
            // Dust is at most one wei per participant.
            assertGe(sum + pts.length, pot);
        } else {
            assertEq(sum, 0);
        }
    }

    function testFuzz_share_proportional(uint128 pot, uint64 a, uint64 b) public pure {
        a = uint64(bound(a, 1, 1e9));
        b = uint64(bound(b, a, 1e9));
        uint256 total = uint256(a) + b;
        assertLe(PlumbScore.share(pot, a, total), PlumbScore.share(pot, b, total), "more points, more reward");
    }

    function testFuzz_probeFee_respectsCap(uint128 reward, uint16 bps, uint128 paid, uint128 cap) public pure {
        bps = uint16(bound(bps, 0, 10_000));
        uint256 fee = PlumbScore.probeFee(reward, bps, paid, cap);
        assertLe(uint256(paid) + fee, paid >= cap ? paid : cap, "never past the cap");
        assertLe(fee, uint256(reward) * bps / 10_000, "never above the nominal fee");
    }

    function testFuzz_probeFee_cumulativeCap(uint128 reward, uint16 bps, uint8 probes) public pure {
        bps = uint16(bound(bps, 1, 10_000));
        uint256 cap = uint256(reward) / 2;
        uint256 paid;
        for (uint256 i; i < probes; ++i) {
            paid += PlumbScore.probeFee(reward, bps, paid, cap);
        }
        assertLe(paid, cap);
    }

    function testFuzz_slash_conserves(uint128 bond, uint16 slashBps, uint16 reporterBps) public pure {
        slashBps = uint16(bound(slashBps, 0, 10_000));
        reporterBps = uint16(bound(reporterBps, 0, 10_000));
        (uint256 slashed, uint256 toReporter, uint256 toMakers) = PlumbScore.slash(bond, slashBps, reporterBps);
        assertLe(slashed, bond, "never more than the bond");
        assertEq(toReporter + toMakers, slashed, "every slashed wei is accounted for");
        assertLe(toReporter, slashed);
    }

    function testFuzz_slash_repeatedDecays(uint128 bond, uint8 rounds) public pure {
        uint256 b = bond;
        for (uint256 i; i < rounds; ++i) {
            (uint256 slashed,,) = PlumbScore.slash(b, 2_000, 5_000);
            uint256 next = b - slashed;
            assertLe(next, b);
            // 20% per slash: the bond after a slash is at least 80% of before, rounded down.
            assertGe(next * 10_000, b * 8_000);
            b = next;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Gate
    // ---------------------------------------------------------------------------------------------

    function test_gateHit_zeroHashNeverOpens() public pure {
        assertFalse(PlumbScore.gateHit(bytes32(0), bytes32(uint256(1)), 1, 0, 1));
    }

    function testFuzz_gateHit_oddsOneAlwaysOpens(bytes32 h, bytes32 r, uint256 id, uint256 nonce) public pure {
        vm.assume(h != bytes32(0));
        assertTrue(PlumbScore.gateHit(h, r, id, nonce, 1));
    }

    function test_gateHit_rateRoughlyMatchesOdds() public pure {
        uint256 hits;
        uint256 trials = 32_768;
        for (uint256 i; i < trials; ++i) {
            if (PlumbScore.gateHit(keccak256(abi.encode(i)), bytes32(uint256(1)), 7, 0, 512)) ++hits;
        }
        // Expected 64. Allow a wide band; this guards against an always/never-open bug.
        assertGt(hits, 30);
        assertLt(hits, 110);
    }

    function testFuzz_nextGateSeed_dependsOnPrevrandao(bytes32 seed, uint256 a, uint256 b, bytes32 h) public pure {
        vm.assume(a != b);
        assertTrue(PlumbScore.nextGateSeed(seed, a, h) != PlumbScore.nextGateSeed(seed, b, h));
    }

    function test_gateHit_nonceChangesOutcome() public pure {
        // A hash that opens the gate for one nonce must not keep opening it for the next.
        uint256 reused;
        for (uint256 i; i < 4096; ++i) {
            bytes32 h = keccak256(abi.encode("h", i));
            if (PlumbScore.gateHit(h, bytes32(uint256(1)), 1, 0, 64) && PlumbScore.gateHit(h, bytes32(uint256(1)), 1, 1, 64)) ++reused;
        }
        assertLt(reused, 8);
    }
}
