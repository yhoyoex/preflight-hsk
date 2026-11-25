// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IExecutionGuard, Quote, Policy} from "./interfaces/IExecutionGuard.sol";

/// @title GuardConsumer
/// @notice Base for agent contracts: gate any action behind a fresh attested preflight quote.
/// @dev Quotes must name this contract as `executor`. The contract is usually also the `agent`,
///      so it manages its own policy via `_setGuardPolicy`.
abstract contract GuardConsumer {
    IExecutionGuard public immutable guard;

    error GuardZeroAddress();
    /// @dev The quote must be priced against this contract's own policy, not another agent's.
    error QuoteNotForThisAgent(address agent);

    constructor(IExecutionGuard guard_) {
        if (address(guard_) == address(0)) revert GuardZeroAddress();
        guard = guard_;
    }

    modifier requireFresh(Quote calldata quote, bytes calldata sig) {
        if (quote.agent != address(this)) revert QuoteNotForThisAgent(quote.agent);
        guard.verify(quote, sig);
        _;
    }

    function _setGuardPolicy(Policy memory p) internal {
        guard.setPolicy(p);
    }
}
