// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PlumbFaucet} from "../src/test/PlumbFaucet.sol";
import {DemoQuoteToken} from "../src/test/DemoQuoteToken.sol";

/// @title DeployFaucet
/// @notice Deploys the PLUMBUSD faucet and funds it by minting to it. The caller must own the token
///         (the Plumbline deployer does). Run without --broadcast for a fork dry-run.
/// @dev Env: DEPLOYER_PRIVATE_KEY, FAUCET_TOKEN; optional FAUCET_AMOUNT (default 100e6), FAUCET_COOLDOWN
///      (default 86400), FAUCET_FUND (default 10_000e6).
contract DeployFaucet is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address token = vm.envAddress("FAUCET_TOKEN");
        uint256 amount = vm.envOr("FAUCET_AMOUNT", uint256(100e6));
        uint256 cooldown = vm.envOr("FAUCET_COOLDOWN", uint256(1 days));
        uint256 fund = vm.envOr("FAUCET_FUND", uint256(10_000e6));

        require(DemoQuoteToken(token).owner() == vm.addr(pk), "deployer does not own the token");

        vm.startBroadcast(pk);
        PlumbFaucet faucet = new PlumbFaucet(IERC20(token), amount, cooldown);
        DemoQuoteToken(token).mint(address(faucet), fund);
        vm.stopBroadcast();

        require(faucet.poolBalance() == fund, "pool not funded");
        console.log("faucet  ", address(faucet));
        console.log("pool    ", faucet.poolBalance());
    }
}
