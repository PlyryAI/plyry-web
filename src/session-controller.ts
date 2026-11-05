import { PlyryClient, type AuthInput, type SignupInput } from "./client.js";
import type { AccountResponse, SignupChallenge } from "./types.js";

export type PlyrySessionStatus =
  | "idle"
  | "restoring"
  | "authenticating"
  | "signing_out"
  | "signed_in"
  | "signed_out"
  | "error";

export interface PlyrySessionSnapshot {
  status: PlyrySessionStatus;
  account: AccountResponse["user"] | null;
  signupChallenge: SignupChallenge | null;
  error: Error | null;
  warning: string;
}

export type PlyrySessionListener = (snapshot: PlyrySessionSnapshot) => void;

/**
 * UI-free session state for React, Vue, Svelte, vanilla DOM, games, or other clients.
 * It renders nothing; your application owns the layout, copy, styles, and input controls.
 */
export class PlyrySessionController {
  private readonly listeners = new Set<PlyrySessionListener>();
  private actionRevision = 0;
  private snapshot: PlyrySessionSnapshot = {
    status: "idle",
    account: null,
    signupChallenge: null,
    error: null,
    warning: "",
  };

  constructor(private readonly client: PlyryClient) {}

  /** Stable getter for subscription based UI adapters such as React useSyncExternalStore. */
  readonly getSnapshot = (): PlyrySessionSnapshot => this.snapshot;

  subscribe(listener: PlyrySessionListener, emitCurrent = true): () => void {
    this.listeners.add(listener);
    if (emitCurrent) listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  async restore(signal?: AbortSignal): Promise<AccountResponse["user"] | null> {
    const revision = ++this.actionRevision;
    this.update({ status: "restoring", error: null });
    try {
      const account = await this.client.restoreSession(signal);
      if (revision === this.actionRevision) {
        this.update({
          status: account || this.client.hasLinkedAppSession ? "signed_in" : "signed_out",
          account,
          signupChallenge: null,
          error: null,
        });
      }
      return account;
    } catch (error) {
      if (revision === this.actionRevision) {
        this.update({ status: "error", error: toError(error), account: null });
      }
      throw error;
    }
  }

  async createSignupChallenge(email: string, signal?: AbortSignal): Promise<SignupChallenge> {
    const revision = ++this.actionRevision;
    this.update({ status: "authenticating", error: null, account: null, signupChallenge: null });
    try {
      const challenge = await this.client.createSignupChallenge(email, signal);
      if (revision === this.actionRevision) {
        this.update({ status: "signed_out", signupChallenge: challenge, error: null });
      }
      return challenge;
    } catch (error) {
      if (revision === this.actionRevision) this.update({ status: "error", error: toError(error) });
      throw error;
    }
  }

  async signIn(input: AuthInput): Promise<AccountResponse["user"]> {
    const revision = ++this.actionRevision;
    this.update({ status: "authenticating", error: null, account: null, signupChallenge: null });
    try {
      const session = await this.client.signIn(input);
      if (revision === this.actionRevision) {
        this.update({ status: "signed_in", account: session.user, error: null });
      }
      return session.user;
    } catch (error) {
      if (revision === this.actionRevision) this.update({ status: "error", account: null, error: toError(error) });
      throw error;
    }
  }

  async signUp(input: SignupInput): Promise<AccountResponse["user"]> {
    const revision = ++this.actionRevision;
    this.update({ status: "authenticating", error: null, account: null });
    try {
      const session = await this.client.signUp(input);
      if (revision === this.actionRevision) {
        this.update({ status: "signed_in", account: session.user, signupChallenge: null, error: null });
      }
      return session.user;
    } catch (error) {
      if (revision === this.actionRevision) this.update({ status: "error", account: null, error: toError(error) });
      throw error;
    }
  }

  async signOut(signal?: AbortSignal): Promise<void> {
    const revision = ++this.actionRevision;
    this.update({ status: "signing_out", error: null });
    try {
      await this.client.signOut(signal);
      if (revision === this.actionRevision) {
        this.update({ status: "signed_out", account: null, signupChallenge: null, error: null });
      }
    } catch (error) {
      // PlyryClient clears local tokens before attempting remote revocation.
      if (revision === this.actionRevision) {
        this.update({ status: "signed_out", account: null, signupChallenge: null, error: toError(error) });
      }
      throw error;
    }
  }

  private update(patch: Partial<PlyrySessionSnapshot>): void {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ...patch,
      warning: this.client.tokenStorageWarning,
    });
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

export function createPlyrySessionController(client: PlyryClient): PlyrySessionController {
  return new PlyrySessionController(client);
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : "Plyry could not complete the request.");
}
