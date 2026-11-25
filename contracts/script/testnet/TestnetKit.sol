// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Testnet-only fixtures for the HSK testnet demo (apps/agent/scripts/testnet-demo.ts).
///         HSKSwap is not deployed on HSK testnet, so the demo runs against a test Uniswap V3 pool.

/// @notice Plain 18-decimal test token; the whole supply is minted to the deployer. No value.
contract TestToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply, address to) ERC20(name_, symbol_) {
        _mint(to, supply);
    }
}

interface IUniswapV3PoolMint {
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @notice Adds liquidity to a V3 pool by answering uniswapV3MintCallback with the caller's tokens.
contract V3LiquidityHelper {
    using SafeERC20 for IERC20;

    address private _pool;
    address private _payer;

    error UnexpectedCallback(address caller);

    function addLiquidity(address pool, int24 tickLower, int24 tickUpper, uint128 liquidity)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        _pool = pool;
        _payer = msg.sender;
        (amount0, amount1) = IUniswapV3PoolMint(pool).mint(msg.sender, tickLower, tickUpper, liquidity, "");
        _pool = address(0);
        _payer = address(0);
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
        if (msg.sender != _pool || _pool == address(0)) revert UnexpectedCallback(msg.sender);
        IUniswapV3PoolMint pool = IUniswapV3PoolMint(msg.sender);
        if (amount0Owed > 0) IERC20(pool.token0()).safeTransferFrom(_payer, msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20(pool.token1()).safeTransferFrom(_payer, msg.sender, amount1Owed);
    }
}
