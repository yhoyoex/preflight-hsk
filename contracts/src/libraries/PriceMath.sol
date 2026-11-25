// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Basis-point helpers on Uniswap V3 sqrtPriceX96 values (price = token1 per token0, raw units).
library PriceMath {
    uint256 internal constant Q96 = 2 ** 96;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant FEE_DENOM = 1_000_000;

    /// @notice |price(sqrtA) / price(sqrtRef) - 1| in bps (rounded down).
    function deviationBps(uint160 sqrtA, uint160 sqrtRef) internal pure returns (uint256) {
        uint256 ratioX96 = Math.mulDiv(sqrtA, Q96, sqrtRef);
        uint256 priceRatioX96 = Math.mulDiv(ratioX96, ratioX96, Q96);
        uint256 diff = priceRatioX96 > Q96 ? priceRatioX96 - Q96 : Q96 - priceRatioX96;
        return Math.mulDiv(diff, BPS, Q96);
    }

    /// @notice Output `amountIn` would buy at the spot price `sqrtX96` after the LP fee, with zero impact.
    function spotOut(bool zeroForOne, uint160 sqrtX96, uint256 amountIn, uint24 fee)
        internal
        pure
        returns (uint256)
    {
        uint256 net = Math.mulDiv(amountIn, FEE_DENOM - fee, FEE_DENOM);
        if (zeroForOne) return Math.mulDiv(Math.mulDiv(net, sqrtX96, Q96), sqrtX96, Q96);
        return Math.mulDiv(Math.mulDiv(net, Q96, sqrtX96), Q96, sqrtX96);
    }

    /// @notice Execution cost versus pre-trade spot, excluding the LP fee, in bps (0 if better than spot).
    ///         Dust trades whose ideal output rounds to 0 return type(uint256).max so they never pass a cap.
    function impactBps(bool zeroForOne, uint160 sqrtBefore, uint256 amountIn, uint24 fee, uint256 amountOut)
        internal
        pure
        returns (uint256)
    {
        uint256 ideal = spotOut(zeroForOne, sqrtBefore, amountIn, fee);
        if (ideal == 0) return type(uint256).max;
        if (amountOut >= ideal) return 0;
        return Math.mulDiv(ideal - amountOut, BPS, ideal, Math.Rounding.Ceil);
    }

    /// @notice Minimum acceptable output: spotOut at the attested fair price minus (maxDevBps + maxImpactBps).
    ///         Bounds sandwich losses independently of the caller-supplied amountOutMin.
    function fairFloorOut(
        bool zeroForOne,
        uint160 fairSqrtX96,
        uint256 amountIn,
        uint24 fee,
        uint256 maxDevBps,
        uint256 maxImpactBps
    ) internal pure returns (uint256) {
        uint256 slack = maxDevBps + maxImpactBps;
        if (slack >= BPS) return 0;
        return Math.mulDiv(spotOut(zeroForOne, fairSqrtX96, amountIn, fee), BPS - slack, BPS);
    }
}
