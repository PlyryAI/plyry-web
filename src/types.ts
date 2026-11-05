export type Scope =
  | "account:read"
  | "generation:create"
  | "generation:read"
  | "wallet:read"
  | "wallet:topup"
  | "conversion:create"
  | "conversion:read";

export const DEFAULT_SCOPES: readonly Scope[] = [
  "account:read",
  "generation:create",
  "generation:read",
];

export const WALLET_SCOPES: readonly Scope[] = ["wallet:read", "wallet:topup"];

export interface ApiEnvelope {
  ok: boolean;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

export interface ApiErrorBody extends ApiEnvelope {
  ok: false;
  error: string;
  message: string;
  required_scope?: Scope;
}

export interface UserSummary {
  id: number;
  email: string;
  created_at?: string;
}

export interface LinkedApp {
  id: number;
  name: string;
  origin: string | null;
}

export interface LinkedAppSession {
  created: boolean;
  user: UserSummary;
  linked_app: LinkedApp;
  scopes: Scope[];
}

export interface SignupChallenge {
  ok: true;
  signup_challenge: string;
  question: string;
  expires_in: number;
}

export interface AccountResponse extends ApiEnvelope {
  user: UserSummary;
}

export interface ModelCatalog extends ApiEnvelope {
  api_version?: number;
  media_types?: string[];
  minimum_funds_cents?: number;
  maximum_funds_cents?: number;
  models?: ModelCatalogMediaType[];
}

export interface ModelCatalogMediaType {
  type: string;
  default_model: string;
  options: ModelCatalogOption[];
}

/** Dynamic model settings remain open-ended as providers add supported options. */
export interface ModelCatalogOption {
  id: string;
  label: string;
  id_label?: string;
  pricing?: Record<string, unknown>;
  generation_options?: Record<string, unknown>;
  references?: ModelCatalogReference[];
  [key: string]: unknown;
}

export interface ModelCatalogReference {
  mode: string;
  model: string;
  id_label?: string;
  pricing?: Record<string, unknown>;
  generation_options?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface QuoteInput {
  type: string;
  model: string;
  quality?: "full" | "test";
  reference_mode?: string;
  queue_options?: Record<string, unknown>;
  splat_quality?: string;
  [key: string]: unknown;
}

export interface QuoteResponse extends ApiEnvelope {
  price_cents: number;
  has_sufficient_funds: boolean;
  wallet_cents?: number;
}

export interface GenerationReference {
  file: Blob;
  slot?: number;
  filename?: string;
}

export interface GenerationInput {
  type: string;
  prompt: string;
  model?: string;
  quality?: "full" | "test";
  reference_mode?: string;
  queue_options?: Record<string, unknown>;
  splat_quality?: string;
  references?: GenerationReference[];
  reference_text_only?: boolean;
}

export interface GenerationJob {
  hash: string;
  prompt?: string;
  prompt_locale?: string;
  auto_translate_prompt?: boolean;
  type?: string;
  model?: string;
  helper_kind?: string | null;
  reference_count?: number;
  reference_mode?: string | null;
  reference_model?: string | null;
  queue_options?: Record<string, unknown>;
  status: string;
  price_cents?: number;
  mime?: string | null;
  error?: string | null;
  media_available?: boolean;
  cached?: boolean;
  delivered?: boolean;
  purged?: boolean;
  deleted?: boolean;
  media_url?: string;
  scene_url?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface GenerationResponse extends ApiEnvelope {
  job: GenerationJob;
}

export interface Pagination {
  page: number;
  per_page: number;
  total: number;
  pages: number;
  has_previous: boolean;
  has_next: boolean;
}

export interface GenerationListResponse extends ApiEnvelope {
  generations: GenerationJob[];
  pagination: Pagination;
}

export interface GenerationListOptions {
  page?: number;
  per_page?: number;
  status?: "queued" | "processing" | "completed" | "failed" | "aborted";
  type?: string;
}

export interface WalletResponse extends ApiEnvelope {
  wallet_cents: number;
  currency: "USD";
  minimum_topup_cents: number;
  maximum_topup_cents: number;
}

export interface WalletLedgerEntry {
  id: number;
  amount_cents: number;
  reason: string;
  created_at: string;
}

export interface WalletLedgerResponse extends ApiEnvelope {
  ledger: WalletLedgerEntry[];
  pagination: Pagination;
}

export interface PaymentConfig extends ApiEnvelope {
  driver: string;
  return_url: string;
  onvo?: {
    api_base: string;
    publishable_key: string;
  };
}

export interface WalletTopupInput {
  amount_cents: number;
  billing_country: string;
  payment_method_id?: string;
  return_url?: string;
}

export interface TopupPayment {
  id?: number;
  reference?: string;
  amount_cents?: number;
  status?: string;
  requires_action?: boolean;
  action_url?: string;
  [key: string]: unknown;
}

export interface TopupResponse extends ApiEnvelope {
  request_key?: string;
  request_status?: "processing" | "complete" | "failed" | "unknown";
  message?: string;
  payment?: TopupPayment | null;
}

export interface BinaryDownload {
  blob: Blob;
  contentType: string;
  sha256: string | null;
  cacheToken: string | null;
  filename: string | null;
  status: number;
}

export interface ConversionPriceResponse extends ApiEnvelope {
  price_cents: number;
  currency: "USD";
}

export interface ConversionCreateInput {
  pcf: Blob;
  pcf_filename?: string;
  catalog: Blob;
  catalog_filename?: string;
}

export interface ConversionJob {
  hash: string;
  status: string;
  state?: "queued" | "processing" | "review" | "complete" | "failed";
  revision?: number;
  price_cents?: number;
  error?: string | null;
  pcf_name?: string;
  catalog_name?: string;
  report?: Record<string, unknown> | null;
  mapping_package?: MappingPackage | null;
  updated_at?: string;
}

export interface ConversionResponse extends ApiEnvelope {
  job: ConversionJob;
  reused?: boolean;
}

export interface FabricationButton {
  target_key: string;
  name: string;
  code?: string;
  service_name?: string;
  palette_name?: string;
}

export interface FabricationButtonsResponse extends ApiEnvelope {
  buttons: FabricationButton[];
}

export interface ConversionMappingInput {
  mappings: Record<string, string>;
}

export interface ConversionRevisionResponse extends ApiEnvelope {
  job: Pick<ConversionJob, "hash" | "status" | "revision">;
}

export interface MappingPackage {
  schema_version: 1;
  source?: Record<string, unknown>;
  target?: Record<string, unknown>;
  revision?: number;
  components: Array<Record<string, unknown>>;
  report?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RefreshTokenStore {
  loadRefreshToken(): string | null | Promise<string | null>;
  saveRefreshToken(refreshToken: string): void | Promise<void>;
  clearRefreshToken(): void | Promise<void>;
}
