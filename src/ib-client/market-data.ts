import { Logger } from "../logger.js";
import { getErrorMessage } from "../http.js";
import type { IBClientRequester } from "./accounts.js";
import {
  type ContractSearch,
  type OptionContractInfo,
  AuthenticationError,
  SymbolNotFoundError,
  isAuthenticationError,
} from "./types.js";

function matchesExchange(contract: ContractSearch | OptionContractInfo, exchange?: string): boolean {
  if (!exchange) return true;

  const target = exchange.toUpperCase();
  const values = [
    "exchange" in contract ? contract.exchange : undefined,
    "validExchanges" in contract ? contract.validExchanges : undefined,
    "description" in contract ? contract.description : undefined,
    "companyHeader" in contract ? contract.companyHeader : undefined,
    "sections" in contract && Array.isArray(contract.sections)
      ? contract.sections.map((section) => section.exchange).filter(Boolean).join(",")
      : undefined,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toUpperCase());

  return values.some((value) => value.includes(target));
}

export function pickContract<T extends ContractSearch | OptionContractInfo>(
  contracts: T[],
  exchange?: string,
): T {
  const match = contracts.find((contract) => matchesExchange(contract, exchange));
  return match ?? contracts[0];
}

export interface ContractSearchRequest {
  symbol: string;
  name?: boolean;
  secType?: string;
}

export interface SecdefInfoRequest {
  conid?: number;
  issuerId?: string;
  secType: string;
  month?: string;
  exchange?: string;
  strike?: number;
  right?: "C" | "P";
}

export async function searchContractDefinitions(
  client: IBClientRequester,
  request: ContractSearchRequest,
): Promise<ContractSearch[]> {
  const params = new URLSearchParams({ symbol: request.symbol });
  if (request.name !== undefined) params.set("name", String(request.name));
  if (request.secType) params.set("secType", request.secType);
  const response = await client.request<ContractSearch[]>(
    "GET",
    `/iserver/secdef/search?${params.toString()}`,
  );
  return response.data;
}

export async function searchContracts(client: IBClientRequester, symbol: string): Promise<ContractSearch[]> {
  const contracts = await searchContractDefinitions(client, { symbol });

  if (contracts.length === 0) {
    throw new SymbolNotFoundError(`Symbol ${symbol} not found`);
  }

  return contracts;
}

export async function getBondFilters(
  client: IBClientRequester,
  issuerId: string,
): Promise<unknown> {
  const params = new URLSearchParams({
    symbol: "BOND",
    issuerId,
  });
  const response = await client.request<unknown>(
    "GET",
    `/iserver/secdef/bond-filters?${params.toString()}`,
  );
  return response.data;
}

export async function getSecdefInfo(
  client: IBClientRequester,
  request: SecdefInfoRequest,
): Promise<unknown> {
  if (request.conid === undefined && !request.issuerId) {
    throw new Error("get_secdef_info requires conid or issuerId");
  }

  const params = new URLSearchParams();
  if (request.conid !== undefined) params.set("conid", String(request.conid));
  if (request.issuerId) params.set("issuerId", request.issuerId);
  params.set("secType", request.secType);
  if (request.month) params.set("month", request.month);
  if (request.exchange) params.set("exchange", request.exchange);
  if (request.strike !== undefined) params.set("strike", String(request.strike));
  if (request.right) params.set("right", request.right);
  const response = await client.request<unknown>(
    "GET",
    `/iserver/secdef/info?${params.toString()}`,
  );
  return response.data;
}

export async function getMarketData(
  client: IBClientRequester,
  symbol: string,
  exchange?: string,
): Promise<{ symbol: string; contract: ContractSearch; marketData: unknown }> {
  try {
    const searchUrl = `/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}`;
    const searchResponse = await client.request<ContractSearch[]>("GET", searchUrl);

    if (!searchResponse.data || searchResponse.data.length === 0) {
      throw new SymbolNotFoundError(`Symbol ${symbol}${exchange ? " on " + exchange : ""} not found`);
    }

    const contract = pickContract(searchResponse.data, exchange);
    const response = await client.request("GET",
      `/iserver/marketdata/snapshot?conids=${contract.conid}&fields=31,70,71,82,83,84,85,86,87,88,6509`,
    );
    return { symbol, contract, marketData: response.data };
  } catch (error: unknown) {
    Logger.error("Failed to get market data:", error);
    if (isAuthenticationError(error)) {
      throw new AuthenticationError(`Authentication required to retrieve market data for ${symbol}. Please authenticate with Interactive Brokers first.`);
    }
    if (error instanceof SymbolNotFoundError) throw error;
    throw new Error(`Failed to retrieve market data for ${symbol}: ${getErrorMessage(error)}`, { cause: error });
  }
}

export async function getContractDetails(
  client: IBClientRequester,
  conids: number[],
): Promise<unknown> {
  const response = await client.request("GET", "/trsrv/secdef", {
    params: { conids: conids.join(",") },
  });
  return response.data;
}

export async function getContractRules(
  client: IBClientRequester,
  conid: number,
  side: "BUY" | "SELL",
  exchange?: string,
): Promise<unknown> {
  const body: Record<string, unknown> = {
    conid,
    isBuy: side === "BUY",
  };
  if (exchange) body.exchange = exchange;

  const response = await client.request("POST", "/iserver/contract/rules", { body });
  return response.data;
}
