import { createFairPriceSource, createQuoteService, type QuoteRequest, type QuoteResponse, type QuoteService } from "@preflight/core";
import { createPublicClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { serverConfig } from "./config";

let service: QuoteService | undefined;

function quoteService(): QuoteService {
  if (!service) {
    const cfg = serverConfig();
    service = createQuoteService({
      client: createPublicClient({ transport: http(cfg.rpcUrl, { timeout: 15_000 }) }) as PublicClient,
      attestor: privateKeyToAccount(cfg.attestorKey),
      guard: cfg.guardAddress,
      chainId: cfg.chainId,
      fairPrice: createFairPriceSource(),
      ttlSeconds: cfg.quoteTtlSeconds,
    });
  }
  return service;
}

/** Signs only executable DEX verdicts with a fresh CEX reference (see core service.ts); otherwise quote/signature are null. */
export function createQuote(req: QuoteRequest): Promise<QuoteResponse> {
  return quoteService().quote(req);
}
