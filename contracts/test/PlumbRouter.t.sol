// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./Fixture.sol";
import {PlumbQuote} from "../src/PlumbQuote.sol";
import {PlumbRouter} from "../src/PlumbRouter.sol";
import {PlumbCampaigns} from "../src/PlumbCampaigns.sol";
import {PlumbScore} from "../src/libraries/PlumbScore.sol";

contract PlumbRouterTest is Fixture {
    PlumbQuote internal tight; // makerA, 5 bps half-spread
    PlumbQuote internal wide; // makerB, 20 bps half-spread

    function setUp() public override {
        super.setUp();
        tight = _vault(makerA, botA);
        wide = _vault(makerB, address(0));
        _fund(tight, 100 ether, 4_000e6);
        _fund(wide, 100 ether, 4_000e6);
        _quote(tight, 5, 10 ether);
        _quote(wide, 20, 10 ether);
        quote.mint(taker, 1_000_000e6);
        base.mint(taker, 1_000 ether);
        vm.startPrank(taker);
        quote.approve(address(router), type(uint256).max);
        base.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _buy(uint256 usdcIn, uint256 minOut) internal returns (uint256 out, uint256 refunded) {
        vm.prank(taker);
        (out, refunded) = router.swapExactIn(address(base), address(quote), true, usdcIn, minOut, taker);
    }

    function test_routesToBestAsk() public {
        (uint256 out,) = _buy(40.02e6, 0);
        assertEq(out, 1 ether);
        assertEq(tight.quote().askSize, 9 ether);
        assertEq(wide.quote().askSize, 10 ether);
    }

    function test_routesToBestBid() public {
        vm.prank(taker);
        (uint256 out,) = router.swapExactIn(address(base), address(quote), false, 1 ether, 0, taker);
        assertEq(out, 39.98e6);
        assertEq(tight.quote().bidSize, 9 ether);
    }

    function test_splitsAcrossVaults() public {
        // 15 base: 10 from tight at 40.02, then 5 from wide at 40.08.
        uint256 usdc = 400.2e6 + 200.4e6;
        (uint256 out,) = _buy(usdc, 15 ether);
        assertEq(out, 15 ether);
        assertEq(tight.quote().askSize, 0);
        assertEq(wide.quote().askSize, 5 ether);
    }

    function test_skipsStaleQuotes() public {
        _advance(2);
        _quote(wide, 20, 10 ether);
        (uint256 out,) = _buy(40.08e6, 0);
        assertEq(out, 1 ether, "filled by the only live quote");
        assertEq(tight.quote().askSize, 10 ether);
    }

    function test_revertsWhenBookTooThin() public {
        vm.prank(taker);
        vm.expectRevert(PlumbRouter.NoLiquidity.selector);
        router.swapExactIn(address(base), address(quote), true, 100_000e6, 0, taker);
    }

    function test_respectsLimitPrice() public {
        // 600.6 USDC buys exactly 15 base across both vaults; demanding one wei more must fail.
        vm.prank(taker);
        vm.expectRevert(PlumbRouter.InsufficientOutput.selector);
        router.swapExactIn(address(base), address(quote), true, 600.6e6, 15 ether + 1, taker);
    }

    function test_previewSwap() public view {
        (uint256 out, uint256 filled) = router.previewSwap(address(base), address(quote), true, 600.6e6);
        assertEq(out, 15 ether);
        assertEq(filled, 600.6e6);
    }

    function test_book() public view {
        PlumbRouter.BookEntry[] memory b = router.book(address(base), address(quote));
        assertEq(b.length, 2);
        assertTrue(b[0].live);
        assertEq(b[0].freeBase, 100 ether);
    }

    function test_unbackedQuote_isPenalized_andSwapSurvives() public {
        uint256 id = _open(_terms(), 3);
        PlumbQuote fake = _vault(makerB, address(0));
        _fund(fake, 1 ether, 4_000e6); // holds 1 base
        vm.prank(makerB);
        fake.setQuote(39.99e18, 40.01e18, 10 ether, 10 ether); // best ask, advertises 10 base
        _register(id, fake);

        uint256 bondBefore = campaigns.registration(id, address(fake)).bond;
        vm.expectEmit(true, true, false, false, address(router));
        emit PlumbRouter.FillFailed(address(fake), taker, 0, 0, bytes4(0), true);
        (uint256 out, uint256 refunded) = _buy(400.1e6, 0);

        // The fake vault failed and was slashed; the router moved on to the honest vaults.
        assertEq(out, PlumbScore.baseForQuote(400.1e6, 40.02e18, 1e18, 1e6), "filled by the tight vault");
        assertEq(refunded, 0);
        uint256 bondAfter = campaigns.registration(id, address(fake)).bond;
        assertEq(bondAfter, bondBefore * 8 / 10, "20% slashed");
        assertEq(campaigns.claimable(address(0), taker), bondBefore / 10, "reporter gets half the slash");
    }

    function test_unbackedOnlyQuote_partialRefundKeepsPenalty() public {
        uint256 id = _open(_terms(), 3);
        // Remove the honest vaults from the book so only the fake one is live.
        _advance(2);
        PlumbQuote fake = _vault(makerB, address(0));
        _fund(fake, 1 ether, 0);
        vm.prank(makerB);
        fake.setQuote(39.99e18, 40.01e18, 10 ether, 10 ether);
        _register(id, fake);

        uint256 balBefore = quote.balanceOf(taker);
        (uint256 out, uint256 refunded) = _buy(400.1e6, 0);
        assertEq(out, 0);
        assertEq(refunded, 400.1e6, "taker made whole");
        assertEq(quote.balanceOf(taker), balBefore);
        assertLt(campaigns.registration(id, address(fake)).bond, 5 ether, "penalty persisted");
    }

    function test_nonShortfallFailure_isNotPenalized() public {
        uint256 id = _open(_terms(), 3);
        _register(id, tight);
        // The token refuses to pay this recipient. That is not the maker's fault.
        address blocked = makeAddr("blocked");
        base.setBlocked(blocked, true);
        _advance(2);
        _quote(tight, 5, 10 ether);
        vm.prank(taker);
        vm.expectRevert(PlumbRouter.NoLiquidity.selector);
        router.swapExactIn(address(base), address(quote), true, 40.02e6, 0, blocked);
        assertEq(campaigns.registration(id, address(tight)).bond, 5 ether);
    }

    function test_onlyRouterCanPenalize() public {
        vm.expectRevert(PlumbCampaigns.NotRouter.selector);
        campaigns.penalize(address(tight), taker);
    }

    function testFuzz_swap_neverWorseThanLimit(uint32 usdcIn, uint16 limitBps) public {
        uint256 amountIn = bound(usdcIn, 1e6, 800e6);
        limitBps = uint16(bound(limitBps, 0, 50));
        // Worst acceptable price: 40 * (1 + limitBps).
        uint256 worstPx = 40e18 + 40e18 * uint256(limitBps) / 10_000;
        uint256 minOut = amountIn * 1e12 * 1e18 / worstPx;
        (uint256 out,) = router.previewSwap(address(base), address(quote), true, amountIn);
        vm.prank(taker);
        try router.swapExactIn(address(base), address(quote), true, amountIn, minOut, taker) returns (
            uint256 got, uint256
        ) {
            assertGe(got, minOut);
            assertEq(got, out);
        } catch (bytes memory err) {
            // Either the book cannot meet the limit, or rounding put a chunk a hair below it.
            bytes4 sel = bytes4(err);
            assertTrue(sel == PlumbRouter.NoLiquidity.selector || sel == PlumbRouter.InsufficientOutput.selector);
        }
    }
}
