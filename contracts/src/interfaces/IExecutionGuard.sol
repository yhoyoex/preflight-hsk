// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Off-chain attested preflight quote for one swap.
/// @dev Prices are Uniswap V3 sqrtPriceX96 values (token1 per token0, raw units).
///      `expectedImpactBps` = execution cost vs pre-trade spot, excluding the LP fee.
struct Quote {
    address agent; // whose policy applies
    address executor; // the only address allowed to consume the quote (router, consumer contract, or agent)
    address pool; // Uniswap V3 pool; address(0) skips the on-chain spot deviation check
    bool zeroForOne;
    uint256 amountIn;
    uint32 expectedImpactBps;
    uint160 fairSqrtPriceX96; // attestor's fair price (e.g. CEX reference)
    uint64 issuedAt;
    uint64 expiry;
    uint256 nonce; // one-time per agent
}

struct Policy {
    uint32 maxImpactBps;
    uint32 maxDevBps;
    uint64 maxAge; // seconds
}

interface IExecutionGuard {
    event AttestorUpdated(address indexed attestor, bool allowed);
    event PolicySet(address indexed agent, uint32 maxImpactBps, uint32 maxDevBps, uint64 maxAge);
    event PolicyCleared(address indexed agent);
    event QuoteVerified(
        address indexed agent,
        address indexed executor,
        bytes32 indexed digest,
        address attestor,
        uint256 nonce,
        uint256 spotDevBps
    );

    error NotAttestor(address signer);
    error WrongExecutor(address expected, address caller);
    error QuoteExpired(uint64 expiry, uint256 nowTs);
    error QuoteFromFuture(uint64 issuedAt, uint256 nowTs);
    error QuoteStale(uint256 age, uint64 maxAge);
    error NonceUsed(address agent, uint256 nonce);
    error ImpactTooHigh(uint256 impactBps, uint32 maxImpactBps);
    error DeviationTooHigh(uint256 devBps, uint32 maxDevBps);
    error InvalidPolicy();
    error ZeroAddress();

    function verify(Quote calldata q, bytes calldata sig) external returns (Policy memory);
    function setPolicy(Policy calldata p) external;
    function clearPolicy() external;
    function policyOf(address agent) external view returns (Policy memory);
    function hashQuote(Quote calldata q) external view returns (bytes32);
    function isAttestor(address account) external view returns (bool);
}
