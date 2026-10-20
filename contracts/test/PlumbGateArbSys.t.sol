// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./Fixture.sol";
import {PlumbCampaigns} from "../src/PlumbCampaigns.sol";
import {PlumbScore} from "../src/libraries/PlumbScore.sol";
import {MockArbSys} from "./mocks/MockArbSys.sol";

/// @notice The probe gate on an Arbitrum Orbit chain: block numbers and hashes come from ArbSys and
///         move per L2 block while the EVM's `block.number` (the parent chain's) stands still.
///         Every other test suite runs without ArbSys and so covers the `block.number` fallback.
contract PlumbGateArbSysTest is Fixture {
    MockArbSys internal arb;
    uint256 internal id;
    uint256 internal constant L2_START = 5_000_000;

    function setUp() public override {
        super.setUp();
        vm.etch(PlumbScore.ARB_SYS, address(new MockArbSys()).code);
        arb = MockArbSys(PlumbScore.ARB_SYS);
        arb.setNumber(L2_START);
        id = _open(_terms(), 3);
    }

    /// @dev Find a hash that is a gate hit for the campaign's current seed and nonce.
    function _hitHash(uint256 salt) internal view returns (bytes32 h) {
        PlumbCampaigns.State memory s = campaigns.state(id);
        for (uint256 i; i < 100_000; ++i) {
            h = keccak256(abi.encode("plumb-l2-gate", salt, i));
            if (PlumbScore.gateHit(h, s.gateSeed, id, s.probeNonce, campaigns.GATE_ODDS())) return h;
        }
        revert("no gate hash found");
    }

    /// @dev Plant a hit as the current L2 block's hash, then advance one L2 block. Returns the block.
    function _plantL2Hit() internal returns (uint256 b, bytes32 h) {
        b = arb.number();
        h = _hitHash(b);
        arb.setHash(b, h);
        arb.setNumber(b + 1);
    }

    function test_arbSys_sourceIsL2WhenPresent() public view {
        (uint256 n, bool fromArb) = PlumbScore.gateBlockNumber();
        assertTrue(fromArb, "reads ArbSys");
        assertEq(n, L2_START, "L2 number, not block.number");
        assertTrue(n != vm.getBlockNumber());
        // Outside ArbSys's 256-block range the hash reads as zero, which never opens the gate.
        assertEq(PlumbScore.gateBlockHash(L2_START, true), bytes32(0), "current block has no hash yet");
        assertEq(PlumbScore.gateBlockHash(L2_START - 257, true), bytes32(0), "too old");
    }

    function test_arbSys_fallbackWhenAbsent() public {
        vm.etch(PlumbScore.ARB_SYS, "");
        vm.setBlockhash(vm.getBlockNumber() - 1, keccak256("evm"));
        (uint256 n, bool fromArb) = PlumbScore.gateBlockNumber();
        assertFalse(fromArb, "no ArbSys");
        assertEq(n, vm.getBlockNumber(), "block.number");
        assertEq(PlumbScore.gateBlockHash(n - 1, false), keccak256("evm"), "blockhash");
    }

    function test_arbSys_forkPlaceholderFallsBack() public {
        // A fork of an Orbit chain carries only ArbSys's 0xfe placeholder: the call fails, the gate
        // falls back to block.number, and the capped calls keep the cost bounded.
        vm.etch(PlumbScore.ARB_SYS, hex"fe");
        (uint256 n, bool fromArb) = PlumbScore.gateBlockNumber();
        assertFalse(fromArb);
        assertEq(n, vm.getBlockNumber());
        _advance(_terms().minProbeInterval);
        _openGate(id);
        uint256 g = gasleft();
        assertTrue(campaigns.probeGateOpen(id), "opens on block.number");
        assertLt(g - gasleft(), 150_000, "placeholder calls are capped");
    }

    function test_arbSys_gateIgnoresEvmBlocks() public {
        _advance(_terms().minProbeInterval);
        // A winning hash planted in the EVM's blockhash does nothing while ArbSys is present.
        bytes32 h = _hitHash(1);
        vm.setBlockhash(vm.getBlockNumber(), h);
        vm.roll(vm.getBlockNumber() + 1);
        assertFalse(campaigns.probeGateOpen(id), "EVM hashes are not the gate's source");

        uint256 evmBlock = vm.getBlockNumber();
        _plantL2Hit();
        assertTrue(campaigns.probeGateOpen(id), "an L2 hit opens it");
        assertEq(vm.getBlockNumber(), evmBlock, "without the EVM block moving");
    }

    /// forge-config: default.fuzz.runs = 64
    function testFuzz_arbSys_reshufflesPerL2Block(uint256 seed) public {
        _advance(_terms().minProbeInterval);
        uint256 evmBlock = vm.getBlockNumber();
        // block.number stands still, as it does on Elysium between HyperEVM blocks; only L2 moves.
        uint256 openBlocks;
        uint256 changes;
        bool wasOpen = campaigns.probeGateOpen(id);
        uint256 blocks = 1_024;
        for (uint256 i; i < blocks; ++i) {
            uint256 b = arb.number();
            arb.setHash(b, keccak256(abi.encode(seed, i)));
            arb.setNumber(b + 1);
            bool open = campaigns.probeGateOpen(id);
            if (open) ++openBlocks;
            if (open != wasOpen) ++changes;
            wasOpen = open;
        }
        assertEq(vm.getBlockNumber(), evmBlock);
        // Same odds as on block.number: 1 - (63/64)^8, about 11.8% of blocks open (mean ~121 of
        // 1024). Bounds only catch always-open or never-open regressions.
        assertGt(openBlocks, 0, "opens on L2 blocks alone");
        assertLt(openBlocks, 400);
        assertGt(changes, 1, "opens and closes again within one EVM block");
    }

    function test_arbSys_hitHoldsForGateWindow() public {
        _advance(_terms().minProbeInterval);
        (uint256 b,) = _plantL2Hit();
        uint256 window = campaigns.GATE_WINDOW();
        for (uint256 k = 1; k <= window; ++k) {
            arb.setNumber(b + k);
            // prevrandao changing every block must not cut the window short.
            vm.prevrandao(bytes32(uint256(keccak256(abi.encode("rand", k)))));
            assertTrue(campaigns.probeGateOpen(id), "open for GATE_WINDOW L2 blocks");
        }
        arb.setNumber(b + window + 1);
        assertFalse(campaigns.probeGateOpen(id), "closed once the hit leaves the window");
    }

    function test_arbSys_probeRotatesSeedFromL2Hash() public {
        _advance(_terms().minProbeInterval);
        bytes32 before = campaigns.state(id).gateSeed;
        (, bytes32 h) = _plantL2Hit();
        vm.prank(keeper);
        campaigns.probe(id);
        // The new seed folds in the previous L2 block's hash, which is the planted hit.
        assertEq(campaigns.state(id).gateSeed, keccak256(abi.encode(before, uint256(1), h)));
        assertFalse(campaigns.probeGateOpen(id), "min interval restarts");
    }
}
