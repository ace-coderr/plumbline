// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./Fixture.sol";
import {PlumbQuote} from "../src/PlumbQuote.sol";
import {PlumbQuoteFactory} from "../src/PlumbQuoteFactory.sol";
import {MockToken} from "./mocks/MockToken.sol";

contract PlumbQuoteTest is Fixture {
    PlumbQuote internal v;

    function setUp() public override {
        super.setUp();
        v = _vault(makerA, botA);
        _fund(v, 100 ether, 4_000e6);
    }

    function test_constructor_readsDecimals() public view {
        assertEq(v.baseUnit(), 1e18);
        assertEq(v.quoteUnit(), 1e6);
        assertEq(v.maxAge(), MAX_AGE);
        assertEq(v.owner(), makerA);
        assertEq(v.quoter(), botA);
        assertEq(v.factory(), address(factory));
    }

    function test_rejectsOverEighteenDecimals() public {
        MockToken odd = new MockToken("Odd", "ODD", 24);
        vm.expectRevert(PlumbQuote.BadDecimals.selector);
        factory.createVault(address(odd), address(quote), address(0));
    }

    function test_setQuote_byQuoterAndOwner() public {
        vm.prank(botA);
        v.setQuote(39e18, 41e18, 1 ether, 2 ether);
        PlumbQuote.Quote memory q = v.quote();
        assertEq(q.bidPx, 39e18);
        assertEq(q.askSize, 2 ether);
        assertEq(q.updatedAt, vm.getBlockTimestamp());
        assertEq(q.seq, 1);
        vm.prank(makerA);
        v.setQuote(39e18, 41e18, 1 ether, 1 ether);
        assertEq(v.quote().seq, 2);
    }

    function test_setQuote_rejectsStrangers() public {
        vm.prank(taker);
        vm.expectRevert(PlumbQuote.NotQuoter.selector);
        v.setQuote(39e18, 41e18, 1, 1);
    }

    function test_setQuote_rejectsCrossed() public {
        vm.prank(botA);
        vm.expectRevert(PlumbQuote.BadQuote.selector);
        v.setQuote(41e18, 41e18, 1, 1);
        vm.prank(botA);
        vm.expectRevert(PlumbQuote.BadQuote.selector);
        v.setQuote(0, 41e18, 1, 1);
    }

    function test_quoteGoesStaleAfterMaxAge() public {
        _quote(v, 10, 10 ether);
        assertTrue(v.isLive());
        _advance(1);
        assertTrue(v.isLive());
        _advance(1);
        assertFalse(v.isLive());
    }

    function test_cancel() public {
        _quote(v, 10, 10 ether);
        vm.prank(botA);
        v.cancel();
        assertFalse(v.isLive());
        (, PlumbQuote.FillStatus st) = v.previewFill(true, 1e6);
        assertEq(uint8(st), uint8(PlumbQuote.FillStatus.Stale));
    }

    function test_quoterCannotWithdraw() public {
        vm.prank(botA);
        vm.expectRevert(PlumbQuote.NotOwner.selector);
        v.requestWithdraw(address(base), 1 ether);
        vm.prank(botA);
        vm.expectRevert(PlumbQuote.NotOwner.selector);
        v.setQuoter(botA);
    }

    function test_withdraw_timelock() public {
        vm.prank(makerA);
        v.requestWithdraw(address(base), 40 ether);
        assertEq(v.freeBalance(address(base)), 60 ether, "pending stops counting immediately");
        vm.prank(makerA);
        vm.expectRevert(PlumbQuote.NotReady.selector);
        v.executeWithdraw(address(base), makerA);
        _advance(WITHDRAW_DELAY);
        vm.prank(makerA);
        v.executeWithdraw(address(base), makerA);
        assertEq(base.balanceOf(makerA), 40 ether);
        assertEq(v.freeBalance(address(base)), 60 ether);
    }

    function test_withdraw_cancel() public {
        vm.prank(makerA);
        v.requestWithdraw(address(quote), 1_000e6);
        vm.prank(makerA);
        v.cancelWithdraw(address(quote));
        assertEq(v.freeBalance(address(quote)), 4_000e6);
    }

    function test_withdraw_cappedAtBalance() public {
        vm.prank(makerA);
        v.requestWithdraw(address(base), 500 ether);
        assertEq(v.freeBalance(address(base)), 0);
        _advance(WITHDRAW_DELAY);
        vm.prank(makerA);
        v.executeWithdraw(address(base), makerA);
        assertEq(base.balanceOf(makerA), 100 ether);
    }

    function test_deposit() public {
        base.mint(makerA, 5 ether);
        vm.startPrank(makerA);
        base.approve(address(v), 5 ether);
        v.deposit(address(base), 5 ether);
        vm.stopPrank();
        assertEq(base.balanceOf(address(v)), 105 ether);
        vm.expectRevert(PlumbQuote.BadToken.selector);
        v.deposit(address(0xdead), 1);
    }

    function test_fill_buyBase() public {
        _quote(v, 10, 10 ether); // ask 40.04
        quote.mint(taker, 40.04e6);
        vm.startPrank(taker);
        quote.approve(address(v), type(uint256).max);
        uint256 out = v.fill(true, 40.04e6, 0, taker);
        vm.stopPrank();
        assertEq(out, 1 ether);
        assertEq(base.balanceOf(taker), 1 ether);
        assertEq(v.quote().askSize, 9 ether, "size consumed");
    }

    function test_fill_sellBase() public {
        _quote(v, 10, 10 ether); // bid 39.96
        base.mint(taker, 2 ether);
        vm.startPrank(taker);
        base.approve(address(v), type(uint256).max);
        uint256 out = v.fill(false, 2 ether, 0, taker);
        vm.stopPrank();
        assertEq(out, 79.92e6);
        assertEq(v.quote().bidSize, 8 ether);
    }

    function test_fill_revertsWhenStale() public {
        _quote(v, 10, 10 ether);
        _advance(2);
        quote.mint(taker, 1e6);
        vm.startPrank(taker);
        quote.approve(address(v), type(uint256).max);
        vm.expectRevert(PlumbQuote.QuoteStale.selector);
        v.fill(true, 1e6, 0, taker);
        vm.stopPrank();
    }

    function test_fill_revertsOverSize() public {
        _quote(v, 10, 1 ether);
        quote.mint(taker, 100e6);
        vm.startPrank(taker);
        quote.approve(address(v), type(uint256).max);
        vm.expectRevert(PlumbQuote.SizeExceeded.selector);
        v.fill(true, 100e6, 0, taker);
        vm.stopPrank();
    }

    function test_fill_revertsWhenUnbacked() public {
        // Quote 500 base while holding 100.
        _quote(v, 10, 500 ether);
        quote.mint(taker, 8_000e6);
        vm.startPrank(taker);
        quote.approve(address(v), type(uint256).max);
        vm.expectRevert(PlumbQuote.InsufficientInventory.selector);
        v.fill(true, 8_000e6, 0, taker);
        vm.stopPrank();
        (, PlumbQuote.FillStatus st) = v.previewFill(true, 8_000e6);
        assertEq(uint8(st), uint8(PlumbQuote.FillStatus.InsufficientInventory));
    }

    function test_fill_pendingWithdrawalNotFillable() public {
        _quote(v, 10, 50 ether);
        vm.prank(makerA);
        v.requestWithdraw(address(base), 80 ether);
        (, PlumbQuote.FillStatus st) = v.previewFill(true, 40.04e6 * 30);
        assertEq(uint8(st), uint8(PlumbQuote.FillStatus.InsufficientInventory));
    }

    function test_probeSnapshot() public {
        _quote(v, 10, 10 ether);
        (PlumbQuote.Quote memory q, uint32 age, uint256 fb, uint256 fq) = v.probeSnapshot();
        assertEq(q.askSize, 10 ether);
        assertEq(age, MAX_AGE);
        assertEq(fb, 100 ether);
        assertEq(fq, 4_000e6);
    }

    function testFuzz_fill_neverPaysMoreThanQuoted(uint64 inUsdc, uint16 halfBps) public {
        halfBps = uint16(bound(halfBps, 1, 500));
        _quote(v, halfBps, 50 ether);
        uint256 amountIn = bound(inUsdc, 1, 1_900e6);
        (uint256 expect, PlumbQuote.FillStatus st) = v.previewFill(true, amountIn);
        vm.assume(st == PlumbQuote.FillStatus.Ok);
        quote.mint(taker, amountIn);
        vm.startPrank(taker);
        quote.approve(address(v), amountIn);
        uint256 out = v.fill(true, amountIn, 0, taker);
        vm.stopPrank();
        assertEq(out, expect);
        // Paid at or above the ask: out * ask <= in, in raw-unit terms.
        assertLe(out * v.quote().askPx / 1e18 / 1e12, amountIn);
    }

    // --- factory --------------------------------------------------------------------------------

    function test_factory_listsPair() public view {
        PlumbQuoteFactory.Pair[] memory p = factory.pairs();
        assertEq(p.length, 1);
        assertEq(p[0].base, address(base));
        assertEq(factory.vaultsOf(address(base), address(quote)).length, 1);
        assertTrue(factory.isVault(address(v)));
    }

    function test_factory_pruneDeadVault() public {
        vm.expectRevert(PlumbQuoteFactory.NotPrunable.selector);
        factory.prune(address(v));
        _advance(factory.PRUNE_AFTER());
        factory.prune(address(v));
        assertEq(factory.vaultsOf(address(base), address(quote)).length, 0);
        vm.prank(makerA);
        factory.relist(address(v));
        assertEq(factory.vaultsOf(address(base), address(quote)).length, 1);
    }

    function test_factory_cap() public {
        for (uint256 i = 1; i < factory.MAX_LISTED(); ++i) {
            factory.createVault(address(base), address(quote), address(0));
        }
        vm.expectRevert(PlumbQuoteFactory.PairFull.selector);
        factory.createVault(address(base), address(quote), address(0));
    }
}
