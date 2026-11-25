// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GuardedRouter} from "../src/GuardedRouter.sol";
import {IExecutionGuard, Quote, Policy} from "../src/interfaces/IExecutionGuard.sol";
import {
    ISwapRouter02,
    IUniswapV3FactoryMinimal,
    IUniswapV3PoolMinimal
} from "../src/interfaces/IUniswapV3.sol";
import {PriceMath} from "../src/libraries/PriceMath.sol";
import {PreflightBase, MockPool, DemoAgent} from "./utils/PreflightBase.sol";

/// @notice Fork tests against HSK Chain mainnet (chain 177). Skipped without a fork:
///   forge test --fork-url https://mainnet.hsk.xyz
contract GuardedRouterForkTest is PreflightBase {
    address internal constant SWAP_ROUTER02 = 0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3;
    address internal constant FACTORY = 0x972cA9D1662F5e029cD18327D29026532E84c742;
    address internal constant WHSK = 0xB210D2120d57b758EE163cFfb43e73728c471Cf1; // token0, 18 dec
    address internal constant USDT = 0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029; // token1, 6 dec
    address internal constant POOL = 0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC; // WHSK/USDT 0.3%

    GuardedRouter internal router;
    address internal agent = makeAddr("agent");
    uint160 internal spot;

    function setUp() public {
        if (block.chainid != 177) {
            vm.skip(true);
            return;
        }
        _deployGuard();
        router = new GuardedRouter(
            IExecutionGuard(address(guard)), ISwapRouter02(SWAP_ROUTER02), IUniswapV3FactoryMinimal(FACTORY)
        );
        (spot,,,,,,) = IUniswapV3PoolMinimal(POOL).slot0();
        deal(USDT, agent, 100_000e6);
        vm.prank(agent);
        IERC20(USDT).approve(address(router), type(uint256).max);
    }

    /// USDT -> WHSK (oneForZero) quote with fair price = current spot.
    function _buyQuote(uint256 usdtIn) internal view returns (Quote memory) {
        return _quote(agent, address(router), POOL, false, usdtIn, spot);
    }

    function _swap(Quote memory q, bytes memory sig) internal returns (uint256) {
        vm.prank(agent);
        return router.guardedSwap(q, sig, 0, keccak256("test"));
    }

    function test_fork_poolSnapshot() public view {
        assertEq(IUniswapV3PoolMinimal(POOL).token0(), WHSK);
        assertEq(IUniswapV3PoolMinimal(POOL).token1(), USDT);
        assertEq(IUniswapV3FactoryMinimal(FACTORY).getPool(WHSK, USDT, 3000), POOL);
    }

    /// Proves SwapRouter02 on HSK uses the 7-field struct (no deadline): the 8-field selector reverts.
    function test_fork_swapRouter02HasNoDeadlineVariant() public {
        deal(USDT, address(this), 10e6);
        IERC20(USDT).approve(SWAP_ROUTER02, 10e6);
        bytes memory withDeadline = abi.encodeWithSelector(
            bytes4(
                keccak256(
                    "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))"
                )
            ),
            USDT,
            WHSK,
            uint24(3000),
            address(this),
            block.timestamp,
            10e6,
            0,
            uint160(0)
        );
        (bool ok,) = SWAP_ROUTER02.call(withDeadline);
        assertFalse(ok, "8-field exactInputSingle should not exist");

        uint256 out = ISwapRouter02(SWAP_ROUTER02)
            .exactInputSingle(
                ISwapRouter02.ExactInputSingleParams(USDT, WHSK, 3000, address(this), 10e6, 0, 0)
            );
        assertGt(out, 0);
        assertEq(IERC20(WHSK).balanceOf(address(this)), out);
    }

    function _slot0() internal view returns (uint160 s) {
        (s,,,,,,) = IUniswapV3PoolMinimal(POOL).slot0();
    }

    /// Dry-runs the swap in a state snapshot, then arms expectEmit with the exact event data.
    function _expectGuardedSwap(Quote memory q, bytes memory sig, bytes32 reason)
        internal
        returns (uint256 out)
    {
        uint256 snap = vm.snapshotState();
        uint160 before = _slot0();
        vm.prank(agent);
        out = router.guardedSwap(q, sig, 0, reason);
        uint160 afterSwap = _slot0();
        vm.revertToState(snap);
        uint256 impact = PriceMath.impactBps(q.zeroForOne, before, q.amountIn, 3000, out);
        uint256 dev = PriceMath.deviationBps(afterSwap, q.fairSqrtPriceX96);
        vm.expectEmit(true, true, false, true, address(router));
        emit GuardedRouter.GuardedSwap(agent, POOL, q.amountIn, out, impact, dev, reason);
    }

    // (1) small swap with a valid quote succeeds, emits GuardedSwap (full data), router keeps nothing.
    function test_fork_smallSwapSucceeds() public {
        Quote memory q = _buyQuote(50e6);
        bytes memory sig = _sign(ATTESTOR_PK, q);
        uint256 whskBefore = IERC20(WHSK).balanceOf(agent);

        uint256 expected = _expectGuardedSwap(q, sig, keccak256("test"));
        uint256 out = _swap(q, sig);
        assertEq(out, expected);

        assertGt(out, 0);
        assertEq(IERC20(WHSK).balanceOf(agent) - whskBefore, out);
        assertEq(IERC20(USDT).balanceOf(agent), 100_000e6 - 50e6);
        assertEq(IERC20(USDT).balanceOf(address(router)), 0);
        assertEq(IERC20(WHSK).balanceOf(address(router)), 0);
        assertEq(IERC20(USDT).allowance(address(router), SWAP_ROUTER02), 0);
        // ~619 WHSK for 50 USDT at ~0.0808 USDT/WHSK; impact should be ~1 bps
        uint256 expectedOut = uint256(50e6) * 1e12 * 1e4 / 808;
        assertApproxEqRel(out, expectedOut, 0.05e18);
    }

    // (2a) large swap honestly quoted (impact above policy) is rejected by the guard.
    function test_fork_largeSwapRejectedByQuotedImpact() public {
        Quote memory q = _buyQuote(20_000e6);
        q.expectedImpactBps = 460;
        bytes memory sig = _sign(ATTESTOR_PK, q);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IExecutionGuard.ImpactTooHigh.selector, 460, 100));
        router.guardedSwap(q, sig, 0, bytes32(0));
    }

    // (2b) understated quote, impact between policy (100) and the fair floor (300): measured impact reverts.
    function test_fork_largeSwapRevertsOnActualImpact() public {
        Quote memory q = _buyQuote(7_000e6);
        bytes memory sig = _sign(ATTESTOR_PK, q);
        vm.prank(agent);
        vm.expectPartialRevert(GuardedRouter.ActualImpactTooHigh.selector);
        router.guardedSwap(q, sig, 0, bytes32(0));
        assertEq(IERC20(USDT).balanceOf(agent), 100_000e6);
    }

    // (2c) understated quote for 20k USDT: output falls below the fair floor before any other check.
    function test_fork_hugeSwapRevertsBelowFairFloor() public {
        Quote memory q = _buyQuote(20_000e6);
        bytes memory sig = _sign(ATTESTOR_PK, q);
        vm.prank(agent);
        vm.expectPartialRevert(GuardedRouter.BelowFairFloor.selector);
        router.guardedSwap(q, sig, 0, bytes32(0));
    }

    function _frontRun(uint256 usdtIn) internal {
        address mev = makeAddr("mev");
        deal(USDT, mev, usdtIn);
        vm.startPrank(mev);
        IERC20(USDT).approve(SWAP_ROUTER02, usdtIn);
        ISwapRouter02(SWAP_ROUTER02)
            .exactInputSingle(ISwapRouter02.ExactInputSingleParams(USDT, WHSK, 3000, mev, usdtIn, 0, 0));
        vm.stopPrank();
    }

    // Security #1: a front-run that pushes the price past maxDevBps makes the victim's swap revert.
    function test_fork_frontRunBeyondPolicyReverts() public {
        Quote memory q = _buyQuote(1_000e6);
        bytes memory sig = _sign(ATTESTOR_PK, q);
        _frontRun(10_000e6); // ~+480 bps
        vm.prank(agent);
        vm.expectPartialRevert(IExecutionGuard.DeviationTooHigh.selector);
        router.guardedSwap(q, sig, 0, bytes32(0));
        assertEq(IERC20(USDT).balanceOf(agent), 100_000e6);
    }

    // Security #1: a front-run inside the tolerance is bounded — the victim never gets less than the fair floor.
    function test_fork_frontRunWithinPolicyIsBoundedByFairFloor() public {
        Quote memory q = _buyQuote(1_000e6);
        bytes memory sig = _sign(ATTESTOR_PK, q);
        _frontRun(3_000e6); // ~+140 bps, below maxDevBps 200
        uint256 out = _swap(q, sig);
        assertGe(out, PriceMath.fairFloorOut(false, spot, 1_000e6, 3000, 200, 100));
        assertLt(out, PriceMath.spotOut(false, spot, 1_000e6, 3000)); // the sandwich did cost something
    }

    // Review #10: zeroForOne = true (sell WHSK for USDT).
    function test_fork_sellWhskZeroForOne() public {
        deal(WHSK, agent, 5_000e18);
        vm.prank(agent);
        IERC20(WHSK).approve(address(router), type(uint256).max);
        uint256 usdtBefore = IERC20(USDT).balanceOf(agent);
        Quote memory q = _quote(agent, address(router), POOL, true, 5_000e18, spot);
        bytes memory sig = _sign(ATTESTOR_PK, q);

        uint256 expected = _expectGuardedSwap(q, sig, keccak256("sell"));
        vm.prank(agent);
        uint256 out = router.guardedSwap(q, sig, 0, keccak256("sell"));

        assertEq(out, expected);
        assertEq(IERC20(USDT).balanceOf(agent) - usdtBefore, out);
        assertEq(IERC20(WHSK).balanceOf(agent), 0);
        assertEq(IERC20(WHSK).balanceOf(address(router)), 0);
        assertApproxEqRel(out, uint256(5_000e18) * 808 / 1e4 / 1e12, 0.05e18); // ~404 USDT
    }

    // Security #4 against the real SwapRouter02.
    function test_fork_constructorChecksRouterFactory() public {
        assertEq(ISwapRouter02(SWAP_ROUTER02).factory(), FACTORY);
        vm.expectRevert(
            abi.encodeWithSelector(GuardedRouter.FactoryMismatch.selector, FACTORY, address(0xdead))
        );
        new GuardedRouter(
            IExecutionGuard(address(guard)),
            ISwapRouter02(SWAP_ROUTER02),
            IUniswapV3FactoryMinimal(address(0xdead))
        );
    }

    /// Review #10: exports real SwapRouter02 outputs for the TS cross-check (packages/core/test/crosscheck.test.ts).
    /// Run: PREFLIGHT_EXPORT_FIXTURE=true forge test --fork-url ... --fork-block-number 30609500 --mt export
    function test_fork_exportImpactFixture() public {
        if (!vm.envOr("PREFLIGHT_EXPORT_FIXTURE", false)) return;
        uint256[5] memory buys = [uint256(50e6), 1_262e6, 4_238e6, 10_000e6, 50_000e6];
        uint256[4] memory sells = [uint256(600e18), 15_600e18, 52_000e18, 125_000e18];
        string memory rows = "";
        for (uint256 i = 0; i < buys.length; i++) {
            rows = string.concat(rows, i == 0 ? "" : ",", _probe(false, buys[i]));
        }
        for (uint256 i = 0; i < sells.length; i++) {
            rows = string.concat(rows, ",", _probe(true, sells[i]));
        }
        string memory json = string.concat(
            '{"block":',
            vm.toString(block.number),
            ',"sqrtPriceX96":"',
            vm.toString(uint256(spot)),
            '","swaps":[',
            rows,
            "]}"
        );
        vm.writeFile("../packages/core/fixtures/onchain_impact.json", json);
    }

    function _probe(bool zeroForOne, uint256 amountIn) internal returns (string memory) {
        uint256 snap = vm.snapshotState();
        (address tin, address tout) = zeroForOne ? (WHSK, USDT) : (USDT, WHSK);
        deal(tin, address(this), amountIn);
        IERC20(tin).approve(SWAP_ROUTER02, amountIn);
        uint256 out = ISwapRouter02(SWAP_ROUTER02)
            .exactInputSingle(
                ISwapRouter02.ExactInputSingleParams(tin, tout, 3000, address(this), amountIn, 0, 0)
            );
        uint160 afterSwap = _slot0();
        vm.revertToState(snap);
        string memory head = string.concat(
            '{"zeroForOne":',
            zeroForOne ? "true" : "false",
            ',"amountIn":"',
            vm.toString(amountIn),
            '","amountOut":"',
            vm.toString(out),
            '","sqrtPriceAfterX96":"',
            vm.toString(uint256(afterSwap))
        );
        return string.concat(head, _probeMetrics(zeroForOne, amountIn, out, afterSwap));
    }

    function _probeMetrics(bool zeroForOne, uint256 amountIn, uint256 out, uint160 afterSwap)
        internal
        view
        returns (string memory)
    {
        return string.concat(
            '","impactBps":',
            vm.toString(PriceMath.impactBps(zeroForOne, spot, amountIn, 3000, out)),
            ',"postSwapDevBps":',
            vm.toString(PriceMath.deviationBps(afterSwap, spot)),
            ',"fairFloorOut":"',
            vm.toString(PriceMath.fairFloorOut(zeroForOne, spot, amountIn, 3000, 200, 100)),
            '"}'
        );
    }

    // (3) expired / stale quote.
    function test_fork_expiredQuoteReverts() public {
        Quote memory q = _buyQuote(50e6);
        bytes memory sig = _sign(ATTESTOR_PK, q);
        vm.warp(block.timestamp + 61);
        vm.prank(agent);
        vm.expectPartialRevert(IExecutionGuard.QuoteExpired.selector);
        router.guardedSwap(q, sig, 0, bytes32(0));
    }

    function test_fork_staleQuoteReverts() public {
        vm.prank(agent);
        guard.setPolicy(Policy(100, 200, 30));
        Quote memory q = _buyQuote(50e6);
        q.issuedAt = uint64(block.timestamp - 31);
        bytes memory sig = _sign(ATTESTOR_PK, q);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IExecutionGuard.QuoteStale.selector, 31, 30));
        router.guardedSwap(q, sig, 0, bytes32(0));
    }

    // (4) signer is not a registered attestor.
    function test_fork_rogueSignerReverts() public {
        Quote memory q = _buyQuote(50e6);
        bytes memory sig = _sign(ROGUE_PK, q);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IExecutionGuard.NotAttestor.selector, vm.addr(ROGUE_PK)));
        router.guardedSwap(q, sig, 0, bytes32(0));
    }

    // (5a) pool spot already deviates from the attested fair price.
    function test_fork_spotDeviationReverts() public {
        Quote memory q = _buyQuote(50e6);
        q.fairSqrtPriceX96 = _shiftSqrt(spot, 500);
        bytes memory sig = _sign(ATTESTOR_PK, q);
        vm.prank(agent);
        vm.expectPartialRevert(IExecutionGuard.DeviationTooHigh.selector);
        router.guardedSwap(q, sig, 0, bytes32(0));
    }

    // (5b) spot is within policy but the swap pushes the price too far from fair.
    function test_fork_postSwapDeviationReverts() public {
        Quote memory q = _buyQuote(2_000e6); // buying WHSK pushes the price up ~95 bps
        q.fairSqrtPriceX96 = _shiftSqrt(spot, -150); // fair 1.5% below spot: passes pre-check (<=200)
        bytes memory sig = _sign(ATTESTOR_PK, q);
        vm.prank(agent);
        vm.expectPartialRevert(GuardedRouter.PostSwapDeviationTooHigh.selector);
        router.guardedSwap(q, sig, 0, bytes32(0));
    }

    function test_fork_onlyAgentCanSwap() public {
        Quote memory q = _buyQuote(50e6);
        bytes memory sig = _sign(ATTESTOR_PK, q);
        vm.expectRevert(abi.encodeWithSelector(GuardedRouter.NotAgent.selector, agent, address(this)));
        router.guardedSwap(q, sig, 0, bytes32(0));
    }

    function test_fork_rejectsNonFactoryPool() public {
        MockPool fake = new MockPool(spot, WHSK, USDT);
        Quote memory q = _quote(agent, address(router), address(fake), false, 50e6, spot);
        bytes memory sig = _sign(ATTESTOR_PK, q);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GuardedRouter.UnknownPool.selector, address(fake)));
        router.guardedSwap(q, sig, 0, bytes32(0));
    }

    function test_fork_amountOutMinEnforced() public {
        Quote memory q = _buyQuote(50e6);
        bytes memory sig = _sign(ATTESTOR_PK, q);
        vm.prank(agent);
        vm.expectRevert(bytes("Too little received"));
        router.guardedSwap(q, sig, 10_000e18, bytes32(0));
    }

    // (6) GuardConsumer modifier against the live pool.
    function test_fork_guardConsumerModifier() public {
        DemoAgent demo = new DemoAgent(guard);
        Quote memory q = _quote(address(demo), address(demo), POOL, false, 50e6, spot);
        demo.act(q, _sign(ATTESTOR_PK, q));
        assertEq(demo.actions(), 1);

        q = _quote(address(demo), address(demo), POOL, false, 50e6, _shiftSqrt(spot, 300));
        bytes memory sig = _sign(ATTESTOR_PK, q);
        vm.expectPartialRevert(IExecutionGuard.DeviationTooHigh.selector);
        demo.act(q, sig);
    }
}
