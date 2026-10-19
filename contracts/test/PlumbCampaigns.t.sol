// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./Fixture.sol";
import {PlumbQuote} from "../src/PlumbQuote.sol";
import {PlumbCampaigns} from "../src/PlumbCampaigns.sol";
import {PlumbScore} from "../src/libraries/PlumbScore.sol";
import {MockReference} from "./mocks/MockReference.sol";
import {MockToken} from "./mocks/MockToken.sol";

contract PlumbCampaignsTest is Fixture {
    PlumbQuote internal va; // makerA: 10 bps half spread, fully backed
    PlumbQuote internal vb; // makerB: 14 bps half spread, fully backed
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        va = _vault(makerA, botA);
        vb = _vault(makerB, address(0));
        _fund(va, 100 ether, 4_000e6);
        _fund(vb, 100 ether, 4_000e6);
        id = _open(_terms(), 3);
        _register(id, va);
        _register(id, vb);
    }

    function _refresh() internal {
        _quote(va, 10, 20 ether);
        _quote(vb, 14, 20 ether);
    }

    function _probeFresh() internal returns (uint256 passed) {
        _refresh();
        passed = _probe(id);
    }

    function _nextProbeWindow() internal {
        _advance(_terms().minProbeInterval);
    }

    function _toEpochEnd(uint256 epoch) internal {
        uint256 end = campaigns.state(id).startTime + (epoch + 1) * _terms().epochLength;
        vm.warp(end);
        vm.roll(vm.getBlockNumber() + 1);
    }

    // ---------------------------------------------------------------------------------------------
    // Opening
    // ---------------------------------------------------------------------------------------------

    function test_open_fundsPot() public view {
        assertEq(address(campaigns).balance, 300 ether + 10 ether, "pot plus two bonds");
        PlumbCampaigns.State memory s = campaigns.state(id);
        assertEq(s.creator, sponsor);
        assertEq(s.numEpochs, 3);
        assertEq(campaigns.vaultsOf(id).length, 2);
    }

    function test_open_rejectsBadTerms() public {
        PlumbCampaigns.Campaign memory t = _terms();
        t.epochLength = 10;
        vm.expectRevert(PlumbCampaigns.BadTerms.selector);
        campaigns.openCampaign(t, address(0), 1, 0, address(0));

        t = _terms();
        t.probeFeeBps = 200; // 30 probes * 2% = 60% of pot > 50% cap
        vm.expectRevert(PlumbCampaigns.BadTerms.selector);
        campaigns.openCampaign(t, address(0), 1, 0, address(0));

        t = _terms();
        vm.deal(address(this), 1 ether);
        vm.expectRevert(PlumbCampaigns.BadFunding.selector);
        campaigns.openCampaign{value: 1 ether}(t, address(0), 1, 0, address(0));
    }

    function test_open_erc20Rewards() public {
        PlumbCampaigns.Campaign memory t = _terms();
        t.rewardPerEpoch = 500e6;
        t.makerBond = 50e6;
        quote.mint(sponsor, 1_000e6);
        vm.startPrank(sponsor);
        quote.approve(address(campaigns), 1_000e6);
        uint256 cid = campaigns.openCampaign(t, address(quote), 2, 0, address(0));
        vm.stopPrank();
        assertEq(quote.balanceOf(address(campaigns)), 1_000e6);
        assertEq(campaigns.state(cid).rewardToken, address(quote));
    }

    // ---------------------------------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------------------------------

    function test_register_onlyOwner() public {
        PlumbQuote v = _vault(makerA, address(0));
        vm.deal(taker, 5 ether);
        vm.prank(taker);
        vm.expectRevert(PlumbCampaigns.NotMaker.selector);
        campaigns.register{value: 5 ether}(id, address(v));
    }

    function test_register_wrongPair() public {
        MockToken other = new MockToken("Other", "OTH", 18);
        vm.prank(makerA);
        address v = factory.createVault(address(other), address(quote), address(0));
        vm.deal(makerA, 5 ether);
        vm.prank(makerA);
        vm.expectRevert(PlumbCampaigns.WrongPair.selector);
        campaigns.register{value: 5 ether}(id, v);
    }

    function test_register_needsExactBond() public {
        PlumbQuote v = _vault(makerA, address(0));
        vm.deal(makerA, 4 ether);
        vm.prank(makerA);
        vm.expectRevert(PlumbCampaigns.BadFunding.selector);
        campaigns.register{value: 4 ether}(id, address(v));
    }

    function test_register_twice() public {
        vm.deal(makerA, 5 ether);
        vm.prank(makerA);
        vm.expectRevert(PlumbCampaigns.AlreadyRegistered.selector);
        campaigns.register{value: 5 ether}(id, address(va));
    }

    function test_register_rejectsForeignContract() public {
        vm.deal(makerA, 5 ether);
        vm.prank(makerA);
        vm.expectRevert(PlumbCampaigns.NotVault.selector);
        campaigns.register{value: 5 ether}(id, address(base));
    }

    // ---------------------------------------------------------------------------------------------
    // Probing
    // ---------------------------------------------------------------------------------------------

    function test_probe_awardsPointsToPassingVaults() public {
        uint256 passed = _probeFresh();
        assertEq(passed, 2);
        assertEq(campaigns.pointsOf(id, 0, address(va)), 1);
        assertEq(campaigns.pointsOf(id, 0, address(vb)), 1);
        PlumbCampaigns.Epoch memory e = campaigns.epochInfo(id, 0);
        assertEq(e.probes, 1);
        assertEq(e.totalPoints, 2);
    }

    function test_probe_paysProber() public {
        _probeFresh();
        // 10 bps of a 100 HYPE pot.
        assertEq(campaigns.claimable(address(0), keeper), 0.1 ether);
        vm.prank(keeper);
        campaigns.claim(address(0));
        assertEq(keeper.balance, 0.1 ether);
    }

    function test_probe_failsStaleQuote() public {
        _quote(va, 10, 20 ether);
        _advance(2);
        _quote(vb, 14, 20 ether);
        uint256 passed = _probe(id);
        assertEq(passed, 1);
        assertEq(campaigns.pointsOf(id, 0, address(va)), 0);
    }

    function test_probe_failsWideSpread() public {
        _quote(va, 16, 20 ether); // 32 bps > 30
        _quote(vb, 14, 20 ether); // 28 bps
        assertEq(_probe(id), 1);
        assertEq(campaigns.pointsOf(id, 0, address(vb)), 1);
    }

    function test_probe_failsThinDepth() public {
        _quote(va, 10, 9 ether); // below 10 base min depth
        _quote(vb, 14, 20 ether);
        assertEq(_probe(id), 1);
    }

    function test_probe_failsUnbackedQuote() public {
        // makerA quotes 200 base while holding 100: a claim the vault cannot honour.
        _quote(va, 10, 200 ether);
        _quote(vb, 14, 20 ether);
        vm.recordLogs();
        assertEq(_probe(id), 1);
        assertEq(campaigns.pointsOf(id, 0, address(va)), 0);
    }

    function test_probe_pendingWithdrawalCountsAgainstInventory() public {
        vm.prank(makerA);
        va.requestWithdraw(address(base), 90 ether);
        _refresh();
        assertEq(_probe(id), 1, "inventory leaving the vault does not count");
    }

    function test_probe_failMaskEmitted() public {
        _quote(va, 16, 200 ether);
        _quote(vb, 14, 20 ether);
        _openGate(id);
        vm.expectEmit(true, true, true, false, address(campaigns));
        emit PlumbCampaigns.ProbeResult(
            id,
            0,
            address(va),
            0,
            false,
            PlumbScore.FAIL_SPREAD | PlumbScore.FAIL_INVENTORY_BASE | PlumbScore.FAIL_INVENTORY_QUOTE,
            32,
            0,
            0,
            0,
            0
        );
        vm.prank(keeper);
        campaigns.probe(id);
    }

    function test_probe_skipsUnbonding() public {
        vm.prank(makerA);
        campaigns.requestUnbond(id, address(va));
        assertEq(_probeFresh(), 1);
        assertEq(campaigns.pointsOf(id, 0, address(va)), 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Gate and jitter
    // ---------------------------------------------------------------------------------------------

    function test_gate_closedWithoutHit() public {
        // No planted hashes: forge's blockhash is zero, so no hash can open the gate.
        vm.roll(vm.getBlockNumber() + 20);
        assertFalse(campaigns.probeGateOpen(id));
        vm.prank(keeper);
        vm.expectRevert(PlumbCampaigns.GateClosed.selector);
        campaigns.probe(id);
    }

    function test_gate_respectsMinInterval() public {
        _probeFresh();
        _advance(19);
        // Even a winning hash cannot open the gate before minProbeInterval.
        uint256 nonce = campaigns.state(id).probeNonce;
        for (uint256 salt;; ++salt) {
            bytes32 h = keccak256(abi.encode(salt));
            if (PlumbScore.gateHit(h, campaigns.state(id).gateSeed, id, nonce, campaigns.GATE_ODDS())) {
                vm.setBlockhash(vm.getBlockNumber(), h);
                vm.roll(vm.getBlockNumber() + 1);
                break;
            }
        }
        assertFalse(campaigns.probeGateOpen(id));
        _advance(1);
        assertTrue(campaigns.probeGateOpen(id), "opens once the interval has passed, hash still in window");
    }

    function test_gate_hitExpiresAfterWindow() public {
        _openGate(id);
        vm.roll(vm.getBlockNumber() + campaigns.GATE_WINDOW() - 1);
        assertTrue(campaigns.probeGateOpen(id), "still inside the window");
        vm.roll(vm.getBlockNumber() + 1);
        assertFalse(campaigns.probeGateOpen(id), "window passed");
    }

    function test_gate_windowSurvivesChangingPrevrandao() public {
        // On chains where prevrandao changes every block, a hit must still hold for the whole window.
        _openGate(id);
        for (uint256 i = 1; i < campaigns.GATE_WINDOW(); ++i) {
            vm.prevrandao(bytes32(uint256(keccak256(abi.encode("rand", i)))));
            vm.roll(vm.getBlockNumber() + 1);
            assertTrue(campaigns.probeGateOpen(id), "open through the window");
        }
    }

    function test_gate_seedRotatesOnProbe() public {
        bytes32 before = campaigns.state(id).gateSeed;
        assertTrue(before != bytes32(0));
        _probeFresh();
        assertTrue(campaigns.state(id).gateSeed != before);
    }

    function test_gate_closesAfterProbe() public {
        PlumbCampaigns.State memory before = campaigns.state(id);
        _probeFresh();
        assertFalse(campaigns.probeGateOpen(id), "min interval restarts");
        // Hits under the old seed and nonce are independent of hits under the new ones: a hash that
        // opened the gate before is no more likely than any other to open it again.
        PlumbCampaigns.State memory afterProbe = campaigns.state(id);
        uint256 odds = campaigns.GATE_ODDS();
        uint256 oldHits;
        uint256 both;
        for (uint256 i; i < 40_000; ++i) {
            bytes32 h = keccak256(abi.encode("carry", i));
            if (!PlumbScore.gateHit(h, before.gateSeed, id, before.probeNonce, odds)) continue;
            ++oldHits;
            if (PlumbScore.gateHit(h, afterProbe.gateSeed, id, afterProbe.probeNonce, odds)) ++both;
        }
        assertGt(oldHits, 40);
        // Independent draws: about oldHits / GATE_ODDS overlaps are expected by chance alone.
        assertLt(both, oldHits / 20, "old hits do not carry over");
    }

    function test_gate_closedBeforeStartAndAfterEnd() public {
        PlumbCampaigns.Campaign memory t = _terms();
        vm.deal(sponsor, 100 ether);
        vm.prank(sponsor);
        uint256 later = campaigns.openCampaign{value: 100 ether}(t, address(0), 1, uint64(vm.getBlockTimestamp() + 100), address(0));
        assertFalse(campaigns.probeGateOpen(later));
        vm.warp(vm.getBlockTimestamp() + 100 + 600);
        assertFalse(campaigns.probeGateOpen(later));
    }

    function testFuzz_gate_hitFrequency(uint256 seed) public {
        // Each block is open when any of the last GATE_WINDOW hashes hit: 1 - (63/64)^8, about 11.8%.
        uint256 openBlocks;
        uint256 blocks = 1_024;
        for (uint256 i; i < blocks; ++i) {
            vm.setBlockhash(vm.getBlockNumber(), keccak256(abi.encode(seed, i)));
            vm.roll(vm.getBlockNumber() + 1);
            if (campaigns.probeGateOpen(id)) ++openBlocks;
        }
        // Openings arrive as ~16 Poisson hits, each holding the gate for up to 8 blocks: mean ~121
        // open blocks, sd ~32. These bounds only catch always-open or never-open regressions.
        assertGt(openBlocks, 0);
        assertLt(openBlocks, 400);
    }

    // ---------------------------------------------------------------------------------------------
    // Fees
    // ---------------------------------------------------------------------------------------------

    function test_probeFees_cappedPerEpoch() public {
        PlumbCampaigns.Campaign memory t = _terms();
        t.probeFeeBps = 1_000; // 10% per probe
        t.minProbeInterval = 100; // 6 probes per epoch max -> 60% nominal, rejected
        vm.deal(sponsor, 100 ether);
        vm.prank(sponsor);
        vm.expectRevert(PlumbCampaigns.BadTerms.selector);
        campaigns.openCampaign{value: 100 ether}(t, address(0), 1, 0, address(0));

        t.minProbeInterval = 120; // 5 probes * 10% = 50%, allowed
        vm.prank(sponsor);
        uint256 cid = campaigns.openCampaign{value: 100 ether}(t, address(0), 1, 0, address(0));
        _register(cid, va);
        for (uint256 i; i < 5; ++i) {
            _quote(va, 10, 20 ether);
            _probe(cid);
            _advance(120);
        }
        assertLe(campaigns.epochInfo(cid, 0).probeFeesPaid, 50 ether);
    }

    function test_probeFee_zeroWhenNoVaults() public {
        PlumbCampaigns.Campaign memory t = _terms();
        vm.deal(sponsor, 100 ether);
        vm.prank(sponsor);
        uint256 cid = campaigns.openCampaign{value: 100 ether}(t, address(0), 1, 0, address(0));
        _probe(cid);
        assertEq(campaigns.claimable(address(0), keeper), 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------------------------------

    function test_settle_proRata() public {
        // Three probes: va passes all three, vb passes one.
        _probeFresh();
        _nextProbeWindow();
        _quote(va, 10, 20 ether);
        _quote(vb, 20, 20 ether); // too wide
        _probe(id);
        _nextProbeWindow();
        _quote(va, 10, 20 ether);
        _quote(vb, 20, 20 ether);
        _probe(id);

        vm.expectRevert(PlumbCampaigns.EpochNotOver.selector);
        campaigns.settle(id);

        _toEpochEnd(0);
        assertEq(campaigns.settle(id), 0);

        uint256 pot = 100 ether - 3 * 0.1 ether;
        assertEq(campaigns.claimable(address(0), makerA), pot * 3 / 4);
        assertEq(campaigns.claimable(address(0), makerB), pot * 1 / 4);
        assertEq(campaigns.claimable(address(0), sponsor), 0, "no dust on an even split");
        assertTrue(campaigns.epochInfo(id, 0).settled);

        uint256 before = makerA.balance;
        vm.prank(makerA);
        campaigns.claim(address(0));
        assertEq(makerA.balance - before, pot * 3 / 4);
    }

    function test_settle_emptyEpochRefundsSponsor() public {
        _toEpochEnd(0);
        campaigns.settle(id);
        assertEq(campaigns.claimable(address(0), sponsor), 100 ether);
    }

    function test_settle_inOrderOnly() public {
        _toEpochEnd(1);
        assertEq(campaigns.settle(id), 0);
        assertEq(campaigns.settle(id), 1);
        vm.expectRevert(PlumbCampaigns.EpochNotOver.selector);
        campaigns.settle(id);
        _toEpochEnd(2);
        campaigns.settle(id);
        vm.expectRevert(PlumbCampaigns.NothingToSettle.selector);
        campaigns.settle(id);
    }

    // ---------------------------------------------------------------------------------------------
    // Penalties
    // ---------------------------------------------------------------------------------------------

    function _fakeFill() internal returns (uint256 refunded) {
        // va advertises far more base than it holds, at the best price on the book.
        vm.prank(makerA);
        va.setQuote(39.99e18, 40.01e18, 500 ether, 500 ether);
        quote.mint(taker, 20_000e6);
        vm.startPrank(taker);
        quote.approve(address(router), type(uint256).max);
        (, refunded) = router.swapExactIn(address(base), address(quote), true, 20_000e6, 0, taker);
        vm.stopPrank();
    }

    function test_penalize_slashesAndForfeits() public {
        _probeFresh();
        assertEq(campaigns.pointsOf(id, 0, address(va)), 1);
        _advance(1);
        _quote(vb, 14, 20 ether);
        uint256 refunded = _fakeFill();
        assertGt(refunded, 0, "partial fill refunded so the penalty sticks");

        PlumbCampaigns.Registration memory r = campaigns.registration(id, address(va));
        assertEq(r.bond, 4 ether);
        assertEq(campaigns.claimable(address(0), taker), 0.5 ether);
        assertEq(campaigns.pointsOf(id, 0, address(va)), 0, "current-epoch points forfeited");
        PlumbCampaigns.Epoch memory e = campaigns.epochInfo(id, 0);
        assertEq(e.slashBonus, 0.5 ether);
        assertEq(e.totalPoints, 1);

        // The honest maker collects the whole pot, including the slashed bond.
        _toEpochEnd(0);
        campaigns.settle(id);
        assertEq(campaigns.claimable(address(0), makerB), 100 ether - 0.1 ether + 0.5 ether);
    }

    function test_penalize_cooldown() public {
        _fakeFill();
        _advance(1);
        _fakeFill();
        assertEq(campaigns.registration(id, address(va)).bond, 4 ether, "second report inside cooldown ignored");
        _advance(20);
        _fakeFill();
        assertEq(campaigns.registration(id, address(va)).bond, 3.2 ether);
    }

    function test_penalize_underbondedStopsScoring() public {
        _fakeFill();
        _nextProbeWindow();
        _refresh();
        _openGate(id);
        vm.expectEmit(true, true, true, false, address(campaigns));
        emit PlumbCampaigns.ProbeResult(id, 0, address(va), 0, false, PlumbScore.FAIL_BOND, 0, 0, 0, 0, 0);
        vm.prank(keeper);
        assertEq(campaigns.probe(id), 1);

        // Topping the bond back up restores eligibility.
        vm.deal(makerA, 1 ether);
        vm.prank(makerA);
        campaigns.topUpBond{value: 1 ether}(id, address(va), 1 ether);
        _nextProbeWindow();
        assertEq(_probeFresh(), 2);
    }

    function test_penalize_unknownVaultIsNoop() public {
        PlumbQuote stray = _vault(makerB, address(0));
        _fund(stray, 1 ether, 0);
        vm.prank(makerB);
        stray.setQuote(39.9e18, 40.0e18, 10 ether, 10 ether);
        _advance(2);
        vm.prank(makerB);
        stray.setQuote(39.9e18, 40.0e18, 10 ether, 10 ether);
        quote.mint(taker, 400e6);
        vm.startPrank(taker);
        quote.approve(address(router), type(uint256).max);
        (uint256 out, uint256 refunded) = router.swapExactIn(address(base), address(quote), true, 400e6, 0, taker);
        vm.stopPrank();
        assertEq(out, 0);
        assertEq(refunded, 400e6);
    }

    // ---------------------------------------------------------------------------------------------
    // Unbonding
    // ---------------------------------------------------------------------------------------------

    function test_unbond_lifecycle() public {
        _probeFresh();
        vm.prank(makerA);
        campaigns.requestUnbond(id, address(va));

        vm.prank(makerA);
        vm.expectRevert(PlumbCampaigns.StillBonded.selector);
        campaigns.releaseBond(id, address(va));

        _toEpochEnd(0);
        vm.prank(makerA);
        vm.expectRevert(PlumbCampaigns.StillBonded.selector);
        campaigns.releaseBond(id, address(va)); // epoch 0 not settled yet

        campaigns.settle(id);
        vm.prank(makerA);
        campaigns.releaseBond(id, address(va));
        uint256 owed = campaigns.claimable(address(0), makerA);
        assertEq(owed, 5 ether + (100 ether - 0.1 ether) / 2, "bond plus epoch-0 rewards");
        assertEq(campaigns.vaultsOf(id).length, 1);
        assertEq(campaigns.campaignsOf(address(va)).length, 0);
    }

    function test_unbond_stillSlashable() public {
        vm.prank(makerA);
        campaigns.requestUnbond(id, address(va));
        _fakeFill();
        assertEq(campaigns.registration(id, address(va)).bond, 4 ether);
    }

    // ---------------------------------------------------------------------------------------------
    // Reference price seam
    // ---------------------------------------------------------------------------------------------

    function test_reference_scoresAgainstOracle() public {
        MockReference ref = new MockReference();
        ref.set(40.2e18, uint64(vm.getBlockTimestamp()));
        PlumbCampaigns.Campaign memory t = _terms();
        vm.deal(sponsor, 100 ether);
        vm.prank(sponsor);
        uint256 cid = campaigns.openCampaign{value: 100 ether}(t, address(0), 1, 0, address(ref));
        _register(cid, va);
        // va is tight around 40.00, but 40.2 is the reference: effective spread ~120 bps, fails.
        _quote(va, 10, 20 ether);
        assertEq(_probe(cid), 0);

        // Reference goes stale; scoring falls back to the quote's own mid and va passes.
        _advance(campaigns.MAX_REFERENCE_AGE() + 1);
        _quote(va, 10, 20 ether);
        assertEq(_probe(cid), 1);

        // A reverting reference source also falls back rather than blocking probes.
        ref.setBroken(true);
        _advance(t.minProbeInterval);
        _quote(va, 10, 20 ether);
        assertEq(_probe(cid), 1);
    }

    // ---------------------------------------------------------------------------------------------
    // Solvency under fuzzed activity
    // ---------------------------------------------------------------------------------------------

    /// @dev Whatever sequence of probes, slashes and settlements happens, the contract always holds
    ///      enough HYPE to pay every claimable balance, every live bond, and every unsettled pot.
    function testFuzz_solvency(uint8 rounds, uint256 seed) public {
        rounds = uint8(bound(rounds, 1, 40));
        for (uint256 i; i < rounds; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 action = r % 4;
            if (action == 0 || action == 1) {
                if (vm.getBlockTimestamp() < campaigns.endTime(id)) {
                    _refresh();
                    _probe(id);
                }
            } else if (action == 2) {
                _fakeFill();
                // Restore an honest quote so later probes have something to score.
                _quote(va, 10, 20 ether);
            } else {
                PlumbCampaigns.State memory s = campaigns.state(id);
                if (s.settledEpochs < s.numEpochs) {
                    uint256 end = s.startTime + (uint256(s.settledEpochs) + 1) * _terms().epochLength;
                    if (vm.getBlockTimestamp() >= end) campaigns.settle(id);
                }
            }
            _advance(20 + (r >> 8) % 200);
        }
        _assertSolvent();
    }

    function _assertSolvent() internal view {
        address[6] memory accounts = [makerA, makerB, sponsor, keeper, taker, address(this)];
        uint256 owed;
        for (uint256 i; i < accounts.length; ++i) {
            owed += campaigns.claimable(address(0), accounts[i]);
        }
        address[] memory vs = campaigns.vaultsOf(id);
        for (uint256 i; i < vs.length; ++i) {
            owed += campaigns.registration(id, vs[i]).bond;
        }
        PlumbCampaigns.State memory s = campaigns.state(id);
        for (uint256 e = s.settledEpochs; e < s.numEpochs; ++e) {
            PlumbCampaigns.Epoch memory ep = campaigns.epochInfo(id, e);
            owed += 100 ether - ep.probeFeesPaid + ep.slashBonus;
        }
        assertGe(address(campaigns).balance, owed, "solvent");
        assertEq(address(campaigns).balance, owed, "and exactly accounted for");
    }
}
