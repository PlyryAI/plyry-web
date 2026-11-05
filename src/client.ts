import { PlyryApiError, PlyrySessionChangedError, isRecord } from "./errors.js";
import {
  DEFAULT_SCOPES,
  type AccountResponse,
  type BinaryDownload,
  type ConversionCreateInput,
  type ConversionJob,
  type ConversionMappingInput,
  type ConversionPriceResponse,
  type ConversionResponse,
  type ConversionRevisionResponse,
  type FabricationButtonsResponse,
  type GenerationInput,
  type GenerationJob,
  type GenerationListOptions,
  type GenerationListResponse,
  type GenerationResponse,
  type LinkedAppSession,
  type ModelCatalog,
  type PaymentConfig,
  type QuoteInput,
  type QuoteResponse,
  type RefreshTokenStore,
  type Scope,
  type SignupChallenge,
  type TopupResponse,
  type WalletLedgerResponse,
  type WalletResponse,
  type WalletTopupInput,
} from "./types.js";

export const DEFAULT_API_BASE_URL = "https://plyry.com/v1";

export type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PlyryClientOptions {
  /** API root or versioned URL. Defaults to https://plyry.com/v1. */
  baseUrl?: string;
  /** Use the platform fetch implementation or inject a compatible fetch function. */
  fetch?: FetchFunction;
  /** Optional API key for server-side use. Never embed a secret API key in browser code. */
  apiKey?: string;
  /** Name displayed in the user's Linked apps page. */
  appName?: string;
  /** Minimal account and generation scopes are requested by default. */
  scopes?: readonly Scope[];
  /** Optional origin for non-browser clients. In browsers the API reads the Origin header. */
  origin?: string;
  /** Optional application-owned refresh-token storage. No token storage is enabled by default. */
  tokenStore?: RefreshTokenStore;
}

export interface AuthInput {
  email: string;
  password: string;
  appName?: string;
  scopes?: readonly Scope[];
  origin?: string;
  signal?: AbortSignal;
}

export interface SignupInput extends AuthInput {
  signupChallenge: string;
  answer: string;
}

export interface RequestOptions extends RequestInit {
  /** Defaults to true. Set false only for public API routes such as sign-in or the model catalog. */
  authenticated?: boolean;
}

export interface TopupStatusOptions {
  signal?: AbortSignal;
}

export interface DownloadOptions {
  signal?: AbortSignal;
}

export class PlyryClient {
  readonly baseUrl: string;
  readonly appName: string;
  readonly scopes: readonly Scope[];

  private readonly fetcher: FetchFunction;
  private readonly apiKey?: string;
  private readonly origin?: string;
  private readonly tokenStore?: RefreshTokenStore;
  private accessToken = "";
  private refreshToken = "";
  private _grantedScopes: readonly Scope[] = Object.freeze([]);
  private accessTokenExpiresAt = 0;
  private refreshInFlight: Promise<void> | null = null;
  private sessionRevision = 0;
  private authenticationAttempt = 0;
  private tokenStoreQueue: Promise<void> = Promise.resolve();
  private _tokenStorageWarning = "";

  constructor(options: PlyryClientOptions = {}) {
    this.baseUrl = normalizeApiBaseUrl(options.baseUrl ?? DEFAULT_API_BASE_URL);
    this.appName = (options.appName ?? "Plyry App").trim() || "Plyry App";
    this.scopes = Object.freeze(normalizeScopes(options.scopes ?? DEFAULT_SCOPES, true));
    this.apiKey = options.apiKey?.trim() || undefined;
    this.origin = options.origin?.trim() || undefined;
    this.tokenStore = options.tokenStore;

    const platformFetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!platformFetch) {
      throw new Error("PlyryClient needs a fetch implementation. Pass options.fetch or use a runtime with global fetch.");
    }
    this.fetcher = platformFetch;
  }

  /** Indicates a failed optional token-store operation. The in-memory session can still work. */
  get tokenStorageWarning(): string {
    return this._tokenStorageWarning;
  }

  /** True when this client has an access token, refresh token, or configured API key. */
  get isAuthenticated(): boolean {
    return Boolean(this.apiKey || this.accessToken || this.refreshToken);
  }

  /** True when this client holds a linked-app user session (as opposed to a server API key). */
  get hasLinkedAppSession(): boolean {
    return Boolean(this.accessToken || this.refreshToken);
  }

  /** Scopes granted by the active linked-app session, or an empty list when none is active. */
  get grantedScopes(): readonly Scope[] {
    return this._grantedScopes;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { authenticated = true, ...init } = options;
    const revision = this.sessionRevision;
    const response = await this.fetchResponse(path, init, authenticated, false, revision);
    const value = await readBody(response);
    if (authenticated && revision !== this.sessionRevision) throw new PlyrySessionChangedError();
    if (!response.ok || (isRecord(value) && value.ok === false)) {
      throw PlyryApiError.fromResponse(response.status, response.statusText, value);
    }
    return value as T;
  }

  async requestBlob(path: string, options: DownloadOptions = {}): Promise<BinaryDownload> {
    const revision = this.sessionRevision;
    const response = await this.fetchResponse(
      path,
      { signal: options.signal, headers: { Accept: "*/*" } },
      true,
      false,
      revision,
    );
    if (!response.ok) {
      const value = await readBody(response);
      if (revision !== this.sessionRevision) throw new PlyrySessionChangedError();
      throw PlyryApiError.fromResponse(response.status, response.statusText, value);
    }
    const blob = await response.blob();
    if (revision !== this.sessionRevision) throw new PlyrySessionChangedError();
    return {
      blob,
      contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream",
      sha256: response.headers.get("X-Plyry-Media-SHA256"),
      cacheToken: response.headers.get("X-Plyry-Cache-Token"),
      filename: responseFilename(response.headers.get("content-disposition")),
      status: response.status,
    };
  }

  getOpenApiSpecification<T = Record<string, unknown>>(signal?: AbortSignal): Promise<T> {
    return this.request<T>("/openapi.json", { method: "GET", authenticated: false, signal });
  }

  createSignupChallenge(email: string, signal?: AbortSignal): Promise<SignupChallenge> {
    this.authenticationAttempt++;
    return this.jsonRequest<SignupChallenge>("/auth/signup/challenges", { email }, false, signal);
  }

  async signIn(input: AuthInput): Promise<LinkedAppSession> {
    const requestedScopes = normalizeScopes(input.scopes ?? this.scopes);
    const payload = this.authPayload(input);
    const attempt = ++this.authenticationAttempt;
    const response = await this.jsonRequest<TokenResponse>("/auth/login", payload, false, input.signal);
    return this.acceptAuthenticationResponse(response, attempt, requestedScopes);
  }

  async signUp(input: SignupInput): Promise<LinkedAppSession> {
    const requestedScopes = normalizeScopes(input.scopes ?? this.scopes);
    const payload = {
      ...this.authPayload(input),
      signup_challenge: input.signupChallenge,
      answer: input.answer,
    };
    const attempt = ++this.authenticationAttempt;
    const response = await this.jsonRequest<TokenResponse>("/auth/signup", payload, false, input.signal);
    return this.acceptAuthenticationResponse(response, attempt, requestedScopes);
  }

  /** Refreshes and rotates the linked-app tokens. A rejected token clears the optional store. */
  async refreshSession(): Promise<void> {
    await this.refreshAccessToken();
  }

  /** Restores a token from the optional store, refreshes it, then reads the linked account. */
  async restoreSession(signal?: AbortSignal): Promise<AccountResponse["user"] | null> {
    const attempt = ++this.authenticationAttempt;
    const revision = this.sessionRevision;
    if (!this.refreshToken && this.tokenStore) {
      const savedToken = await this.loadStoredRefreshToken();
      if (attempt !== this.authenticationAttempt || revision !== this.sessionRevision) {
        throw new PlyrySessionChangedError();
      }
      this.refreshToken = savedToken ?? "";
    }
    if (!this.refreshToken) return null;
    await this.refreshAccessToken();
    if (attempt !== this.authenticationAttempt || revision !== this.sessionRevision) {
      throw new PlyrySessionChangedError();
    }
    if (!this._grantedScopes.includes("account:read")) return null;
    const response = await this.getMe(signal);
    if (attempt !== this.authenticationAttempt || revision !== this.sessionRevision) {
      throw new PlyrySessionChangedError();
    }
    return response.user;
  }

  /** Clears local credentials immediately, then asks Plyry to revoke the refresh token. */
  async signOut(signal?: AbortSignal): Promise<void> {
    const token = this.refreshToken;
    this.authenticationAttempt++;
    this.sessionRevision++;
    this.clearMemoryTokens();
    await this.syncStoredRefreshToken();
    if (!token) return;
    await this.jsonRequest("/auth/revoke", { refresh_token: token }, false, signal);
  }

  getMe(signal?: AbortSignal): Promise<AccountResponse> {
    return this.request<AccountResponse>("/me", { method: "GET", signal });
  }

  getModels(signal?: AbortSignal): Promise<ModelCatalog> {
    return this.request<ModelCatalog>("/models", { method: "GET", authenticated: false, signal });
  }

  quoteGeneration(input: QuoteInput, signal?: AbortSignal): Promise<QuoteResponse> {
    return this.jsonRequest<QuoteResponse>("/quotes", input, true, signal);
  }

  createGeneration(input: GenerationInput, signal?: AbortSignal): Promise<GenerationResponse> {
    const references = input.references ?? [];
    if (references.length > 7) throw new RangeError("Plyry accepts at most seven reference files.");
    if (references.length === 0) {
      const { references: unusedReferences, ...jsonInput } = input;
      void unusedReferences;
      return this.jsonRequest<GenerationResponse>("/generations", jsonInput, true, signal);
    }

    const form = new FormData();
    form.append("type", input.type);
    form.append("prompt", input.prompt);
    if (input.model) form.append("model", input.model);
    if (input.quality) form.append("quality", input.quality);
    if (input.reference_mode) form.append("reference_mode", input.reference_mode);
    if (input.splat_quality) form.append("splat_quality", input.splat_quality);
    if (input.queue_options) form.append("queue_options", JSON.stringify(input.queue_options));
    if (input.reference_text_only) form.append("reference_text_only", "1");
    form.append("reference_count", String(references.length));

    const seenSlots = new Set<number>();
    references.forEach((reference, index) => {
      const slot = reference.slot ?? index + 1;
      if (!Number.isInteger(slot) || slot < 1 || slot > 7 || seenSlots.has(slot)) {
        throw new RangeError("Reference slots must be unique integers from 1 to 7.");
      }
      seenSlots.add(slot);
      form.append("reference_slots[]", String(slot));
      form.append("references[]", reference.file, reference.filename || `reference-${slot}.bin`);
    });
    return this.request<GenerationResponse>("/generations", {
      method: "POST",
      body: form,
      signal,
    });
  }

  listGenerations(options: GenerationListOptions = {}, signal?: AbortSignal): Promise<GenerationListResponse> {
    const query = new URLSearchParams();
    if (options.page !== undefined) query.set("page", String(options.page));
    if (options.per_page !== undefined) query.set("per_page", String(options.per_page));
    if (options.status) query.set("status", options.status);
    if (options.type) query.set("type", options.type);
    const serialized = query.toString();
    const suffix = serialized ? `?${serialized}` : "";
    return this.request<GenerationListResponse>(`/generations${suffix}`, { method: "GET", signal });
  }

  getGeneration(hash: string, signal?: AbortSignal): Promise<GenerationResponse> {
    return this.request<GenerationResponse>(`/generations/${encodeURIComponent(hash)}`, { method: "GET", signal });
  }

  downloadGenerationMedia(hash: string, options: DownloadOptions = {}): Promise<BinaryDownload> {
    return this.requestBlob(`/media/${encodeURIComponent(hash)}`, options);
  }

  downloadGenerationScene(hash: string, options: DownloadOptions = {}): Promise<BinaryDownload> {
    return this.requestBlob(`/media/${encodeURIComponent(hash)}/scene`, options);
  }

  acknowledgeCachedGeneration(
    hash: string,
    input: { cache_token: string; sha256: string },
    signal?: AbortSignal,
  ): Promise<GenerationResponse> {
    return this.jsonRequest<GenerationResponse>(`/generations/${encodeURIComponent(hash)}/cache`, input, true, signal);
  }

  getWallet(signal?: AbortSignal): Promise<WalletResponse> {
    return this.request<WalletResponse>("/wallet", { method: "GET", signal });
  }

  getWalletLedger(page = 1, signal?: AbortSignal): Promise<WalletLedgerResponse> {
    const query = new URLSearchParams({ page: String(page) });
    return this.request<WalletLedgerResponse>(`/wallet/ledger?${query}`, { method: "GET", signal });
  }

  getPaymentConfig(signal?: AbortSignal): Promise<PaymentConfig> {
    return this.request<PaymentConfig>("/payments/config", { method: "GET", signal });
  }

  createWalletTopup(
    input: WalletTopupInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<TopupResponse> {
    requireUuidV4(idempotencyKey);
    return this.jsonRequest<TopupResponse>("/wallet/topups", input, true, signal, {
      "Idempotency-Key": idempotencyKey,
    });
  }

  getWalletTopupStatus(requestKey: string, options: TopupStatusOptions = {}): Promise<TopupResponse> {
    requireUuidV4(requestKey);
    return this.request<TopupResponse>(`/wallet/topups/requests/${encodeURIComponent(requestKey)}`, {
      method: "GET",
      signal: options.signal,
    });
  }

  reconcileWalletTopup(paymentIntentId: string, signal?: AbortSignal): Promise<TopupResponse> {
    return this.jsonRequest<TopupResponse>("/wallet/topups/reconcile", { payment_intent_id: paymentIntentId }, true, signal);
  }

  getPlant3dToRevitPrice(signal?: AbortSignal): Promise<ConversionPriceResponse> {
    return this.request<ConversionPriceResponse>("/conversions/plant3d-to-revit/price", {
      method: "GET",
      signal,
    });
  }

  createPlant3dToRevitJob(
    input: ConversionCreateInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ConversionResponse> {
    requireUuidV4(idempotencyKey);
    const form = new FormData();
    form.append("pcf", input.pcf, input.pcf_filename || "plant3d.pcf");
    form.append("catalog", input.catalog, input.catalog_filename || "fabrication-catalog.json");
    return this.request<ConversionResponse>("/conversions/plant3d-to-revit/jobs", {
      method: "POST",
      body: form,
      headers: { "Idempotency-Key": idempotencyKey },
      signal,
    });
  }

  getPlant3dToRevitJob(hash: string, signal?: AbortSignal): Promise<{ ok: true; job: ConversionJob }> {
    return this.request<{ ok: true; job: ConversionJob }>(`/conversions/plant3d-to-revit/jobs/${encodeURIComponent(hash)}`, {
      method: "GET",
      signal,
    });
  }

  searchPlant3dToRevitButtons(
    hash: string,
    options: { q?: string; all?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<FabricationButtonsResponse> {
    const query = new URLSearchParams();
    if (options.q) query.set("q", options.q);
    if (options.all) query.set("all", "1");
    const serialized = query.toString();
    const suffix = serialized ? `?${serialized}` : "";
    return this.request<FabricationButtonsResponse>(
      `/conversions/plant3d-to-revit/jobs/${encodeURIComponent(hash)}/buttons${suffix}`,
      { method: "GET", signal },
    );
  }

  revisePlant3dToRevitMapping(
    hash: string,
    input: ConversionMappingInput,
    signal?: AbortSignal,
  ): Promise<ConversionRevisionResponse> {
    return this.jsonRequest(
      `/conversions/plant3d-to-revit/jobs/${encodeURIComponent(hash)}/mapping`,
      input,
      true,
      signal,
    );
  }

  downloadPlant3dToRevitMapping(hash: string, options: DownloadOptions = {}): Promise<BinaryDownload> {
    return this.requestBlob(
      `/conversions/plant3d-to-revit/jobs/${encodeURIComponent(hash)}/download`,
      options,
    );
  }

  private async jsonRequest<T>(
    path: string,
    body: unknown,
    authenticated: boolean,
    signal?: AbortSignal,
    extraHeaders?: HeadersInit,
  ): Promise<T> {
    const headers = new Headers(extraHeaders);
    headers.set("Content-Type", "application/json; charset=utf-8");
    return this.request<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers,
      authenticated,
      signal,
    });
  }

  private authPayload(input: AuthInput): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      email: input.email,
      password: input.password,
      app_name: input.appName?.trim() || this.appName,
      scopes: normalizeScopes(input.scopes ?? this.scopes),
    };
    const origin = input.origin?.trim() || this.origin;
    if (origin) payload.origin = origin;
    return payload;
  }

  private async acceptAuthenticationResponse(
    response: TokenResponse,
    attempt: number,
    requestedScopes: readonly Scope[],
  ): Promise<LinkedAppSession> {
    if (attempt !== this.authenticationAttempt) {
      if (response.refresh_token) await this.revokeStaleRefreshToken(response.refresh_token);
      throw new PlyrySessionChangedError();
    }
    if (!response.user || !response.linked_app) {
      if (response.refresh_token) await this.revokeStaleRefreshToken(response.refresh_token);
      throw new PlyryApiError(502, "invalid_token_response", "Plyry returned an incomplete linked-app session.");
    }
    const revision = ++this.sessionRevision;
    try {
      await this.applyTokenResponse(response, revision, requestedScopes);
    } catch (error) {
      if (error instanceof PlyryApiError && error.code === "invalid_token_response" && response.refresh_token) {
        await this.revokeStaleRefreshToken(response.refresh_token);
      }
      throw error;
    }
    return {
      created: Boolean(response.created),
      user: response.user,
      linked_app: response.linked_app,
      scopes: [...this._grantedScopes],
    };
  }

  private async applyTokenResponse(
    response: TokenResponse,
    expectedRevision: number,
    fallbackScopes: readonly Scope[] = this._grantedScopes,
  ): Promise<void> {
    if (!response || typeof response.access_token !== "string" || !response.access_token
      || typeof response.refresh_token !== "string" || !response.refresh_token) {
      throw new PlyryApiError(502, "invalid_token_response", "Plyry returned an invalid session response.");
    }
    let grantedScopes: Scope[];
    try {
      grantedScopes = response.scopes
        ? normalizeScopes(response.scopes)
        : normalizeScopes(fallbackScopes);
    } catch {
      throw new PlyryApiError(502, "invalid_token_response", "Plyry returned invalid API scopes.");
    }
    this.accessToken = response.access_token;
    this.refreshToken = response.refresh_token;
    this._grantedScopes = Object.freeze(grantedScopes);
    const expiresIn = Number.isFinite(response.expires_in) ? response.expires_in : 900;
    this.accessTokenExpiresAt = Date.now() + Math.max(60, Math.min(expiresIn, 86_400)) * 1000;
    await this.syncStoredRefreshToken();
    if (expectedRevision !== this.sessionRevision || this.refreshToken !== response.refresh_token) {
      await this.revokeStaleRefreshToken(response.refresh_token);
      throw new PlyrySessionChangedError();
    }
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new PlyryApiError(401, "missing_refresh_token", "Sign in to your Plyry account first.");
    }
    if (this.refreshInFlight) return this.refreshInFlight;
    const refreshToken = this.refreshToken;
    const revision = this.sessionRevision;
    const flight = this.performRefresh(refreshToken, revision);
    this.refreshInFlight = flight;
    try {
      await flight;
    } finally {
      if (this.refreshInFlight === flight) this.refreshInFlight = null;
    }
  }

  private async performRefresh(refreshToken: string, revision: number): Promise<void> {
    try {
      const response = await this.jsonRequest<TokenResponse>("/auth/refresh", { refresh_token: refreshToken }, false);
      if (revision !== this.sessionRevision || refreshToken !== this.refreshToken) {
        if (response.refresh_token) await this.revokeStaleRefreshToken(response.refresh_token);
        throw new PlyrySessionChangedError();
      }
      await this.applyTokenResponse(response, revision);
    } catch (error) {
      if (revision === this.sessionRevision && refreshToken === this.refreshToken
        && (isInvalidRefresh(error) || (error instanceof PlyryApiError && error.code === "invalid_token_response"))) {
        this.clearMemoryTokens();
        await this.syncStoredRefreshToken();
      }
      throw error;
    }
  }

  private async syncStoredRefreshToken(): Promise<void> {
    if (!this.tokenStore) return;
    const operation = this.tokenStoreQueue.then(async () => {
      const token = this.refreshToken;
      try {
        if (token) await this.tokenStore!.saveRefreshToken(token);
        else await this.tokenStore!.clearRefreshToken();
        this._tokenStorageWarning = "";
      } catch {
        this._tokenStorageWarning = token
          ? "The Plyry session is active, but the configured token store could not save it."
          : "The Plyry session ended, but the configured token store could not clear it.";
      }
    });
    this.tokenStoreQueue = operation;
    await operation;
  }

  private async loadStoredRefreshToken(): Promise<string | null> {
    if (!this.tokenStore) return null;
    let token: string | null = null;
    const operation = this.tokenStoreQueue.then(async () => {
      try {
        token = (await this.tokenStore!.loadRefreshToken())?.trim() || null;
        this._tokenStorageWarning = "";
      } catch {
        this._tokenStorageWarning = "The configured Plyry token store could not load the saved session.";
      }
    });
    this.tokenStoreQueue = operation;
    await operation;
    return token;
  }

  private clearMemoryTokens(): void {
    this.accessToken = "";
    this.refreshToken = "";
    this.accessTokenExpiresAt = 0;
    this._grantedScopes = Object.freeze([]);
  }

  private async revokeStaleRefreshToken(token: string): Promise<void> {
    try {
      await this.jsonRequest("/auth/revoke", { refresh_token: token }, false);
    } catch {
      // The response belongs to a session that no longer exists locally.
    }
  }

  private async fetchResponse(
    path: string,
    init: RequestInit,
    authenticated: boolean,
    retried = false,
    revision = this.sessionRevision,
  ): Promise<Response> {
    const safePath = validateApiPath(path);
    if (authenticated && !this.apiKey && this.refreshToken
      && (!this.accessToken || this.accessTokenExpiresAt <= Date.now() + 30_000)) {
      await this.refreshAccessToken();
    }
    if (authenticated && revision !== this.sessionRevision) throw new PlyrySessionChangedError();

    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    const token = this.apiKey || this.accessToken;
    if (authenticated && token) headers.set("Authorization", `Bearer ${token}`);
    const response = await this.fetcher(`${this.baseUrl}${safePath}`, {
      ...init,
      headers,
      credentials: "omit",
    });
    if (authenticated && revision !== this.sessionRevision) throw new PlyrySessionChangedError();
    if (authenticated && response.status === 401 && !retried && !this.apiKey && this.refreshToken) {
      await this.refreshAccessToken();
      if (revision !== this.sessionRevision) throw new PlyrySessionChangedError();
      return this.fetchResponse(path, init, authenticated, true, revision);
    }
    return response;
  }
}

export function createIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error("A secure crypto.getRandomValues implementation is required to create an idempotency key.");
  }
  if (typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Enter a valid absolute Plyry API URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("The Plyry API URL cannot include credentials, a query string, or a fragment.");
  }
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(localHost && url.protocol === "http:")) {
    throw new TypeError("Use HTTPS for the Plyry API URL. HTTP is allowed only for localhost.");
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (path.toLowerCase().endsWith("/v1")) path = path.slice(0, -3).replace(/\/+$/, "");
  return `${url.origin}${path}/v1`;
}

function validateApiPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw new TypeError("Plyry request paths must be relative to the configured API origin.");
  }
  return path;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function responseFilename(disposition: string | null): string | null {
  if (!disposition) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (utf8) {
    try { return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, "")); }
    catch { return utf8[1].trim().replace(/^"|"$/g, ""); }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain?.[1]?.trim() ?? null;
}

function requireUuidV4(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError("A UUID v4 Idempotency-Key is required.");
  }
}

function normalizeScopes(values: readonly Scope[], allowEmpty = false): Scope[] {
  const supported: readonly string[] = [
    "account:read",
    "generation:create",
    "generation:read",
    "wallet:read",
    "wallet:topup",
    "conversion:create",
    "conversion:read",
  ];
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)
    || values.some((scope) => typeof scope !== "string" || !supported.includes(scope))
    || new Set(values).size !== values.length) {
    throw new TypeError("Choose one or more unique supported Plyry API scopes.");
  }
  return [...values];
}

function isInvalidRefresh(error: unknown): boolean {
  return error instanceof PlyryApiError
    && (error.status === 401 || ["invalid_refresh_token", "refresh_token_expired", "refresh_token_revoked"].includes(error.code));
}

interface TokenResponse {
  ok: true;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scopes?: Scope[];
  created?: boolean;
  user?: LinkedAppSession["user"];
  linked_app?: LinkedAppSession["linked_app"];
}
