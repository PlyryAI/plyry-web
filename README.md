# Plyry Web API client

`@plyry/web` is a framework-neutral TypeScript client for the Plyry Public API v1. It uses `fetch`, runs in modern browsers and Node.js, and does not load, embed, or redirect to Plyry's website UI.

The package ships no styled UI. It includes a headless session controller that publishes state changes to any UI you build. Use your own forms, copy, layout, CSS, and navigation.

## Install

~~~sh
npm install @plyry/web
~~~

The source repository is `plyry-web`. The package is not published to npm yet; after release, install it with the command above. For local development, run `npm install` and `npm run build` in this repository, then add it to a consumer with a local `file:` dependency. The package has no runtime dependencies and requires `fetch`, `FormData`, `Blob`, `Headers`, `URL`, and `URLSearchParams` (Node.js 20+ or a modern browser).

## Create a client

~~~ts
import {
  DEFAULT_SCOPES,
  PlyryClient,
  WALLET_SCOPES,
  createIdempotencyKey,
} from "@plyry/web";

const plyry = new PlyryClient({
  appName: "My Creative App",
  // Wallet access is optional. Ask for it only when your app needs it.
  scopes: [...DEFAULT_SCOPES, ...WALLET_SCOPES],
});

const catalog = await plyry.getModels();
~~~

`baseUrl` defaults to `https://plyry.com/v1`. You may pass the site root or a URL ending in `/v1`. HTTP is accepted only for localhost development. Requests use bearer tokens, omit cookies, and let the browser send its `Origin` header automatically.

The default sign-in scopes are `account:read`, `generation:create`, and `generation:read`. Add `wallet:read` and `wallet:topup` for wallet and payment features. Add `conversion:create` and `conversion:read` for the Plant 3D to Revit API, which remains limited to tester and admin accounts during preview.

## Sign in and sign up

~~~ts
import { PlyryApiError } from "@plyry/web";
~~~

Login creates a linked-app session. It is direct API authentication, not OAuth or OpenID Connect. A browser app's origin is bound to the linked session during sign-in, so the app calls Plyry directly from its own website.

~~~ts
try {
  const session = await plyry.signIn({ email, password });
  console.log(`Connected ${session.user.email}`);
} catch (error) {
  if (error instanceof PlyryApiError && error.code === "signup_required") {
    // Render the account creation option in your own UI.
  }
}
~~~

For signup, request and display the short-lived challenge, then submit the answer with the user's credentials:

~~~ts
const challenge = await plyry.createSignupChallenge(email);
// Render challenge.question and collect the answer using your own form.
const session = await plyry.signUp({
  email,
  password,
  signupChallenge: challenge.signup_challenge,
  answer,
});
~~~

`PlyryApiError` exposes `status`, `code`, `message`, and `requiredScope`. Its response body redacts token, password, API-key, secret, authorization, and payment-method fields. Common codes include `signup_required`, `invalid_credentials`, `insufficient_scope`, `rate_limited`, and `origin_not_allowed`.

## Build your own UI

There are no Plyry-owned screens or CSS to override. `PlyrySessionController` is an optional, DOM-free state source for your sign-in form, account panel, or settings page:

~~~ts
import { PlyryClient, createPlyrySessionController } from "@plyry/web";

const client = new PlyryClient({ appName: "My Creative App" });
const session = createPlyrySessionController(client);

const unsubscribe = session.subscribe((state) => {
  // Render any way your app chooses.
  console.log(state.status, state.account, state.error?.message);
});

await session.restore();
// Later, call session.signIn(...), session.createSignupChallenge(...),
// session.signUp(...), and session.signOut() from your own controls.
~~~

The controller exposes `getSnapshot()` and `subscribe()`, so it can connect to React's `useSyncExternalStore`, Vue, Svelte, a plain DOM app, PixiJS, or another UI layer without package-specific adapters. You can also skip the controller and call the client directly.

See [`examples/vanilla/index.html`](examples/vanilla/index.html) for a small plain HTML form using the same API.

## Session storage and API keys

Access and refresh tokens stay in memory by default. The client does not save passwords or tokens automatically. To restore a session across page loads, inject a `RefreshTokenStore` implementation and call `restoreSession()` or the headless controller's `restore()` method. The store saves only the rotating refresh token.

`restoreSession()` returns account details only when the linked session has `account:read`; it still restores the session when an app requested fewer scopes. In that case the headless snapshot is `signed_in` with `account: null`. Read the actual granted permissions from `client.grantedScopes`.

Browser storage is readable by scripts running on your origin. Prefer in-memory tokens for browser apps, protect the site against cross-site scripting, and use a same-origin backend when stronger session isolation is needed. Do not put a secret API key in client-side JavaScript; `apiKey` is provided for server-side callers. User-supplied API keys can be managed from the account API page.

The client refreshes tokens proactively, shares simultaneous refresh calls, retries one authenticated request after a 401, and keeps the stored refresh token after temporary network or server errors. It clears the local token store after Plyry rejects a refresh token. Sign-out clears local state first and then asks Plyry to revoke the linked session.

## API features

The client wraps the current v1 endpoints for:

- Sign-in, signup challenges, signup, token refresh, and linked-app revocation.
- Account, model catalog, wallet, wallet ledger, and payment configuration.
- Generation quotes, prompt and reference uploads, job listing and status, media downloads, and cache acknowledgments.
- Wallet top-up creation, idempotent status lookup, and payment reconciliation.
- The Plant 3D to Revit conversion price, job, button search, mapping revision, and download routes.
- `request()` and `requestBlob()` for other current or future API operations.

Generation requests support JSON for text-only prompts and multipart form data for up to seven references. The helper sets reference slots and counts and leaves the multipart boundary to `fetch`.

Generation media downloads return the bytes, MIME type, filename, SHA-256, and cache token when Plyry provides them. After storing a verified media file, acknowledge it with those response values:

~~~ts
const download = await plyry.downloadGenerationMedia(hash);
await saveFile(download.blob);
if (download.cacheToken && download.sha256) {
  await plyry.acknowledgeCachedGeneration(hash, {
    cache_token: download.cacheToken,
    sha256: download.sha256,
  });
}
~~~

Wallet and conversion submissions that require an `Idempotency-Key` require a UUID v4. Use a fresh key for each intended transaction and reuse the same key only when retrying that transaction. `createIdempotencyKey()` creates a cryptographically random UUID v4. For top-ups with an uncertain result, call `getWalletTopupStatus()` before creating another one.

For card payments, tokenize card details directly with the configured payment processor and pass the resulting `payment_method_id` to `createWalletTopup()`. This package does not accept or send card numbers or security codes to Plyry. Use the returned `payment.action_url` for provider verification when `requires_action` is true, then check the same request key until it reaches a terminal status.

`PaymentConfig.return_url` points to a browser navigation page for processor redirects. Navigate to it when needed; it is not a JSON endpoint to fetch.

## CORS and origins

Browser requests are sent directly to the Plyry API. The API permits bearer-token calls from the origin recorded on the linked app or configured for the API key. The browser sets the `Origin` header; do not attempt to override it. A non-browser caller may pass an `origin` in `PlyryClientOptions` when it needs to register a website origin explicitly.

The API contract is published at [`https://plyry.com/docs/api`](https://plyry.com/docs/api) and [`https://plyry.com/v1/openapi.json`](https://plyry.com/v1/openapi.json).

## Development

~~~sh
npm install
npm run build
~~~

Generated ESM and declaration files are written to `dist/` for npm consumers.

## License

MIT
