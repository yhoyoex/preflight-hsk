// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GuardedRouter} from "../src/GuardedRouter.sol";
import {IExecutionGuard, Quote} from "../src/interfaces/IExecutionGuard.sol";
import {ISwapRouter02, IUniswapV3FactoryMinimal} from "../src/interfaces/IUniswapV3.sol";
import {PriceMath} from "../src/libraries/PriceMath.sol";
import {PreflightBase, MockPool, MockERC20, MockFactory, MockSwapRouter} from "./utils/PreflightBase.sol";

/// @notice GuardedRouter unit tests without a fork (MockPool + scripted MockSwapRouter).
contract GuardedRouterTest is PreflightBase {
    uint160 internal constant SPOT = 22523105442617287490681; // WHSK/USDT pool snapshot
    uint24 internal constant FEE = 3000;
    bytes32 internal constant REASON = keccak256("unit");

    MockERC20 internal whsk;
    MockERC20 internal usdt;
    MockPool internal pool;
    MockFactory internal factory;
    MockSwapRouter internal swapRouter;
    GuardedRouter internal router;
    address internal agent = makeAddr("agent");

    function setUp() public {
        vm.warp(1_800_000_000);
        _deployGuard();
        whsk = new MockERC20("WHSK", 18);
        usdt = new MockERC20("USDT", 6);
        pool = new MockPool(SPOT, address(whsk), address(usdt));
        factory = new MockFactory();
        factory.setPool(address(whsk), address(usdt), FEE, address(pool));
        swapRouter = new MockSwapRouter(address(factory), pool);
        router = new GuardedRouter(
            IExecutionGuard(address(guard)),
            ISwapRouter02(address(swapRouter)),
            IUniswapV3FactoryMinimal(address(factory))
        );
        usdt.mint(agent, 1_000_000e6);
        vm.prank(agent);
        usdt.approve(address(router), type(uint256).max);
    }

    function _buy(uint256 usdtIn) internal view returns (Quote memory q, bytes memory sig) {
        q = _quote(agent, address(router), address(pool), false, usdtIn, SPOT);
        sig = _sign(ATTESTOR_PK, q);
    }

    function _ideal(uint256 usdtIn) internal pure returns (uint256) {
        return PriceMath.spotOut(false, SPOT, usdtIn, FEE);
    }

    function _floor(uint256 usdtIn) internal pure returns (uint256) {
        return PriceMath.fairFloorOut(false, SPOT, usdtIn, FEE, 200, 100);
    }

    // Security #4
    function test_constructorRejectsFactoryMismatch() public {
        MockSwapRouter other = new MockSwapRouter(address(0xdead), pool);
        vm.expectRevert(
            abi.encodeWithSelector(GuardedRouter.FactoryMismatch.selector, address(0xdead), address(factory))
        );
        new GuardedRouter(
            IExecutionGuard(address(guard)),
            ISwapRouter02(address(other)),
            IUniswapV3FactoryMinimal(address(factory))
        );
    }

    // Security #7: amountOut is the balance delta, not the swap router's reported return value.
    function test_happyPathUsesBalanceDelta() public {
        (Quote memory q, bytes memory sig) = _buy(50e6);
        uint256 out = _ideal(50e6) * 9995 / 10_000; // ~5 bps impact
        uint160 sqrtAfter = _shiftSqrt(SPOT, 10);
        swapRouter.script(out, 1, sqrtAfter);
        uint256 impact = PriceMath.impactBps(false, SPOT, 50e6, FEE, out);
        uint256 dev = PriceMath.deviationBps(sqrtAfter, SPOT);

        vm.expectEmit(true, true, false, true, address(router));
        emit GuardedRouter.GuardedSwap(agent, address(pool), 50e6, out, impact, dev, REASON);
        vm.prank(agent);
        uint256 got = router.guardedSwap(q, sig, 0, REASON);

        assertEq(got, out);
        assertEq(whsk.balanceOf(agent), out);
        assertEq(whsk.balanceOf(address(router)), 0);
        assertEq(usdt.balanceOf(address(router)), 0);
    }

    // Security #1: output below the fair floor (sandwich) reverts even with amountOutMin = 0.
    function test_belowFairFloorReverts() public {
        (Quote memory q, bytes memory sig) = _buy(50e6);
        uint256 floor = _floor(50e6);
        swapRouter.script(floor - 1, floor, SPOT);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GuardedRouter.BelowFairFloor.selector, floor - 1, floor));
        router.guardedSwap(q, sig, 0, REASON);
    }

    // Security #1: amountOutMin = 0 is never the only protection (dust → floor 0 → refuse).
    function test_noSlippageProtectionReverts() public {
        (Quote memory q, bytes memory sig) = _buy(1);
        assertEq(_floor(1), 0);
        vm.prank(agent);
        vm.expectRevert(GuardedRouter.NoSlippageProtection.selector);
        router.guardedSwap(q, sig, 0, REASON);
    }

    // Security #7: dust with a caller minimum still fails the impact cap (impact = max).
    function test_dustSwapFailsImpactCap() public {
        (Quote memory q, bytes memory sig) = _buy(1);
        swapRouter.script(1, 1, SPOT);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(GuardedRouter.ActualImpactTooHigh.selector, type(uint256).max, uint32(100))
        );
        router.guardedSwap(q, sig, 1, REASON);
    }

    function test_actualImpactAbovePolicyReverts() public {
        (Quote memory q, bytes memory sig) = _buy(5_000e6);
        uint256 out = _ideal(5_000e6) * 9850 / 10_000; // 150 bps: above maxImpact, above the 300 bps floor
        swapRouter.script(out, out, _shiftSqrt(SPOT, 150));
        uint256 impact = PriceMath.impactBps(false, SPOT, 5_000e6, FEE, out);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(GuardedRouter.ActualImpactTooHigh.selector, impact, uint32(100))
        );
        router.guardedSwap(q, sig, 0, REASON);
    }

    function test_postSwapDeviationReverts() public {
        (Quote memory q, bytes memory sig) = _buy(50e6);
        uint256 out = _ideal(50e6);
        uint160 sqrtAfter = _shiftSqrt(SPOT, 300);
        swapRouter.script(out, out, sqrtAfter);
        uint256 dev = PriceMath.deviationBps(sqrtAfter, SPOT);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(GuardedRouter.PostSwapDeviationTooHigh.selector, dev, uint32(200))
        );
        router.guardedSwap(q, sig, 0, REASON);
    }

    function test_callerMinimumForwarded() public {
        (Quote memory q, bytes memory sig) = _buy(50e6);
        uint256 out = _ideal(50e6);
        swapRouter.script(out, out, SPOT);
        vm.prank(agent);
        vm.expectRevert(bytes("Too little received"));
        router.guardedSwap(q, sig, out + 1, REASON);
    }
}
