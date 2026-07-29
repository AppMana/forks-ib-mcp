import { IBClient } from "./ib-client.js";
import { IBGatewayManager } from "./gateway-manager.js";
import { HeadlessAuthenticator, HeadlessAuthConfig } from "./headless-auth.js";
import open from "open";
import { Logger } from "./logger.js";
import { FlexQueryClient } from "./flex-query-client.js";
import { FlexQueryStorage } from "./flex-query-storage.js";
import { getErrorMessage } from "./http.js";
import { isAuthenticationError as isIBAuthenticationError } from "./ib-client/types.js";
import {
  AuthenticateInput,
  GetAccountInfoInput,
  GetPositionsInput,
  GetOptionChainInput,
  ResolveOptionConidInput,
  GetMarketDataInput,
  SearchContractsInput,
  GetBondFiltersInput,
  GetSecdefInfoInput,
  GetContractDetailsInput,
  GetContractRulesInput,
  PlaceOrderInput,
  GetOrderStatusInput,
  CancelOrderInput,
  GetTradesInput,
  GetAccountLedgerInput,
  GetTransactionHistoryInput,
  GetTaxRulesInput,
  AnalyzeTaxTradeInput,
  GetLiveOrdersInput,
  ConfirmOrderInput,
  GetAlertsInput,
  CreateAlertInput,
  ActivateAlertInput,
  DeleteAlertInput,
  GetFlexQueryInput,
  ListFlexQueriesInput,
  ForgetFlexQueryInput,
} from "./tool-definitions.js";
import type { AccountEntry } from "./ib-client/types.js";
import {
  analyzeProposedBuy,
  analyzeProposedSale,
  type TaxAccountKind,
} from "./tax/analyze.js";
import { reconstructTransactionHistory } from "./tax/transaction-history.js";
import {
  parseDateOnly,
  US_IRS_INVESTMENT_RULES_2025,
} from "./tax/us-irs.js";

export interface ToolHandlerContext {
  ibClient: IBClient;
  gatewayManager?: IBGatewayManager;
  config: any;
  flexQueryClient?: FlexQueryClient;
  flexQueryStorage?: FlexQueryStorage;
}

type ToolHandlerResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

type AuthGuardResult =
  | { ok: true }
  | { ok: false; result: ToolHandlerResult };

type HeadlessAuthOutcome = {
  success: boolean;
  status?: string;
  message?: string;
  error?: string;
  browserKeptOpen?: boolean;
};

const DEFAULT_AUTH_WAIT_SECONDS = 60;
const DEFAULT_AUTH_POLL_SECONDS = 5;

/**
 * IBKR rate-limits rapid logins and will lock an account that keeps retrying. Without
 * this ceiling a broken login drives a fresh browser session on every tool call.
 */
const MAX_FAILED_LOGINS = 5;

function accountIdFromEntry(account: AccountEntry): string | undefined {
  return account.id?.trim() || account.accountId?.trim() || undefined;
}

function accountKindFromEntry(account: AccountEntry | undefined): TaxAccountKind {
  if (!account) return "UNKNOWN";
  const description = [
    account.type,
    account.accountType,
    account.accountDesc,
    account.accountTitle,
    account.accountAlias,
    account.accountName,
    account.displayName,
    account.desc,
  ].filter((value): value is string => typeof value === "string").join(" ").toUpperCase();
  if (description.includes("ROTH") && description.includes("IRA")) return "ROTH_IRA";
  if (description.includes("IRA")) return "IRA";
  if (description.includes("INDIVIDUAL") || description.includes("MARGIN") || description.includes("CASH")) {
    return "TAXABLE";
  }
  return "UNKNOWN";
}

function usAccountEvidence(account: AccountEntry | undefined): {
  status: "CONFIRMED" | "BROKER_ENTITY_ONLY" | "NONE";
  evidence: string[];
} {
  if (!account) return { status: "NONE", evidence: [] };
  const evidence: string[] = [];
  const countryKeys = ["taxCountry", "taxResidenceCountry", "country", "countryCode"];
  for (const key of countryKeys) {
    const value = account[key];
    if (typeof value === "string" && /^(US|USA|UNITED STATES)$/i.test(value.trim())) {
      evidence.push(`${key}=${value}`);
    }
  }
  if (evidence.length > 0) return { status: "CONFIRMED", evidence };

  const ibEntity = account.ibEntity;
  if (typeof ibEntity === "string" && /(?:^|[-_\s])US$/i.test(ibEntity.trim())) {
    return {
      status: "BROKER_ENTITY_ONLY",
      evidence: [`ibEntity=${ibEntity}`],
    };
  }
  return { status: "NONE", evidence: [] };
}

function easternTradeDate(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function positionForConid(data: unknown, conid: number): number | undefined {
  const candidates = Array.isArray(data)
    ? data
    : typeof data === "object" && data !== null
      && Array.isArray((data as Record<string, unknown>).positions)
      ? (data as Record<string, unknown>).positions as unknown[]
      : [];
  const values = candidates
    .filter((entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && Number(entry.conid) === conid
    )
    .map((entry) => Number(entry.position))
    .filter(Number.isFinite);
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
}

export class ToolHandlers {
  private context: ToolHandlerContext;
  private failedLogins = 0;

  constructor(context: ToolHandlerContext) {
    this.context = context;
    
    // Initialize flex query client and storage if token is provided
    // Only initialize if not already set (useful for testing)
    if (context.config.IB_FLEX_TOKEN && !context.flexQueryClient) {
      this.context.flexQueryClient = new FlexQueryClient({
        token: context.config.IB_FLEX_TOKEN,
      });
    }
    
    if (context.config.IB_FLEX_TOKEN && !context.flexQueryStorage) {
      this.context.flexQueryStorage = new FlexQueryStorage();
      // Initialize storage asynchronously
      this.context.flexQueryStorage.initialize().catch((error) => {
        Logger.error("[FLEX-QUERY] Failed to initialize storage:", error);
      });
    }
  }

  // Ensure Gateway is ready before operations
  private async ensureGatewayReady(): Promise<void> {
    if (this.context.gatewayManager) {
      await this.context.gatewayManager.ensureGatewayReady();
    }
  }

  private buildAuthUrl(): string {
    const port = this.context.gatewayManager
      ? this.context.gatewayManager.getCurrentPort()
      : this.context.config.IB_GATEWAY_PORT;
    return `https://${this.context.config.IB_GATEWAY_HOST}:${port}`;
  }

  private buildHeadlessAuthConfig(url: string, timeoutMs: number): HeadlessAuthConfig {
    const config = this.context.config;
    return {
      url,
      username: config.IB_USERNAME,
      password: config.IB_PASSWORD_AUTH,
      timeout: timeoutMs,
      ibClient: this.context.ibClient,
      paperTrading: config.IB_PAPER_TRADING,
      twoFaStrategy: config.IB_TWO_FA_STRATEGY,
      totpSecret: config.IB_TOTP_SECRET,
      selectors: {
        username: config.IB_SELECTOR_USERNAME || undefined,
        password: config.IB_SELECTOR_PASSWORD || undefined,
        loginSubmit: config.IB_SELECTOR_LOGIN_SUBMIT || undefined,
        totpInput: config.IB_SELECTOR_TOTP_INPUT || undefined,
        totpSubmit: config.IB_SELECTOR_TOTP_SUBMIT || undefined,
        totpDeviceSelect: config.IB_SELECTOR_TOTP_DEVICE_SELECT || undefined,
      },
    };
  }

  private textResult(text: string): ToolHandlerResult {
    return {
      content: [
        {
          type: "text",
          text,
        },
      ],
    };
  }

  private jsonResult(payload: unknown): ToolHandlerResult {
    return this.textResult(JSON.stringify(payload, null, 2));
  }

  private getAuthWaitOptions(): { maxWaitSeconds: number; pollSeconds: number } {
    const configuredWait = Number(this.context.config.IB_AUTH_WAIT_SECONDS);
    const configuredPoll = Number(this.context.config.IB_AUTH_POLL_SECONDS);

    const maxWaitSeconds =
      Number.isFinite(configuredWait) && configuredWait >= 0
        ? configuredWait
        : DEFAULT_AUTH_WAIT_SECONDS;
    const pollSeconds =
      Number.isFinite(configuredPoll) && configuredPoll > 0
        ? configuredPoll
        : DEFAULT_AUTH_POLL_SECONDS;

    return { maxWaitSeconds, pollSeconds };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Authentication management
  private async ensureAuth(): Promise<AuthGuardResult> {
    // Ensure Gateway is ready first
    await this.ensureGatewayReady();

    // Check if already authenticated
    let isAuthenticated = await this.context.ibClient.checkAuthenticationStatus();
    if (isAuthenticated) {
      return { ok: true };
    }

    // The brokerage session expires long before the SSO session does, so a plain
    // reauthenticate normally revives it - no browser, no 2FA, and no exposure to
    // IBKR's login rate limits. Try that before paying for a full login. This is the
    // cheap rung of the ladder and it works in browser mode too, where the only other
    // option is to make the user go and click through a login page.
    if (await this.tryReauthenticate()) {
      return { ok: true };
    }

    // If not authenticated, and not in headless mode, throw an error immediately.
    if (!this.context.config.IB_HEADLESS_MODE) {
      const authUrl = this.buildAuthUrl();
      throw new Error(`Authentication required. Please use the 'authenticate' tool to complete the authentication process at ${authUrl}.`);
    }

    // --- Headless Mode Logic ---
    // Validate that we have credentials for headless mode
    if (!this.context.config.IB_USERNAME || !this.context.config.IB_PASSWORD_AUTH) {
      return {
        ok: false,
        result: this.jsonResult({
          success: false,
          status: "AUTHENTICATION_CONFIGURATION_REQUIRED",
          message: "Headless authentication credentials are missing.",
          nextInstruction: "Set IB_USERNAME and IB_PASSWORD_AUTH, then try again.",
        }),
      };
    }
    
    // Stop hammering IBKR once a login is clearly not going to succeed: retrying on
    // every tool call is how an account ends up rate-limited or locked out.
    if (this.failedLogins >= MAX_FAILED_LOGINS) {
      return {
        ok: false,
        result: this.jsonResult({
          success: false,
          status: "AUTHENTICATION_CIRCUIT_OPEN",
          message: `Headless authentication failed ${this.failedLogins} times in a row. Refusing to retry automatically to avoid IBKR rate-limiting or an account lockout.`,
          nextInstruction:
            "Check IB_USERNAME, IB_PASSWORD_AUTH and IB_TOTP_SECRET, then call the 'authenticate' tool to reset the circuit and retry.",
        }),
      };
    }

    // Configuration for the polling loop
    const timeoutSeconds = this.context.config.IB_AUTH_TIMEOUT || 300; // 5 minutes default
    const pollIntervalSeconds = 5;
    const deadline = Date.now() + timeoutSeconds * 1000;

    Logger.info(`⚡ Headless authentication required. Starting process with a ${timeoutSeconds}s timeout.`);

    // Trigger headless authentication once, but don't wait for the promise here.
    // The promise is handled to log results, but the primary flow control is the polling loop.
    const authUrl = this.buildAuthUrl();
    const authConfig = this.buildHeadlessAuthConfig(authUrl, timeoutSeconds * 1000);

    const authenticator = new HeadlessAuthenticator();
    // Fire-and-forget the auth trigger, but handle its completion for logging/cleanup
    authenticator.authenticate(authConfig)
      .then(async (result) => {
        if (!result.browserKeptOpen) {
          await authenticator.close().catch(() => {});
        }
        Logger.info(`🎯 Headless authentication process completed: success=${result.success}`);
      })
      .catch(async (err) => {
        await authenticator.close().catch(() => {});
        Logger.error("❌ Headless authentication process failed:", err);
      });

    // Start the blocking polling loop
    while (Date.now() < deadline) {
      Logger.debug("Polling for authentication status...");
      isAuthenticated = await this.context.ibClient.checkAuthenticationStatus();
      if (isAuthenticated) {
        Logger.info("✅ Authentication successful.");
        this.failedLogins = 0;
        return { ok: true };
      }
      await this.sleep(pollIntervalSeconds * 1000);
    }

    // If the loop completes without success, we've timed out
    this.failedLogins++;
    Logger.error(`❌ Authentication timed out after ${timeoutSeconds} seconds (failure ${this.failedLogins}/${MAX_FAILED_LOGINS}).`);
    throw new Error(`Authentication timed out after ${timeoutSeconds} seconds. Please check for a 2FA notification on your device.`);
  }

  /**
   * Cheapest rung of the recovery ladder: a plain reauthenticate against the gateway,
   * reusing the SSO session we still hold. Costs one HTTP round trip and, unlike a full
   * login, involves no browser, no 2FA and no login rate limit.
   */
  private async tryReauthenticate(): Promise<boolean> {
    try {
      Logger.info("Brokerage session is not authenticated; attempting reauthenticate before a full login.");
      await this.context.ibClient.reauthenticate();
      const recovered = await this.context.ibClient.checkAuthenticationStatus();
      if (recovered) {
        Logger.info("✅ Reauthenticate restored the brokerage session; skipping full login.");
        this.failedLogins = 0;
      } else {
        Logger.info("Reauthenticate did not restore the session; a full login is required.");
      }
      return recovered;
    } catch (error) {
      Logger.warn("Reauthenticate failed; falling back to a full login:", error);
      return false;
    }
  }

  /**
   * Transport failures that mean "the connection died", not "the request was rejected".
   * A dropped socket to the gateway is recoverable by re-establishing the session, so it
   * has to be classified as an auth error - otherwise it surfaces raw to the caller and
   * the recovery path in ensureAuth never runs.
   */
  private isTransportError(error: any): boolean {
    const code = error?.code || error?.cause?.code;
    if (
      code === "ECONNRESET" ||
      code === "EPIPE" ||
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "UND_ERR_SOCKET" ||
      code === "UND_ERR_CONNECT_TIMEOUT"
    ) {
      return true;
    }

    const message = String(error?.message || "");
    return (
      message.includes("stream was destroyed") ||
      message.includes("socket hang up") ||
      message.includes("other side closed") ||
      message.includes("fetch failed")
    );
  }

  // Helper function to check for authentication errors
  private isAuthenticationError(error: any): boolean {
    if (!error) return false;
    return this.isTransportError(error) || isIBAuthenticationError(error);
  }

  private getAuthenticationErrorMessage(): string {
    const authUrl = this.buildAuthUrl();
    const mode = this.context.config.IB_HEADLESS_MODE ? "headless mode" : "browser mode";
    return `Authentication required. Please use the 'authenticate' tool to complete the authentication process (configured for ${mode}) at ${authUrl}.`;
  }

  /**
   * After browser opens for OAuth, poll the gateway until authenticated,
   * then trigger reauthenticate to establish the REST API session.
   * This bridges the gap between browser-based OAuth and the REST API auth state.
   *
   * Polling is bounded by a deadline (~2 minutes from start) rather than by attempt
   * count, so the upper bound matches the documented timeout regardless of backoff.
   */
  private startBrowserAuthPolling(authUrl: string, port: number): void {
    const pollWindowMs = 120_000; // 2 minutes total
    const initialDelay = 2000; // 2 second initial delay
    const maxDelay = 10_000;
    const deadline = Date.now() + pollWindowMs;
    let attempts = 0;

    const poll = async () => {
      attempts++;
      Logger.log(`[BROWSER-AUTH-POLL] Polling ${authUrl} (port ${port}) attempt ${attempts} until ${new Date(deadline).toISOString()}`);

      try {
        if (typeof this.context.ibClient.initializeBrokerageSession === "function") {
          const initialized = await this.context.ibClient.initializeBrokerageSession();
          if (initialized) {
            Logger.log(`[BROWSER-AUTH-POLL] Brokerage session initialized for ${authUrl} (port ${port})`);
            return; // Success, stop polling
          }
        } else {
          const isAuth = await this.context.ibClient.checkAuthenticationStatus();
          if (isAuth) {
            Logger.log(`[BROWSER-AUTH-POLL] Authentication detected for ${authUrl} (port ${port}), reauthenticating REST session`);
            await this.context.ibClient.reauthenticate();
            Logger.log(`[BROWSER-AUTH-POLL] Reauthentication successful for ${authUrl} (port ${port}), REST session established`);
            return; // Success, stop polling
          }
        }
      } catch (error) {
        Logger.warn(`[BROWSER-AUTH-POLL] Poll attempt ${attempts} failed for ${authUrl} (port ${port}):`, error);
      }

      const delay = Math.min(initialDelay + (attempts * 500), maxDelay);
      if (Date.now() + delay < deadline) {
        setTimeout(poll, delay);
      } else {
        Logger.warn(`[BROWSER-AUTH-POLL] Timed out waiting for browser authentication at ${authUrl} (port ${port}) after ${attempts} attempts`);
      }
    };

    // Start polling after initial delay
    setTimeout(poll, initialDelay);
  }

  private formatError(error: unknown): string {
    if (this.isAuthenticationError(error)) {
      return this.getAuthenticationErrorMessage();
    }
    
    return `Error: ${getErrorMessage(error)}`;
  }

  async authenticate(input: AuthenticateInput): Promise<ToolHandlerResult> {
    try {
      // An explicit authenticate call is the caller asserting they have fixed whatever
      // was broken, so it resets the circuit breaker that ensureAuth may have opened.
      this.failedLogins = 0;

      // Ensure Gateway is ready
      await this.ensureGatewayReady();

      const port = this.context.gatewayManager 
        ? this.context.gatewayManager.getCurrentPort() 
        : this.context.config.IB_GATEWAY_PORT;
      const authUrl = `https://${this.context.config.IB_GATEWAY_HOST}:${port}`;
      
      // Check if headless mode is enabled in config
      if (this.context.config.IB_HEADLESS_MODE) {
        try {
          // Use headless authentication
          const authConfig = this.buildHeadlessAuthConfig(authUrl, this.context.config.IB_AUTH_TIMEOUT);

          // Validate that we have credentials for headless mode
          if (!authConfig.username || !authConfig.password) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    message: "Headless mode enabled but authentication credentials missing",
                    error: "Please set IB_USERNAME and IB_PASSWORD_AUTH environment variables for headless authentication",
                    authUrl: authUrl,
                    instructions: [
                      "Set environment variables: IB_USERNAME and IB_PASSWORD_AUTH",
                      "Or disable headless mode by setting IB_HEADLESS_MODE=false",
                      "Then try authentication again"
                    ]
                  }, null, 2),
                },
              ],
            };
          }

          const authenticator = new HeadlessAuthenticator();
          const result = await authenticator.authenticate(authConfig);

          // Keep the browser alive only when the authenticator reports a user-action
          // 2FA state that can still be completed after this tool response.
          if (!result.browserKeptOpen) {
            await authenticator.close();
          }
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ...result,
                  authUrl: authUrl,
                  mode: "headless",
                  note: "Headless authentication completed automatically"
                }, null, 2),
              },
            ],
          };

        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  message: "Headless authentication failed, falling back to manual browser authentication",
                  error: errorMessage,
                  authUrl: authUrl,
                  mode: "fallback_to_manual",
                  note: "Opening browser for manual authentication..."
                }, null, 2),
              },
            ],
          };
        }
      }
      
      // Original browser-based authentication (when headless mode is disabled or as fallback)
      try {
        await open(authUrl);
        
        // Start polling for authentication to complete
        // The browser auth creates a server-side session that the REST API can use
        // We poll until authenticated, then trigger reauthenticate for the REST session
        this.startBrowserAuthPolling(authUrl, port);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                message: "Interactive Brokers authentication interface opened in your browser",
                authUrl: authUrl,
                mode: "browser",
                instructions: [
                  "1. The authentication page has been opened in your default browser",
                  "2. Accept any SSL certificate warnings (this is normal for localhost)",
                  "3. Complete the authentication process in the IB Gateway web interface",
                  "4. Log in with your Interactive Brokers credentials",
                  "5. Once authenticated, you can use other trading tools"
                ],
                browserOpened: true,
                polling: true,
                note: "IB Gateway is running locally - your credentials stay secure on your machine. Polling for authentication completion..."
              }, null, 2),
            },
          ],
        };
      } catch (browserError) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                message: "Opening Interactive Brokers authentication interface...",
                authUrl: authUrl,
                mode: "manual",
                instructions: [
                  "1. Open the authentication URL below in your browser:",
                  `   ${authUrl}`,
                  "2. Accept any SSL certificate warnings (this is normal for localhost)",
                  "3. Complete the authentication process",
                  "4. Log in with your Interactive Brokers credentials",
                  "5. Once authenticated, you can use other trading tools"
                ],
                browserOpened: false,
                note: "Please open the URL manually. IB Gateway is running locally."
              }, null, 2),
            },
          ],
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getAccountInfo(input: GetAccountInfoInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getAccountInfo();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getPositions(input: GetPositionsInput): Promise<ToolHandlerResult> {
    if (!input.accountId) {
      return {
        content: [
          {
            type: "text",
            text: "Account ID is required",
          },
        ],
      };
    }
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getPositions(input.accountId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getMarketData(input: GetMarketDataInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getMarketData(input.symbol, input.exchange);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getContractDetails(input: GetContractDetailsInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) return auth.result;
    try {
      return this.jsonResult(await this.context.ibClient.getContractDetails(input.conids));
    } catch (error) {
      return this.textResult(this.formatError(error));
    }
  }

  async searchContracts(input: SearchContractsInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) return auth.result;
    try {
      return this.jsonResult(await this.context.ibClient.searchContracts(input));
    } catch (error) {
      return this.textResult(this.formatError(error));
    }
  }

  async getBondFilters(input: GetBondFiltersInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) return auth.result;
    try {
      return this.jsonResult(await this.context.ibClient.getBondFilters(input.issuerId));
    } catch (error) {
      return this.textResult(this.formatError(error));
    }
  }

  async getSecdefInfo(input: GetSecdefInfoInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) return auth.result;
    try {
      return this.jsonResult(await this.context.ibClient.getSecdefInfo(input));
    } catch (error) {
      return this.textResult(this.formatError(error));
    }
  }

  async getContractRules(input: GetContractRulesInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) return auth.result;
    try {
      return this.jsonResult(
        await this.context.ibClient.getContractRules(input.conid, input.side, input.exchange),
      );
    } catch (error) {
      return this.textResult(this.formatError(error));
    }
  }

  async getOptionChain(input: GetOptionChainInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getOptionChain(input.symbol, input.exchange);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async resolveOptionConid(input: ResolveOptionConidInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.resolveOptionConid(
        input.symbol,
        input.expiry,
        input.strike,
        input.right,
        input.exchange,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async placeOrder(input: PlaceOrderInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.order({
        mode: input.mode,
        accountId: input.accountId,
        symbol: input.symbol,
        conid: input.conid,
        conidex: input.conidex,
        secType: input.secType,
        expiry: input.expiry,
        strike: input.strike,
        right: input.right,
        action: input.action,
        orderType: input.orderType,
        quantity: input.quantity, // Already converted by Zod schema
        cashQuantity: input.cashQuantity,
        fullPosition: input.fullPosition,
        price: input.price,
        stopPrice: input.stopPrice,
        taxOptimizerId: input.taxOptimizerId,
        validatePosition: input.validatePosition,
        suppressConfirmations: input.suppressConfirmations,
        exchange: input.exchange,
        tif: input.tif,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getOrderStatus(input: GetOrderStatusInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getOrderStatus(input.accountId, input.orderId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async cancelOrder(input: CancelOrderInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) return auth.result;
    try {
      return this.jsonResult(
        await this.context.ibClient.cancelOrder(input.accountId, input.orderId),
      );
    } catch (error) {
      return this.textResult(this.formatError(error));
    }
  }

  async getTrades(input: GetTradesInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) return auth.result;
    try {
      return this.jsonResult(
        await this.context.ibClient.getTrades(input.accountId, input.days),
      );
    } catch (error) {
      return this.textResult(this.formatError(error));
    }
  }

  async getAccountLedger(input: GetAccountLedgerInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) return auth.result;
    try {
      return this.jsonResult(await this.context.ibClient.getAccountLedger(input.accountId));
    } catch (error) {
      return this.textResult(this.formatError(error));
    }
  }

  async getTransactionHistory(input: GetTransactionHistoryInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) return auth.result;
    try {
      return this.jsonResult(
        await this.context.ibClient.getTransactionHistory(
          input.accountId,
          input.conid,
          input.currency,
          input.days,
        ),
      );
    } catch (error) {
      return this.textResult(this.formatError(error));
    }
  }

  async getTaxRules(input: GetTaxRulesInput): Promise<ToolHandlerResult> {
    let account: AccountEntry | undefined;
    if (input.accountId) {
      const auth = await this.ensureAuth();
      if (!auth.ok) return auth.result;
      try {
        account = (await this.context.ibClient.getPortfolioAccounts())
          .find((entry) => accountIdFromEntry(entry) === input.accountId);
      } catch (error) {
        return this.textResult(this.formatError(error));
      }
      if (!account) return this.textResult(`Account ${input.accountId} is not accessible`);
    }

    const evidence = usAccountEvidence(account);
    const applicability = input.jurisdiction === "US"
      ? "CALLER_CONFIRMED_US"
      : evidence.status === "CONFIRMED"
        ? "ACCOUNT_METADATA_CONFIRMS_US"
        : evidence.status === "BROKER_ENTITY_ONLY"
          ? "NEEDS_TAX_RESIDENCY_CONFIRMATION"
          : input.accountId ? "NEEDS_TAX_RESIDENCY_CONFIRMATION" : "JURISDICTION_NOT_SELECTED";
    return this.jsonResult({
      ruleSet: US_IRS_INVESTMENT_RULES_2025,
      applicability,
      accountId: input.accountId,
      accountEvidence: evidence,
      caveat: evidence.status === "BROKER_ENTITY_ONLY"
        ? "IBLLC-US identifies the broker entity, not necessarily the account owner's tax residence."
        : undefined,
    });
  }

  async analyzeTaxTrade(input: AnalyzeTaxTradeInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) return auth.result;
    try {
      const accounts = await this.context.ibClient.getPortfolioAccounts();
      const accountsById = new Map(
        accounts
          .map((account) => [accountIdFromEntry(account), account] as const)
          .filter((entry): entry is [string, AccountEntry] => Boolean(entry[0])),
      );
      const accountIds = [...new Set([input.accountId, ...input.relatedAccountIds])];
      const inaccessible = accountIds.filter((accountId) => !accountsById.has(accountId));
      if (inaccessible.length > 0) {
        throw new Error(`Accounts are not accessible: ${inaccessible.join(", ")}`);
      }

      const targetAccount = accountsById.get(input.accountId);
      const evidence = usAccountEvidence(targetAccount);
      const applicability = input.jurisdiction === "US"
        ? "CALLER_CONFIRMED_US"
        : evidence.status === "CONFIRMED"
          ? "ACCOUNT_METADATA_CONFIRMS_US"
          : "NEEDS_TAX_RESIDENCY_CONFIRMATION";
      const conids = [...new Set([input.conid, ...input.relatedConids])];
      const rawByConid = new Map<number, unknown>();
      const historyWarnings: string[] = [];
      for (const conid of conids) {
        try {
          rawByConid.set(
            conid,
            await this.context.ibClient.getTransactionHistoryForAccounts(
              accountIds,
              conid,
              input.currency,
              input.days,
            ),
          );
        } catch (error) {
          if (conid === input.conid) throw error;
          historyWarnings.push(
            `Could not retrieve related conid ${conid}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const reconstructions = [...rawByConid.entries()].flatMap(([conid, raw]) =>
        accountIds.map((accountId) =>
          reconstructTransactionHistory(
            raw,
            accountId,
            conid,
            accountKindFromEntry(accountsById.get(accountId)),
          )
        )
      );
      const target = reconstructions.find(
        (reconstruction) =>
          reconstruction.accountId === input.accountId && reconstruction.conid === input.conid,
      );
      if (!target) throw new Error("Target transaction history was not reconstructed");

      const acquisitions = reconstructions.flatMap((item) => item.acquisitions);
      const dispositions = reconstructions.flatMap((item) => item.dispositions);
      const reconstructionWarnings = reconstructions.flatMap((item) =>
        item.warnings.map((warning) => `${item.accountId}/${item.conid}: ${warning}`)
      );
      const tradeDate = parseDateOnly(input.tradeDate ?? easternTradeDate());
      const substantiallyIdenticalConids = new Set(conids);
      const common = {
        ruleSet: US_IRS_INVESTMENT_RULES_2025,
        applicability,
        accountEvidence: evidence,
        identityAssumption: {
          conids,
          status: input.relatedConids.length > 0
            ? "CALLER_DECLARED_SUBSTANTIALLY_IDENTICAL"
            : "SAME_CONTRACT_ONLY",
          caveat: "The IRS substantially-identical test is facts-and-circumstances. IBKR contract IDs do not decide that legal question.",
        },
        evidence: {
          source: "IBKR /pa/transactions",
          requestedDays: input.days,
          accountIds,
          authoritativeTaxLots: false,
          warnings: [...historyWarnings, ...reconstructionWarnings],
          limitations: [
            "PortfolioAnalyst transactions are reconstructed with FIFO and are not IBKR's authoritative open tax lots.",
            "Transfers, corporate actions, inherited basis, broker basis adjustments, and historical wash-sale basis changes require an authoritative tax-lot/Flex report.",
            "Future purchases through day +30 cannot be known at analysis time and remain an open wash-sale risk.",
          ],
          raw: input.includeRaw
            ? Object.fromEntries([...rawByConid.entries()].map(([conid, raw]) => [String(conid), raw]))
            : undefined,
        },
      };

      if (input.action === "BUY") {
        const analysis = analyzeProposedBuy({
          accountId: input.accountId,
          accountKind: accountKindFromEntry(targetAccount),
          conid: input.conid,
          quantity: input.quantity,
          tradeDate,
          dispositions,
          acquisitions,
          substantiallyIdenticalConids,
        });
        return this.jsonResult({
          ...common,
          confidence: common.evidence.warnings.length === 0
            ? "RECONSTRUCTED_NOT_AUTHORITATIVE"
            : "UNVERIFIED",
          analysis,
        });
      }

      if (input.unitPrice === undefined) {
        throw new Error("unitPrice is required for SELL tax analysis");
      }
      const positions = await this.context.ibClient.getPositions(input.accountId);
      const livePosition = positionForConid(positions, input.conid);
      const reconstructedPosition = target.openLots.reduce(
        (total, lot) => total + lot.remainingQuantity,
        0,
      );
      const positionReconciles = livePosition !== undefined
        && Math.abs(livePosition - reconstructedPosition) < 0.000001;
      const analysis = analyzeProposedSale({
        accountId: input.accountId,
        conid: input.conid,
        quantity: input.quantity,
        unitProceeds: input.unitPrice,
        tradeDate,
        openLots: target.openLots,
        acquisitions,
        dispositions,
        substantiallyIdenticalConids,
        lotMethod: input.lotMethod,
      });
      return this.jsonResult({
        ...common,
        confidence: positionReconciles && common.evidence.warnings.length === 0
          ? "RECONSTRUCTED_RECONCILED_NOT_AUTHORITATIVE"
          : "UNVERIFIED",
        positionReconciliation: {
          livePosition,
          reconstructedPosition,
          reconciles: positionReconciles,
        },
        analysis,
      });
    } catch (error) {
      return this.textResult(this.formatError(error));
    }
  }

  async getLiveOrders(input: GetLiveOrdersInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      // Pass accountId as query parameter if provided
      const result = await this.context.ibClient.getOrders(input.accountId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async confirmOrder(input: ConfirmOrderInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.confirmOrder(input.replyId, input.messageIds);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getAlerts(input: GetAlertsInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getAlerts(input.accountId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async createAlert(input: CreateAlertInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.createAlert(input.accountId, input.alertRequest);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async activateAlert(input: ActivateAlertInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.activateAlert(input.accountId, input.alertId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async deleteAlert(input: DeleteAlertInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.deleteAlert(input.accountId, input.alertId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  // ── Flex Query Methods ──────────────────────────────────────────────────────

  async getFlexQuery(input: GetFlexQueryInput): Promise<ToolHandlerResult> {
    try {
      if (!this.context.flexQueryClient) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Flex Query feature not configured",
                message: "Please set the IB_FLEX_TOKEN environment variable to use Flex Queries",
                instructions: [
                  "1. Get your Flex Web Service Token from Interactive Brokers",
                  "2. Set the IB_FLEX_TOKEN environment variable",
                  "3. Restart the MCP server"
                ]
              }, null, 2),
            },
          ],
        };
      }

      if (!this.context.flexQueryStorage) {
        throw new Error("Flex Query storage not initialized");
      }

      Logger.log(`[FLEX-QUERY] Executing flex query: ${input.queryId}`);

      // Check if this query was used before (by IB's query ID)
      const existingQuery = await this.context.flexQueryStorage.getQueryByQueryId(input.queryId);
      
      // Execute the query
      const result = await this.context.flexQueryClient.executeQuery(input.queryId);

      if (result.error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: result.error,
                errorCode: result.errorCode,
                queryId: input.queryId,
              }, null, 2),
            },
          ],
        };
      }

      // Parse XML to extract query name from the response
      let parsedData;
      let queryNameFromApi: string | undefined;
      
      if (result.data) {
        try {
          parsedData = await this.context.flexQueryClient.parseStatement(result.data);
          
          // Extract query name from the parsed XML
          // The queryName is directly under FlexQueryResponse
          if (parsedData?.FlexQueryResponse) {
            queryNameFromApi = parsedData.FlexQueryResponse.queryName;
          }
          
          Logger.log(`[FLEX-QUERY] Extracted query name from API: ${queryNameFromApi}`);
        } catch (parseError) {
          Logger.warn("[FLEX-QUERY] Failed to parse XML for query name extraction:", parseError);
        }
      }

      // Auto-save the query if it's new or update last used
      if (existingQuery) {
        await this.context.flexQueryStorage.markQueryUsed(existingQuery.id);
        Logger.log(`[FLEX-QUERY] Updated last used timestamp for query: ${input.queryId}`);
      } else {
        // Save new query with the name from API, input, or fallback to queryId
        const queryName = queryNameFromApi || input.queryName || input.queryId;
        await this.context.flexQueryStorage.saveQuery({
          name: queryName,
          queryId: input.queryId,
          description: `Auto-saved on ${new Date().toLocaleDateString()}`,
        });
        Logger.log(`[FLEX-QUERY] Auto-saved new query: ${queryName}`);
      }

      // Return parsed data if requested (and we haven't parsed it yet)
      if (input.parseXml && !parsedData && result.data) {
        try {
          parsedData = await this.context.flexQueryClient.parseStatement(result.data);
        } catch (parseError) {
          Logger.warn("[FLEX-QUERY] Failed to parse XML, returning raw data:", parseError);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              queryId: input.queryId,
              queryName: queryNameFromApi,
              autoSaved: !existingQuery,
              data: parsedData || result.data,
              note: existingQuery 
                ? "Query was previously saved and has been marked as used" 
                : "Query has been automatically saved for future reference"
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async listFlexQueries(input: ListFlexQueriesInput): Promise<ToolHandlerResult> {
    try {
      if (!this.context.flexQueryStorage) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Flex Query feature not configured",
                message: "Please set the IB_FLEX_TOKEN environment variable to use Flex Queries"
              }, null, 2),
            },
          ],
        };
      }

      const queries = await this.context.flexQueryStorage.listQueries();
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              count: queries.length,
              queries: queries.map(q => ({
                name: q.name,
                queryId: q.queryId,
                description: q.description,
                createdAt: q.createdAt,
                lastUsed: q.lastUsed,
              })),
              storageLocation: this.context.flexQueryStorage.getStorageFilePath(),
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async forgetFlexQuery(input: ForgetFlexQueryInput): Promise<ToolHandlerResult> {
    try {
      if (!this.context.flexQueryStorage) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Flex Query feature not configured",
                message: "Please set the IB_FLEX_TOKEN environment variable to use Flex Queries"
              }, null, 2),
            },
          ],
        };
      }

      // Try to find the query by IB's queryId first, then by name as fallback
      let query = await this.context.flexQueryStorage.getQueryByQueryId(input.queryId);
      
      if (!query) {
        // Try to find by name as fallback (in case user provides a friendly name)
        query = await this.context.flexQueryStorage.getQueryByName(input.queryId);
      }

      if (!query) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Query not found",
                message: `No saved query found with ID: ${input.queryId}`,
                suggestion: "Use list_flex_queries to see all saved queries"
              }, null, 2),
            },
          ],
        };
      }

      const deleted = await this.context.flexQueryStorage.deleteQuery(query.id);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: deleted,
              message: deleted 
                ? `Query "${query.name}" (${query.queryId}) has been forgotten` 
                : "Failed to delete query",
              queryId: input.queryId,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }
}
