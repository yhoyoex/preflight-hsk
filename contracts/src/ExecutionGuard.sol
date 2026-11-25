// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IExecutionGuard, Quote, Policy} from "./interfaces/IExecutionGuard.sol";
import {IUniswapV3PoolMinimal} from "./interfaces/IUniswapV3.sol";
import {PriceMath} from "./libraries/PriceMath.sol";

/// @title ExecutionGuard
/// @notice Verifies EIP-712 preflight quotes signed by registered attestors against the agent's own policy.
///         Holds no funds; the owner only manages the attestor registry. Ownership moves in two steps and
///         cannot be renounced (a lost owner would freeze the attestor registry forever).
contract ExecutionGuard is IExecutionGuard, Ownable2Step, EIP712 {
    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(address agent,address executor,address pool,bool zeroForOne,uint256 amountIn,"
        "uint32 expectedImpactBps,uint160 fairSqrtPriceX96,uint64 issuedAt,uint64 expiry,uint256 nonce)"
    );

    uint32 public constant DEFAULT_MAX_IMPACT_BPS = 100;
    uint32 public constant DEFAULT_MAX_DEV_BPS = 200;
    uint64 public constant DEFAULT_MAX_AGE = 120;
    uint64 public constant MAX_AGE_CAP = 1 days;

    mapping(address => bool) public override isAttestor;
    mapping(address => Policy) private _policies;
    mapping(address => bool) private _hasPolicy;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;

    error RenounceDisabled();

    constructor(address initialOwner) Ownable(initialOwner) EIP712("Preflight ExecutionGuard", "1") {}

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ------------------------------------------------------------------ attestor registry (owner)
    function addAttestor(address attestor) external onlyOwner {
        if (attestor == address(0)) revert ZeroAddress();
        isAttestor[attestor] = true;
        emit AttestorUpdated(attestor, true);
    }

    function removeAttestor(address attestor) external onlyOwner {
        isAttestor[attestor] = false;
        emit AttestorUpdated(attestor, false);
    }

    // ------------------------------------------------------------------ agent policy (self-managed)
    function setPolicy(Policy calldata p) external {
        if (
            p.maxImpactBps > PriceMath.BPS || p.maxDevBps > PriceMath.BPS || p.maxAge == 0
                || p.maxAge > MAX_AGE_CAP
        ) {
            revert InvalidPolicy();
        }
        _policies[msg.sender] = p;
        _hasPolicy[msg.sender] = true;
        emit PolicySet(msg.sender, p.maxImpactBps, p.maxDevBps, p.maxAge);
    }

    function clearPolicy() external {
        delete _policies[msg.sender];
        _hasPolicy[msg.sender] = false;
        emit PolicyCleared(msg.sender);
    }

    function policyOf(address agent) public view returns (Policy memory) {
        if (_hasPolicy[agent]) return _policies[agent];
        return Policy(DEFAULT_MAX_IMPACT_BPS, DEFAULT_MAX_DEV_BPS, DEFAULT_MAX_AGE);
    }

    // ------------------------------------------------------------------ verification
    function hashQuote(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH,
                    q.agent,
                    q.executor,
                    q.pool,
                    q.zeroForOne,
                    q.amountIn,
                    q.expectedImpactBps,
                    q.fairSqrtPriceX96,
                    q.issuedAt,
                    q.expiry,
                    q.nonce
                )
            )
        );
    }

    /// @notice Checks signature, freshness, nonce, quoted impact and current spot deviation; consumes the nonce.
    /// @dev Only `q.executor` may consume a quote, so a leaked signature cannot be burned by third parties.
    function verify(Quote calldata q, bytes calldata sig) external returns (Policy memory policy) {
        bytes32 digest = hashQuote(q);
        address signer = ECDSA.recover(digest, sig);
        if (!isAttestor[signer]) revert NotAttestor(signer);
        if (msg.sender != q.executor) revert WrongExecutor(q.executor, msg.sender);

        policy = policyOf(q.agent);
        if (block.timestamp > q.expiry) revert QuoteExpired(q.expiry, block.timestamp);
        if (q.issuedAt > block.timestamp) revert QuoteFromFuture(q.issuedAt, block.timestamp);
        uint256 age = block.timestamp - q.issuedAt;
        if (age > policy.maxAge) revert QuoteStale(age, policy.maxAge);
        if (nonceUsed[q.agent][q.nonce]) revert NonceUsed(q.agent, q.nonce);
        if (q.expectedImpactBps > policy.maxImpactBps) {
            revert ImpactTooHigh(q.expectedImpactBps, policy.maxImpactBps);
        }

        // Effects before the external slot0 call (CEI).
        nonceUsed[q.agent][q.nonce] = true;

        uint256 spotDev = 0;
        if (q.pool != address(0)) {
            if (q.fairSqrtPriceX96 == 0) revert DeviationTooHigh(type(uint256).max, policy.maxDevBps);
            (uint160 spot,,,,,,) = IUniswapV3PoolMinimal(q.pool).slot0();
            spotDev = PriceMath.deviationBps(spot, q.fairSqrtPriceX96);
            if (spotDev > policy.maxDevBps) revert DeviationTooHigh(spotDev, policy.maxDevBps);
        }

        emit QuoteVerified(q.agent, q.executor, digest, signer, q.nonce, spotDev);
    }
}
