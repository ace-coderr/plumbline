// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PlumbQuoteFactory} from "../src/PlumbQuoteFactory.sol";
import {PlumbCampaigns} from "../src/PlumbCampaigns.sol";
import {PlumbRouter} from "../src/PlumbRouter.sol";
import {IPlumbPenalizer} from "../src/interfaces/IPlumbPenalizer.sol";

/// @title DeployCampaignsV2
/// @notice Redeploys only the two contracts that bind each other (campaigns and router) against an
///         existing factory. The factory and its vaults bind neither, so they, and every vault on them,
///         stay as they are. As in `Deploy`, the router's address is precomputed from the deployer nonce.
contract DeployCampaignsV2 is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        PlumbQuoteFactory factory = PlumbQuoteFactory(vm.envAddress("FACTORY"));
        require(address(factory).code.length > 0, "no factory at FACTORY");

        vm.startBroadcast(pk);
        address predictedRouter = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        PlumbCampaigns campaigns = new PlumbCampaigns(factory, predictedRouter);
        PlumbRouter router = new PlumbRouter(factory, IPlumbPenalizer(address(campaigns)));
        vm.stopBroadcast();

        require(address(router) == predictedRouter, "router address mismatch");
        require(address(campaigns.factory()) == address(factory) && campaigns.router() == address(router), "campaigns binding");

        console.log("campaigns", address(campaigns));
        console.log("router   ", address(router));
    }
}
