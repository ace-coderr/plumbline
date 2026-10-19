// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PlumbQuoteFactory} from "../src/PlumbQuoteFactory.sol";
import {PlumbCampaigns} from "../src/PlumbCampaigns.sol";
import {PlumbRouter} from "../src/PlumbRouter.sol";
import {IPlumbPenalizer} from "../src/interfaces/IPlumbPenalizer.sol";

/// @title Deploy
/// @notice Deploys the Plumbline core: factory, campaigns, router. Campaigns needs the router's address
///         and the router needs campaigns, so the router address is precomputed from the deployer nonce.
/// @dev Writes deployments/<chainId>.json. scripts/deploy.ts turns that into the shared addresses module.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        uint32 maxAge = uint32(vm.envOr("PLUMB_MAX_AGE", uint256(2)));
        uint32 withdrawDelay = uint32(vm.envOr("PLUMB_WITHDRAW_DELAY", uint256(30)));

        vm.startBroadcast(pk);
        PlumbQuoteFactory factory = new PlumbQuoteFactory(maxAge, withdrawDelay);
        address predictedRouter = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        PlumbCampaigns campaigns = new PlumbCampaigns(factory, predictedRouter);
        PlumbRouter router = new PlumbRouter(factory, IPlumbPenalizer(address(campaigns)));
        vm.stopBroadcast();

        require(address(router) == predictedRouter, "router address mismatch");

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "factory", address(factory));
        vm.serializeAddress(k, "campaigns", address(campaigns));
        vm.serializeAddress(k, "router", address(router));
        vm.serializeUint(k, "maxAge", maxAge);
        string memory json = vm.serializeUint(k, "withdrawDelay", withdrawDelay);
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);

        console.log("factory  ", address(factory));
        console.log("campaigns", address(campaigns));
        console.log("router   ", address(router));
    }
}
