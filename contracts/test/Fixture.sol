// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlumbQuote} from "../src/PlumbQuote.sol";
import {PlumbQuoteFactory} from "../src/PlumbQuoteFactory.sol";
import {PlumbRouter} from "../src/PlumbRouter.sol";
import {PlumbCampaigns} from "../src/PlumbCampaigns.sol";
import {IPlumbPenalizer} from "../src/interfaces/IPlumbPenalizer.sol";
import {PlumbScore} from "../src/libraries/PlumbScore.sol";
import {MockToken} from "./mocks/MockToken.sol";

/// @notice Shared deployment and helpers for Plumbline tests. Mirrors the production deploy order:
///         factory, campaigns (pointing at the router's precomputed address), router.
abstract contract Fixture is Test {
    uint32 internal constant MAX_AGE = 2;
    uint32 internal constant WITHDRAW_DELAY = 30;
    uint256 internal constant PX = 40e18; // 40 quote per base

    MockToken internal base; // 18 decimals, like WHYPE
    MockToken internal quote; // 6 decimals, like USDC
    PlumbQuoteFactory internal factory;
    PlumbCampaigns internal campaigns;
    PlumbRouter internal router;

    address internal sponsor = makeAddr("sponsor");
    address internal makerA = makeAddr("makerA");
    address internal makerB = makeAddr("makerB");
    address internal botA = makeAddr("botA");
    address internal taker = makeAddr("taker");
    address internal keeper = makeAddr("keeper");

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.roll(1_000);
        vm.prevrandao(bytes32(uint256(1))); // Orbit chains report a constant prevrandao of 1
        base = new MockToken("Wrapped HYPE", "WHYPE", 18);
        quote = new MockToken("USD Coin", "USDC", 6);
        factory = new PlumbQuoteFactory(MAX_AGE, WITHDRAW_DELAY);
        address predictedRouter = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        campaigns = new PlumbCampaigns(factory, predictedRouter);
        router = new PlumbRouter(factory, IPlumbPenalizer(address(campaigns)));
        assertEq(address(router), predictedRouter, "router address prediction");
    }

    // --- vaults ---------------------------------------------------------------------------------

    function _vault(address maker, address bot) internal returns (PlumbQuote v) {
        vm.prank(maker);
        v = PlumbQuote(factory.createVault(address(base), address(quote), bot));
    }

    function _fund(PlumbQuote v, uint256 baseAmt, uint256 quoteAmt) internal {
        base.mint(address(v), baseAmt);
        quote.mint(address(v), quoteAmt);
    }

    /// @dev Quote symmetric around PX with `halfBps` either side.
    function _quote(PlumbQuote v, uint256 halfBps, uint128 size) internal {
        uint128 bid = uint128(PX - PX * halfBps / 10_000);
        uint128 ask = uint128(PX + PX * halfBps / 10_000);
        vm.prank(v.owner());
        v.setQuote(bid, ask, size, size);
    }

    // --- campaigns ------------------------------------------------------------------------------

    function _terms() internal view returns (PlumbCampaigns.Campaign memory t) {
        t = PlumbCampaigns.Campaign({
            base: address(base),
            quote: address(quote),
            epochLength: 600,
            rewardPerEpoch: 100 ether,
            maxSpreadBps: 30,
            minDepthBase: 10 ether,
            minDepthQuote: 400e6,
            minProbeInterval: 20,
            probeFeeBps: 10,
            makerBond: 5 ether
        });
    }

    function _open(PlumbCampaigns.Campaign memory t, uint32 epochs) internal returns (uint256 id) {
        uint256 total = t.rewardPerEpoch * epochs;
        vm.deal(sponsor, total);
        vm.prank(sponsor);
        id = campaigns.openCampaign{value: total}(t, address(0), epochs, 0, address(0));
    }

    function _register(uint256 id, PlumbQuote v) internal {
        uint256 bond = campaigns.terms(id).makerBond;
        address maker = v.owner();
        vm.deal(maker, maker.balance + bond);
        vm.prank(maker);
        campaigns.register{value: bond}(id, address(v));
    }

    /// @dev Advance blocks until the jitter gate opens for `id`, planting block hashes as needed.
    function _openGate(uint256 id) internal returns (bytes32 h) {
        PlumbCampaigns.State memory s = campaigns.state(id);
        uint256 odds = campaigns.GATE_ODDS();
        for (uint256 salt; salt < 100_000; ++salt) {
            h = keccak256(abi.encode("plumb-gate", vm.getBlockNumber(), salt));
            if (PlumbScore.gateHit(h, s.gateSeed, id, s.probeNonce, odds)) {
                vm.setBlockhash(vm.getBlockNumber(), h);
                vm.roll(vm.getBlockNumber() + 1);
                assertTrue(campaigns.probeGateOpen(id), "gate should be open");
                return h;
            }
        }
        revert("no gate hash found");
    }

    function _probe(uint256 id) internal returns (uint256 passed) {
        _openGate(id);
        vm.prank(keeper);
        passed = campaigns.probe(id);
    }

    /// @dev Move past the minimum probe interval, keeping quotes fresh for the given vaults.
    function _advance(uint256 secs) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
        vm.roll(vm.getBlockNumber() + 1);
    }
}
