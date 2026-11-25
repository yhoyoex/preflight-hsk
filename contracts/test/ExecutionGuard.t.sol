// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IExecutionGuard, Quote, Policy} from "../src/interfaces/IExecutionGuard.sol";
import {ExecutionGuard} from "../src/ExecutionGuard.sol";
import {GuardConsumer} from "../src/GuardConsumer.sol";
import {PriceMath} from "../src/libraries/PriceMath.sol";
import {PreflightBase, MockPool, DemoAgent, NonceProbePool} from "./utils/PreflightBase.sol";

/// @notice Unit tests, no fork required.
contract ExecutionGuardTest is PreflightBase {
    uint160 internal constant SPOT = 22523105442617287490681; // WHSK/USDT pool snapshot
    address internal agent = makeAddr("agent");
    MockPool internal pool;

    function setUp() public {
        vm.warp(1_800_000_000);
        _deployGuard();
        pool = new MockPool(SPOT, address(1), address(2));
    }

    function _q() internal view returns (Quote memory) {
        return _quote(agent, agent, address(pool), false, 50e6, SPOT);
    }

    function test_onlyOwnerManagesAttestors() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        guard.addAttestor(address(0xBEEF));
        vm.prank(owner);
        guard.removeAttestor(attestor);
        assertFalse(guard.isAttestor(attestor));
    }

    function test_defaultAndCustomPolicy() public {
        Policy memory p = guard.policyOf(agent);
        assertEq(p.maxImpactBps, 100);
        assertEq(p.maxDevBps, 200);
        assertEq(p.maxAge, 120);
        vm.prank(agent);
        guard.setPolicy(Policy(30, 50, 30));
        assertEq(guard.policyOf(agent).maxImpactBps, 30);
        vm.prank(agent);
        guard.clearPolicy();
        assertEq(guard.policyOf(agent).maxImpactBps, 100);
    }

    function test_rejectsInvalidPolicy() public {
        vm.expectRevert(IExecutionGuard.InvalidPolicy.selector);
        guard.setPolicy(Policy(100, 100, 0));
        vm.expectRevert(IExecutionGuard.InvalidPolicy.selector);
        guard.setPolicy(Policy(10_001, 100, 60));
    }

    function test_verifyHappyPathConsumesNonce() public {
        Quote memory q = _q();
        bytes memory sig = _sign(ATTESTOR_PK, q);
        bytes32 digest = guard.hashQuote(q);
        vm.expectEmit(true, true, true, false, address(guard));
        emit IExecutionGuard.QuoteVerified(agent, agent, digest, attestor, q.nonce, 0);
        vm.prank(agent);
        guard.verify(q, sig);
        assertTrue(guard.nonceUsed(agent, q.nonce));

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IExecutionGuard.NonceUsed.selector, agent, q.nonce));
        guard.verify(q, sig);
    }

    function test_revertsForRogueSigner() public {
        Quote memory q = _q();
        bytes memory sig = _sign(ROGUE_PK, q);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IExecutionGuard.NotAttestor.selector, vm.addr(ROGUE_PK)));
        guard.verify(q, sig);
    }

    function test_revertsForTamperedQuote() public {
        Quote memory q = _q();
        bytes memory sig = _sign(ATTESTOR_PK, q);
        q.amountIn = 50_000e6;
        vm.prank(agent);
        vm.expectPartialRevert(IExecutionGuard.NotAttestor.selector);
        guard.verify(q, sig);
    }

    function test_revertsForWrongExecutor() public {
        Quote memory q = _q();
        bytes memory sig = _sign(ATTESTOR_PK, q);
        vm.expectRevert(abi.encodeWithSelector(IExecutionGuard.WrongExecutor.selector, agent, address(this)));
        guard.verify(q, sig);
    }

    function test_revertsWhenExpiredStaleOrFuture() public {
        Quote memory q = _q();
        bytes memory sig = _sign(ATTESTOR_PK, q);
        vm.warp(block.timestamp + 61);
        vm.prank(agent);
        vm.expectPartialRevert(IExecutionGuard.QuoteExpired.selector);
        guard.verify(q, sig);

        q = _q();
        q.issuedAt = uint64(block.timestamp - 121);
        sig = _sign(ATTESTOR_PK, q);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IExecutionGuard.QuoteStale.selector, 121, 120));
        guard.verify(q, sig);

        q = _q();
        q.issuedAt = uint64(block.timestamp + 5);
        sig = _sign(ATTESTOR_PK, q);
        vm.prank(agent);
        vm.expectPartialRevert(IExecutionGuard.QuoteFromFuture.selector);
        guard.verify(q, sig);
    }

    function test_revertsWhenQuotedImpactAbovePolicy() public {
        Quote memory q = _q();
        q.expectedImpactBps = 101;
        bytes memory sig = _sign(ATTESTOR_PK, q);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IExecutionGuard.ImpactTooHigh.selector, 101, 100));
        guard.verify(q, sig);
    }

    function test_revertsWhenSpotDeviatesFromFair() public {
        Quote memory q = _q();
        q.fairSqrtPriceX96 = _shiftSqrt(SPOT, -500); // fair 5% below pool spot
        bytes memory sig = _sign(ATTESTOR_PK, q);
        vm.prank(agent);
        vm.expectPartialRevert(IExecutionGuard.DeviationTooHigh.selector);
        guard.verify(q, sig);
    }

    // Security #3: two-step ownership, renounce disabled.
    function test_ownershipIsTwoStepAndNotRenounceable() public {
        address next = makeAddr("next");
        vm.prank(owner);
        guard.transferOwnership(next);
        assertEq(guard.owner(), owner);
        assertEq(guard.pendingOwner(), next);
        vm.prank(next);
        guard.acceptOwnership();
        assertEq(guard.owner(), next);

        vm.prank(next);
        vm.expectRevert(ExecutionGuard.RenounceDisabled.selector);
        guard.renounceOwnership();
        assertEq(guard.owner(), next);
    }

    // Security #5: the nonce is consumed before the external slot0 call.
    function test_nonceConsumedBeforeSlot0() public {
        Quote memory q = _q();
        NonceProbePool probe = new NonceProbePool(guard, agent, q.nonce, SPOT);
        q.pool = address(probe);
        bytes memory sig = _sign(ATTESTOR_PK, q);
        vm.prank(agent);
        guard.verify(q, sig);
        assertTrue(guard.nonceUsed(agent, q.nonce));
    }

    // Security #2: a consumer only accepts quotes priced for itself.
    function test_consumerRejectsQuoteForAnotherAgent() public {
        DemoAgent demo = new DemoAgent(guard);
        Quote memory q = _quote(agent, address(demo), address(pool), false, 50e6, SPOT);
        bytes memory sig = _sign(ATTESTOR_PK, q);
        vm.expectRevert(abi.encodeWithSelector(GuardConsumer.QuoteNotForThisAgent.selector, agent));
        demo.act(q, sig);
        assertEq(demo.actions(), 0);
    }

    // Security #7: dust trades (ideal output rounds to 0) never pass an impact cap.
    function test_dustImpactIsMax() public pure {
        assertEq(PriceMath.impactBps(false, SPOT, 1, 3000, 0), type(uint256).max);
        assertEq(PriceMath.impactBps(true, SPOT, 1, 3000, 0), type(uint256).max);
    }

    function test_consumerModifier() public {
        DemoAgent demo = new DemoAgent(guard);
        Quote memory q = _quote(address(demo), address(demo), address(pool), false, 50e6, SPOT);
        bytes memory sig = _sign(ATTESTOR_PK, q);
        demo.act(q, sig);
        assertEq(demo.actions(), 1);

        vm.expectPartialRevert(IExecutionGuard.NonceUsed.selector);
        demo.act(q, sig);

        demo.tighten(Policy(100, 10, 120));
        q = _quote(address(demo), address(demo), address(pool), false, 50e6, _shiftSqrt(SPOT, 20));
        sig = _sign(ATTESTOR_PK, q);
        vm.expectPartialRevert(IExecutionGuard.DeviationTooHigh.selector);
        demo.act(q, sig);
        assertEq(demo.actions(), 1);
    }
}
