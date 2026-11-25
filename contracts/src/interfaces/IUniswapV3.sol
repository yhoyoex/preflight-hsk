// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Uniswap V3 pool surface used by Preflight (HSKSwap is a V3 fork).
interface IUniswapV3PoolMinimal {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

interface IUniswapV3FactoryMinimal {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/// @notice SwapRouter02 (no `deadline` in the params struct, selector 0x04e45aaf).
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);

    /// @notice V3 factory the router resolves pools from (PeripheryImmutableState).
    function factory() external view returns (address);
}
