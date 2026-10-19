// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {DemoQuoteToken} from "../src/test/DemoQuoteToken.sol";

contract DemoQuoteTokenTest is Test {
    DemoQuoteToken internal t;
    address internal owner = makeAddr("owner");

    function setUp() public {
        t = new DemoQuoteToken(owner);
    }

    function test_metadata() public view {
        assertEq(t.name(), "Plumbline Demo Dollar");
        assertEq(t.symbol(), "PLUMBUSD");
        assertEq(t.decimals(), 6);
    }

    function test_ownerMints() public {
        vm.prank(owner);
        t.mint(address(this), 5e6);
        assertEq(t.balanceOf(address(this)), 5e6);
    }

    function test_strangerCannotMint() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        t.mint(address(this), 1);
    }
}
