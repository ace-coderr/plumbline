// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PlumbFaucet} from "../src/test/PlumbFaucet.sol";
import {DemoQuoteToken} from "../src/test/DemoQuoteToken.sol";

contract PlumbFaucetTest is Test {
    uint256 internal constant AMOUNT = 100e6; // 100 PLUMBUSD, 6 decimals
    uint256 internal constant COOLDOWN = 1 days;

    DemoQuoteToken internal token;
    PlumbFaucet internal faucet;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    event Claimed(address indexed account, uint256 value, uint256 nextClaimAt);

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new DemoQuoteToken(address(this));
        faucet = new PlumbFaucet(IERC20(address(token)), AMOUNT, COOLDOWN);
        token.mint(address(faucet), 10_000e6);
    }

    function test_config_isImmutableAndReadable() public view {
        assertEq(address(faucet.token()), address(token));
        assertEq(faucet.amount(), AMOUNT);
        assertEq(faucet.cooldown(), COOLDOWN);
        assertEq(faucet.poolBalance(), 10_000e6);
    }

    function test_constructor_rejectsZeroConfig() public {
        vm.expectRevert(PlumbFaucet.BadConfig.selector);
        new PlumbFaucet(IERC20(address(0)), AMOUNT, COOLDOWN);
        vm.expectRevert(PlumbFaucet.BadConfig.selector);
        new PlumbFaucet(IERC20(address(token)), 0, COOLDOWN);
        vm.expectRevert(PlumbFaucet.BadConfig.selector);
        new PlumbFaucet(IERC20(address(token)), AMOUNT, 0);
    }

    function test_firstClaim_sendsAmountAndEmits() public {
        assertEq(faucet.nextClaimAt(alice), 0, "never claimed: may claim now");
        vm.expectEmit(true, false, false, true);
        emit Claimed(alice, AMOUNT, vm.getBlockTimestamp() + COOLDOWN);
        vm.prank(alice);
        faucet.claim();
        assertEq(token.balanceOf(alice), AMOUNT);
        assertEq(faucet.poolBalance(), 10_000e6 - AMOUNT);
        assertEq(faucet.lastClaimAt(alice), vm.getBlockTimestamp());
        assertEq(faucet.nextClaimAt(alice), vm.getBlockTimestamp() + COOLDOWN);
    }

    function test_cooldown_blocksSecondClaimAndNamesWhenItEnds() public {
        vm.prank(alice);
        faucet.claim();
        uint256 next = vm.getBlockTimestamp() + COOLDOWN;

        vm.warp(vm.getBlockTimestamp() + COOLDOWN - 1);
        vm.expectRevert(abi.encodeWithSelector(PlumbFaucet.CooldownActive.selector, next));
        vm.prank(alice);
        faucet.claim();
        assertEq(token.balanceOf(alice), AMOUNT, "nothing extra was sent");
    }

    function test_afterCooldown_claimsAgain() public {
        vm.prank(alice);
        faucet.claim();
        vm.warp(vm.getBlockTimestamp() + COOLDOWN); // exactly at the boundary
        vm.prank(alice);
        faucet.claim();
        assertEq(token.balanceOf(alice), 2 * AMOUNT);
        assertEq(
            faucet.nextClaimAt(alice),
            vm.getBlockTimestamp() + COOLDOWN,
            "the clock restarts from the new claim"
        );
    }

    function test_emptyPool_revertsAndChangesNothing() public {
        PlumbFaucet empty = new PlumbFaucet(IERC20(address(token)), AMOUNT, COOLDOWN);
        vm.expectRevert(PlumbFaucet.PoolEmpty.selector);
        vm.prank(alice);
        empty.claim();
        assertEq(empty.lastClaimAt(alice), 0, "a failed claim does not start a cooldown");
    }

    function test_poolShortOfOneClaim_isEmptyNotPartial() public {
        PlumbFaucet small = new PlumbFaucet(IERC20(address(token)), AMOUNT, COOLDOWN);
        token.mint(address(small), AMOUNT - 1);
        vm.expectRevert(PlumbFaucet.PoolEmpty.selector);
        vm.prank(alice);
        small.claim();
        assertEq(token.balanceOf(alice), 0);
    }

    function test_drainsToExactlyZero_thenEmpty() public {
        PlumbFaucet two = new PlumbFaucet(IERC20(address(token)), AMOUNT, COOLDOWN);
        token.mint(address(two), 2 * AMOUNT);
        vm.prank(alice);
        two.claim();
        vm.prank(bob);
        two.claim();
        assertEq(two.poolBalance(), 0);
        vm.expectRevert(PlumbFaucet.PoolEmpty.selector);
        vm.prank(makeAddr("carol"));
        two.claim();
    }

    function test_twoAddresses_haveIndependentCooldowns() public {
        vm.prank(alice);
        faucet.claim();
        vm.warp(vm.getBlockTimestamp() + 3 hours);
        vm.prank(bob); // bob has never claimed, alice's cooldown does not apply to him
        faucet.claim();
        assertEq(token.balanceOf(bob), AMOUNT);

        vm.expectRevert(); // alice is still cooling down
        vm.prank(alice);
        faucet.claim();
        assertEq(faucet.nextClaimAt(bob), vm.getBlockTimestamp() + COOLDOWN);
    }

    function test_topUp_byAnyone_extendsThePool() public {
        PlumbFaucet f = new PlumbFaucet(IERC20(address(token)), AMOUNT, COOLDOWN);
        token.mint(alice, 500e6);
        vm.prank(alice);
        token.transfer(address(f), 500e6);
        assertEq(f.poolBalance(), 500e6);
    }

    /// forge-config: default.fuzz.runs = 256
    function testFuzz_cooldown_isExactlyTheCooldown(uint32 wait) public {
        vm.prank(alice);
        faucet.claim();
        vm.warp(vm.getBlockTimestamp() + wait);
        vm.prank(alice);
        if (wait < COOLDOWN) {
            vm.expectRevert();
            faucet.claim();
        } else {
            faucet.claim();
            assertEq(token.balanceOf(alice), 2 * AMOUNT);
        }
    }

    function test_hasNoOwnerFunctions() public view {
        // The whole external surface is claim, the views and the public mapping; there is nothing to call
        // that moves the pool except claim().
        assertEq(faucet.poolBalance(), 10_000e6);
    }
}
