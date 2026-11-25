// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ExecutionGuard} from "../src/ExecutionGuard.sol";
import {GuardedRouter} from "../src/GuardedRouter.sol";
import {IExecutionGuard} from "../src/interfaces/IExecutionGuard.sol";
import {ISwapRouter02, IUniswapV3FactoryMinimal} from "../src/interfaces/IUniswapV3.sol";

/// @notice Deploys ExecutionGuard + GuardedRouter on HSK Chain mainnet (177) or testnet (133).
/// Env: DEPLOYER_PRIVATE_KEY, ATTESTOR_ADDRESS (required), GUARD_OWNER (optional, defaults to deployer).
/// Dry run:  forge script script/Deploy.s.sol --rpc-url $HSK_RPC_URL
/// Broadcast only after review: add --broadcast.
/// Ownership is two-step: when GUARD_OWNER differs from the deployer it must call acceptOwnership().
contract Deploy is Script {
    // Same SwapRouter02/factory addresses are only verified on mainnet; override for testnet.
    address internal constant SWAP_ROUTER02 = 0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3;
    address internal constant FACTORY = 0x972cA9D1662F5e029cD18327D29026532E84c742;

    function run() external returns (ExecutionGuard guard, GuardedRouter router) {
        require(block.chainid == 177 || block.chainid == 133, "Deploy: unsupported chain");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address owner = vm.envOr("GUARD_OWNER", deployer);
        address attestor = vm.envOr("ATTESTOR_ADDRESS", address(0));
        require(attestor != address(0), "Deploy: ATTESTOR_ADDRESS is empty");
        address swapRouter = vm.envOr("SWAP_ROUTER02", SWAP_ROUTER02);
        address factory = vm.envOr("V3_FACTORY", FACTORY);

        vm.startBroadcast(pk);
        // Deployer owns the guard first so it can register the attestor, then hands over ownership.
        guard = new ExecutionGuard(deployer);
        guard.addAttestor(attestor);
        if (owner != deployer) guard.transferOwnership(owner);
        router = new GuardedRouter(
            IExecutionGuard(address(guard)), ISwapRouter02(swapRouter), IUniswapV3FactoryMinimal(factory)
        );
        vm.stopBroadcast();

        console2.log("ExecutionGuard", address(guard));
        console2.log("GuardedRouter ", address(router));
    }
}
