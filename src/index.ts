#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = "https://www.swaps.pro/api/sdk/v1";
const AGENT_PASS = process.env.SWAPSPRO_AGENT_PASS;

async function callApi(path: string, params: Record<string, string> = {}) {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "swapspro-mcp/1.0.0",
  };
  if (AGENT_PASS) headers["X-SwapsPro-Access"] = AGENT_PASS;

  const res = await fetch(url, { headers });
  const body = await res.json().catch(() => undefined);

  if (!res.ok) {
    const message =
      (body && (body.error || body.message)) || `swapspro API returned ${res.status}`;
    throw new Error(message);
  }
  return body;
}

function toolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `swapspro API error: ${message}` }],
    isError: true,
  };
}

// A cross-chain quote settles via deposit address + memo; a same-chain EVM
// quote settles via a signable tx (plus an optional approval tx). Detecting
// which fields the API actually returned lets the LLM branch without having
// to know swapspro's route-dependent schema up front.
function shapeQuote(quote: any) {
  if (quote && typeof quote === "object" && "depositAddress" in quote) {
    return {
      executionShape: "cross_chain_deposit",
      depositAddress: quote.depositAddress,
      memo: quote.memo ?? null,
      raw: quote,
    };
  }
  if (quote && typeof quote === "object" && ("tx" in quote || "transaction" in quote)) {
    return {
      executionShape: "evm_signable_tx",
      approvalTx: quote.approvalTx ?? quote.approval ?? null,
      tx: quote.tx ?? quote.transaction,
      raw: quote,
    };
  }
  return { executionShape: "unknown", raw: quote };
}

const server = new McpServer({ name: "swapspro-mcp", version: "1.0.0" });

server.registerTool(
  "discover_chains",
  {
    description: "Get all blockchain networks supported by swapspro.",
    inputSchema: {},
  },
  async () => {
    try {
      return toolResult(await callApi("/chains"));
    } catch (err) {
      return toolError(err);
    }
  }
);

server.registerTool(
  "discover_tokens",
  {
    description: "List tradable assets and addresses for a specific blockchain network.",
    inputSchema: {
      chainId: z.string().describe('Chain ID to query, e.g. "8453" for Base'),
    },
  },
  async ({ chainId }) => {
    try {
      return toolResult(await callApi("/tokens", { chainId }));
    } catch (err) {
      return toolError(err);
    }
  }
);

server.registerTool(
  "get_prices",
  {
    description: "Retrieve current pricing and exchange rate data across chains.",
    inputSchema: {},
  },
  async () => {
    try {
      return toolResult(await callApi("/prices"));
    } catch (err) {
      return toolError(err);
    }
  }
);

server.registerTool(
  "get_quote",
  {
    description:
      "Get an optimal swap route from swapspro. Returns a signable EVM transaction " +
      "(execution shape: evm_signable_tx) for same-chain swaps, or a deposit " +
      "address/memo (execution shape: cross_chain_deposit) for cross-chain swaps. " +
      "This server never signs or broadcasts anything — the client/wallet does that locally.",
    inputSchema: {
      sellChain: z.string().describe("Chain ID of the source network"),
      buyChain: z.string().describe("Chain ID of the destination network"),
      sellToken: z.string().describe('Symbol or address of the token being sold, e.g. "ETH"'),
      buyToken: z.string().describe('Symbol or address of the token being bought, e.g. "USDC"'),
      amount: z.string().describe('Quantity of the sell token, e.g. "0.1"'),
      address: z.string().describe("The user's wallet address that will initiate the swap"),
    },
  },
  async ({ sellChain, buyChain, sellToken, buyToken, amount, address }) => {
    try {
      const quote = await callApi("/quote", {
        sellChain,
        buyChain,
        sellToken,
        buyToken,
        amount,
        address,
      });
      return toolResult(shapeQuote(quote));
    } catch (err) {
      return toolError(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
