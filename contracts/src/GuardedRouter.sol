// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IExecutionGuard, Quote, Policy} from "./interfaces/IExecutionGuard.sol";
import {IUniswapV3PoolMinimal, IUniswapV3FactoryMinimal, ISwapRouter02} from "./interfaces/IUniswapV3.sol";
import {PriceMath} from "./libraries/PriceMath.sol";

/// @title GuardedRouter
/// @notice Executes a SwapRouter02 exact-input swap only if an attested quote verifies, then re-checks the
///         realised impact and post-swap price deviation on-chain. Non-custodial: output goes straight to the
///         caller and no balance remains after the transaction.
contract GuardedRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IExecutionGuard public immutable guard;
    ISwapRouter02 public immutable swapRouter;
    IUniswapV3FactoryMinimal public immutable factory;

    event GuardedSwap(
        address indexed agent,
        address indexed pool,
        uint256 amountIn,
        uint256 amountOut,
        uint256 impactBps,
        uint256 devBps,
        bytes32 reasonHash
    );

    error NotAgent(address agent, address caller);
    error UnknownPool(address pool);
    error ActualImpactTooHigh(uint256 impactBps, uint32 maxImpactBps);
    error PostSwapDeviationTooHigh(uint256 devBps, uint32 maxDevBps);
    error BelowFairFloor(uint256 amountOut, uint256 floor);
    error NoSlippageProtection();
    error FactoryMismatch(address routerFactory, address factory);
    error ZeroAddress();

    constructor(IExecutionGuard guard_, ISwapRouter02 swapRouter_, IUniswapV3FactoryMinimal factory_) {
        if (
            address(guard_) == address(0) || address(swapRouter_) == address(0)
                || address(factory_) == address(0)
        ) {
            revert ZeroAddress();
        }
        address routerFactory = swapRouter_.factory();
        if (routerFactory != address(factory_)) revert FactoryMismatch(routerFactory, address(factory_));
        guard = guard_;
        swapRouter = swapRouter_;
        factory = factory_;
    }

    /// @param amountOutMin Caller's own minimum; the router additionally enforces the fair floor
    ///        (spotOut at q.fairSqrtPriceX96 minus maxDevBps + maxImpactBps), so 0 is never the only guard.
    function guardedSwap(Quote calldata q, bytes calldata sig, uint256 amountOutMin, bytes32 reasonHash)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (msg.sender != q.agent) revert NotAgent(q.agent, msg.sender);
        Policy memory policy = guard.verify(q, sig);

        SwapCtx memory c = _context(q);
        c.floor = PriceMath.fairFloorOut(
            q.zeroForOne, q.fairSqrtPriceX96, q.amountIn, c.fee, policy.maxDevBps, policy.maxImpactBps
        );
        if (c.floor == 0 && amountOutMin == 0) revert NoSlippageProtection();

        (uint160 sqrtBefore,,,,,,) = IUniswapV3PoolMinimal(q.pool).slot0();
        amountOut = _swap(c, q.amountIn, amountOutMin);
        if (amountOut < c.floor) revert BelowFairFloor(amountOut, c.floor);
        (uint160 sqrtAfter,,,,,,) = IUniswapV3PoolMinimal(q.pool).slot0();

        uint256 impact = PriceMath.impactBps(q.zeroForOne, sqrtBefore, q.amountIn, c.fee, amountOut);
        if (impact > policy.maxImpactBps) revert ActualImpactTooHigh(impact, policy.maxImpactBps);
        uint256 dev = PriceMath.deviationBps(sqrtAfter, q.fairSqrtPriceX96);
        if (dev > policy.maxDevBps) revert PostSwapDeviationTooHigh(dev, policy.maxDevBps);

        IERC20(c.tokenOut).safeTransfer(msg.sender, amountOut);
        emit GuardedSwap(q.agent, q.pool, q.amountIn, amountOut, impact, dev, reasonHash);
    }

    struct SwapCtx {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        uint256 floor;
    }

    /// @dev Resolves swap direction and rejects pools not created by the canonical factory.
    function _context(Quote calldata q) private view returns (SwapCtx memory c) {
        IUniswapV3PoolMinimal pool = IUniswapV3PoolMinimal(q.pool);
        address token0 = pool.token0();
        address token1 = pool.token1();
        c.fee = pool.fee();
        if (factory.getPool(token0, token1, c.fee) != q.pool) revert UnknownPool(q.pool);
        (c.tokenIn, c.tokenOut) = q.zeroForOne ? (token0, token1) : (token1, token0);
    }

    /// @dev Output is measured as this contract's balance delta, not the router's return value.
    function _swap(SwapCtx memory c, uint256 amountIn, uint256 amountOutMin) private returns (uint256) {
        IERC20(c.tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(c.tokenIn).forceApprove(address(swapRouter), amountIn);
        uint256 balanceBefore = IERC20(c.tokenOut).balanceOf(address(this));
        swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: c.tokenIn,
                tokenOut: c.tokenOut,
                fee: c.fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );
        return IERC20(c.tokenOut).balanceOf(address(this)) - balanceBefore;
    }
}
