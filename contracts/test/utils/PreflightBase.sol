// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapRouter02} from "../../src/interfaces/IUniswapV3.sol";
import {ExecutionGuard} from "../../src/ExecutionGuard.sol";
import {GuardConsumer} from "../../src/GuardConsumer.sol";
import {IExecutionGuard, Quote, Policy} from "../../src/interfaces/IExecutionGuard.sol";

contract MockPool {
    uint160 public sqrtPriceX96;
    address public token0;
    address public token1;
    uint24 public fee = 3000;

    constructor(uint160 sqrtPriceX96_, address token0_, address token1_) {
        sqrtPriceX96 = sqrtPriceX96_;
        token0 = token0_;
        token1 = token1_;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, 0, 0, 0, 0, 0, true);
    }

    function setSqrtPrice(uint160 s) external {
        sqrtPriceX96 = s;
    }
}

/// @dev Pool whose slot0 reverts unless the guard already marked the probed nonce as used (CEI check).
contract NonceProbePool {
    ExecutionGuard internal immutable guard;
    address internal immutable agent;
    uint256 internal immutable nonce;
    uint160 internal immutable sqrtPriceX96;

    constructor(ExecutionGuard guard_, address agent_, uint256 nonce_, uint160 sqrt_) {
        guard = guard_;
        agent = agent_;
        nonce = nonce_;
        sqrtPriceX96 = sqrt_;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        require(guard.nonceUsed(agent, nonce), "nonce not consumed before slot0");
        return (sqrtPriceX96, 0, 0, 0, 0, 0, true);
    }
}

contract MockERC20 is ERC20 {
    uint8 internal immutable dec;

    constructor(string memory symbol, uint8 decimals_) ERC20(symbol, symbol) {
        dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockFactory {
    mapping(bytes32 => address) internal pools;

    function setPool(address a, address b, uint24 fee, address pool) external {
        pools[keccak256(abi.encode(a, b, fee))] = pool;
        pools[keccak256(abi.encode(b, a, fee))] = pool;
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return pools[keccak256(abi.encode(a, b, fee))];
    }
}

/// @dev SwapRouter02 stand-in: pulls tokenIn, mints a scripted output, moves the mock pool price and
///      returns a (possibly lying) reported amount so tests can prove the router uses balance deltas.
contract MockSwapRouter {
    address public factory;
    MockPool public pool;
    uint256 public nextOut;
    uint256 public reportedOut;
    uint160 public nextSqrt;

    constructor(address factory_, MockPool pool_) {
        factory = factory_;
        pool = pool_;
    }

    function script(uint256 out, uint256 reported, uint160 sqrtAfter) external {
        nextOut = out;
        reportedOut = reported;
        nextSqrt = sqrtAfter;
    }

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p) external returns (uint256) {
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        require(nextOut >= p.amountOutMinimum, "Too little received");
        MockERC20(p.tokenOut).mint(p.recipient, nextOut);
        pool.setSqrtPrice(nextSqrt);
        return reportedOut;
    }
}

contract DemoAgent is GuardConsumer {
    uint256 public actions;

    constructor(IExecutionGuard guard_) GuardConsumer(guard_) {}

    function act(Quote calldata q, bytes calldata sig) external requireFresh(q, sig) {
        actions += 1;
    }

    function tighten(Policy memory p) external {
        _setGuardPolicy(p);
    }
}

abstract contract PreflightBase is Test {
    uint256 internal constant ATTESTOR_PK = 0xA11CE;
    uint256 internal constant ROGUE_PK = 0xBAD;
    address internal attestor;
    address internal owner = makeAddr("owner");
    ExecutionGuard internal guard;

    function _deployGuard() internal {
        attestor = vm.addr(ATTESTOR_PK);
        guard = new ExecutionGuard(owner);
        vm.prank(owner);
        guard.addAttestor(attestor);
    }

    function _quote(
        address agent,
        address executor,
        address pool,
        bool zeroForOne,
        uint256 amountIn,
        uint160 fair
    ) internal view returns (Quote memory q) {
        q = Quote({
            agent: agent,
            executor: executor,
            pool: pool,
            zeroForOne: zeroForOne,
            amountIn: amountIn,
            expectedImpactBps: 1,
            fairSqrtPriceX96: fair,
            issuedAt: uint64(block.timestamp),
            expiry: uint64(block.timestamp + 60),
            nonce: uint256(keccak256(abi.encode(agent, amountIn, block.timestamp, gasleft())))
        });
    }

    function _sign(uint256 pk, Quote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, guard.hashQuote(q));
        return abi.encodePacked(r, s, v);
    }

    /// @dev sqrt price scaled so that price moves by `bps` (signed): sqrt * sqrt(1 + bps/1e4).
    function _shiftSqrt(uint160 sqrtX96, int256 bps) internal pure returns (uint160) {
        uint256 factor = uint256(int256(1e18) + bps * 1e14); // price factor, 1e18 scale
        return uint160((uint256(sqrtX96) * _sqrt(factor * 1e18)) / 1e18);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
