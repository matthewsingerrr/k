# Link API v1 — integration guide

The Link API lets outside clients (the **Arkham Dev Tags** browser extension, other bots, scripts) talk to this Discord bot:

- **scan** any website (tech stack, hosting, build id, subdomains, API endpoints, socials),
- **add / list / remove** sites on a Discord server's watch list,
- **trigger a check** of a watched site,
- **manage** a watched site like the Discord dashboard does: its card, pause / resume, settings (name, interval, full sweep, alert channel, ping role), checks on/off, rules (ignored text, skipped URLs, extra pages, scope, max pages), pages, subdomains and history, plus the server's site list,
- **poll the alert feed** to mirror alerts elsewhere.

Every client acts on **one Discord server** (guild) and **one alert channel**. Both are fixed by the token it uses. Tokens are issued in Discord with `/link create`.

> This document describes the contract in `src/link/api.ts` (endpoint JSDoc) and `src/link/types.ts` (schemas). If the two ever disagree, the source wins; please file a fix for this document.

---

## 1. Base URL

```
https://<the bot's public domain>/api/v1
```

- The API is served by the bot's own HTTP server (the same one that answers `/health`, on `PORT`).
- On Railway the service needs a public domain: **service → Settings → Networking → Generate Domain**, then redeploy. The bot reads it from `RAILWAY_PUBLIC_DOMAIN`, or from `PUBLIC_URL` if that is set (custom domain, proxy).
- `/link create` and `/link list` show the exact base URL, for example `https://site-watcher-production.up.railway.app/api/v1`.
- If the operator sets `LINK_API=false`, the API is off: every `/api/v1` path answers `404 not_found` (JSON, with a message saying the Link API is turned off).
- Always use **https**. Railway domains are HTTPS-only.

All paths below are relative to the base URL.

## 2. Authentication

Send the token on every request (except `OPTIONS`):

```
Authorization: Bearer swb_3fJ8…
```

`X-Link-Token: swb_3fJ8…` is accepted as an alternative header.

| | |
|---|---|
| Format | `swb_` followed by 43 URL-safe base64 characters |
| Issued by | `/link create label:<name> [channel:#alerts]` in Discord (Manage Server permission). It is shown **once**, in a private (ephemeral) reply. |
| Scope | One Discord server and one alert channel. Sites added through the token post their alerts in that channel. |
| Storage on the bot | Only the token's SHA-256 is stored, so a lost token cannot be recovered. Revoke it and create a new one. |
| Limits | Up to 10 tokens per server. Labels are unique per server. |
| Revocation | `/link revoke label:<name>`. Takes effect immediately; the next request gets `401`. |
| Last used | Recorded at most once a minute per token. `/link list` shows it. |

**Rights.** A token is created by a member with **Manage Server**, so it has the same rights as the dashboard's buttons, **for its own server only**:

- It can read and change any watch of its server: settings, rules, checks and the alert channel, including watches added in Discord and watches posting to other channels.
- A watch id from another server is `404 not_found`, exactly like an unknown id.
- A channel or role from another server is `400 invalid_channel` / `400 invalid_role`.

A missing, malformed or unknown/revoked token gets **`401 unauthorized`**. So does a token whose Discord server has removed the bot (re-add the bot and `/link create` a new token).

Treat a token like a password. Anyone holding it can add, change and remove sites on that server and read its alert feed. Never commit it, bundle it in an extension zip, put it in a URL, or log it.

## 3. CORS

Every `/api/v1` response, errors included, carries:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Authorization, Content-Type, X-Link-Token
Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS
Access-Control-Max-Age: 600
Access-Control-Expose-Headers: Retry-After
```

`OPTIONS` (preflight) on any `/api/v1` path returns **`204`** with no authentication required. A preflight that sends `Access-Control-Request-Private-Network: true` also gets `Access-Control-Allow-Private-Network: true`; this only matters for a self-hosted bot on a LAN. Auth uses a header, not a cookie, so the wildcard origin is safe: a page cannot call the API unless it already has the token. No `Access-Control-Allow-Credentials` is sent.

## 4. Requests, responses, errors

- Request bodies (`POST`, `PATCH`) are JSON objects: send `Content-Type: application/json`. The maximum body size is **32 KB**, and the body must arrive within **15 s**. Compressed bodies (`Content-Encoding`) get `400 bad_request`. An empty `PATCH` body, or `{}`, changes nothing.
- A trailing slash on a path is ignored (`/watches/` is `/watches`).
- Every response body is JSON (`content-type: application/json; charset=utf-8`).
- Timestamps named `…At` with numeric values are **Unix epoch milliseconds**. `scannedAt` is an ISO-8601 string.
- Errors always have this shape, with a fitting HTTP status:

```json
{ "error": { "code": "rate_limited", "message": "Too many requests — try again in 42s." } }
```

Validation errors of the management routes may also carry `field`, a JSON path into the request body of the value that failed (clients may ignore it):

```json
{ "error": { "code": "invalid_pattern", "message": "Skip-URL pattern (a+)+: That pattern has nested repetition like (a+)+, which can freeze the bot on some pages. Please simplify it.", "field": "excludePatterns[0]" } }
```

`message` is human-readable plain text and may change. Branch on `code`:

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | Body is not valid JSON or not a JSON object, or a field has the wrong type (for example `features.text: "yes"` or an unknown `subdomains` mode) |
| 400 | `invalid_url` | `url` is not a usable website URL, or it points at a private / internal address (`localhost`, `127.0.0.1`, `10.x`, `192.168.x`, `169.254.x`, `*.internal`, `*.local`, …) |
| 400 | `invalid_interval` | `intervalSec` / `sweepSec` is not a usable number of seconds (in-range numbers are used, out-of-range ones are clamped) |
| 400 | `invalid_pattern` | An ignore or skip-URL pattern was refused (bad regex, nested repetition like `(a+)+`, too slow, too broad, over 300 characters), or a list has more than 25 entries |
| 400 | `invalid_channel` | `channelId` is not a text or announcement channel of the token's server |
| 400 | `invalid_role` | `pingRoleId` is not a role of the token's server |
| 401 | `unauthorized` | Token missing, unknown or revoked, or the bot is no longer in the token's server |
| 404 | `not_found` | Unknown route, or a watch id that doesn't exist **in this token's server** |
| 405 | `method_not_allowed` | Known route, wrong HTTP method (the response has an `Allow` header) |
| 408 | `timeout` | The request body didn't arrive within 15 s |
| 409 | `limit_reached` | The server already watches its maximum number of sites (`MAX_WATCHES_PER_GUILD`, default 50) |
| 409 | `name_taken` | Another site in the server already has that name (case-insensitive) |
| 413 | `too_large` | Request body over 32 KB |
| 429 | `rate_limited` | A rate limit was hit (see §5). Always has a `Retry-After` header. |
| 500 | `internal_error` | Unexpected error on the bot. The message is generic; details stay in the bot's logs. |
| 502 | `scan_failed` | The scan itself could not run (not "the site is down"; see `POST /scan`) |
| 503 | `unavailable` | The bot is still starting up (`Retry-After: 5`): every route that writes or checks needs its monitor, and channel / role changes and `GET /guild` need Discord's server cache (Discord not ready). Right after a redeploy it may also still be restoring link tokens from its Discord backup, so an unknown token gets `503` + `Retry-After: 15` instead of `401` for up to a few minutes. Retry; don't treat it as a revoked token. |
| 504 | `timeout` | `POST /watches/:id/check` took longer than 60 s |

Treat any other 400 as "fix the request". Treat any other 5xx (for example during a redeploy) as a temporary failure and retry later. Treat an unknown `code` as a generic error.

## 5. Rate limits

Limits are per token, enforced as in-memory token buckets:

| Bucket | Limit |
|---|---|
| All requests | 120 per minute |
| `POST /scan` | 20 per 10 minutes |
| `POST /watches` and `POST /watches/:id/subdomains/watch` (one shared bucket) | 30 per hour |
| Management writes: `PATCH /watches/:id`, `POST /watches/:id/pause` and `/resume`, `PATCH /watches/:id/rules`, `PATCH /watches/:id/subdomains` | 60 per 10 minutes |

Every request also counts against "All requests".

The bot also caps how many scans run at once across all tokens (3), because scans share its outbound HTTP budget with the monitoring. When that cap is hit, `POST /scan` returns `429 rate_limited` with `Retry-After: 5`.

`POST /watches/:id/check` has its own **per-site** cooldown: a new check of the same site within 30 s gets `429 rate_limited` with `Retry-After`. It concerns that one site only; back off that site's **Check now**, not the whole client.

When a limit is exceeded the API returns `429 rate_limited` with `Retry-After: <seconds>`. The header is exposed to browser callers. Wait at least that long before calling that endpoint again. The buckets live in memory, so they reset when the bot restarts. Don't rely on that.

---

## 6. Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/ping` | Check the token and connection; returns which server and channel it's bound to |
| POST | `/scan` | One-off scan of any site (nothing is stored) |
| GET | `/watches` | The server's watched sites (optionally only those matching `?url=`) |
| POST | `/watches` | Add a site to the server's watch list |
| GET | `/watches/:id` | One watch, its site card and its 20 newest alerts |
| PATCH | `/watches/:id` | Change settings, checks and pause state (⚙️ Settings, 🧩 Features, ⏸️ Pause) |
| DELETE | `/watches/:id` | Stop watching a site |
| POST | `/watches/:id/check` | Check a watched site now |
| POST | `/watches/:id/pause`, `/watches/:id/resume` | Pause / resume (explicit state) |
| GET, PATCH | `/watches/:id/rules` | Ignored text, skipped URLs, extra pages, scope, max pages (🚫 Rules) |
| GET | `/watches/:id/pages` | Tracked pages, known pages and files (📄 Pages) |
| GET, PATCH | `/watches/:id/subdomains` | Known subdomains; subdomain detection on/off (🛰️ Subdomains) |
| POST | `/watches/:id/subdomains/watch` | Watch a subdomain as its own site |
| GET | `/watches/:id/history` | Alert history of a site, paged (🕘 History) |
| GET | `/guild` | The server's alert channels and roles, for pickers |
| GET | `/events` | Alert feed for the server, for polling |

### GET /ping

Use this for a "Test connection" button.

```http
GET /api/v1/ping
Authorization: Bearer swb_…
```

`200`

```json
{
  "ok": true,
  "bot": "site-watcher",
  "version": "2.0.0",
  "apiVersion": 1,
  "guild": { "id": "1187654321098765432" },
  "channelId": "1290000000000000001",
  "label": "Matt's Chrome",
  "watches": 7,
  "limits": { "minIntervalSec": 1, "maxIntervalSec": 3600, "sweepMinSec": 30, "sweepMaxSec": 86400, "maxPagesLimit": 1000,
              "maxPatterns": 25, "maxPatternChars": 300, "maxExtraUrls": 50, "maxScopeChars": 200, "maxNameChars": 100, "maxWatches": 50 }
}
```

- `version` is the bot's build version. It is informational; don't parse it.
- `apiVersion` is `1` for everything under `/api/v1`.
- `guild.id` and `channelId` are Discord snowflakes (strings). Names are not exposed.
- `label` is the label given at `/link create`.
- `watches` is the number of sites the server watches.
- `limits` (`ApiLimits`) are the validation limits of the management routes, so a client can check input before sending it: interval range (`minIntervalSec` is the bot's `MIN_INTERVAL_SEC`), full-sweep range, max pages, patterns per list and their length, extra pages, scope length, name length, and sites per server (`maxWatches`, 0 = unlimited).

### POST /scan

Scans a site once and returns what it is built with. **Nothing is stored and nothing is posted to Discord.**

Request:

```json
{ "url": "unpeg.io", "subdomains": "quick" }
```

| Field | Type | Notes |
|---|---|---|
| `url` | string, required | A domain or full URL: `unpeg.io`, `https://unpeg.io/docs`. Must be a public http(s) site: private / internal hosts get `400 invalid_url`. |
| `subdomains` | `"none"` \| `"quick"` \| `"full"` | Optional, default `"quick"`. `quick` does a DNS check of about 40 common names plus hostnames seen in the site's code. `full` also queries Certificate Transparency (Cert Spotter); this is slower but finds more names. Cert Spotter's quota is shared with the 24/7 monitor, so all scans together make at most 3 fresh Cert Spotter calls per hour and reuse a domain's names for an hour. When that budget is used up, `full` quietly behaves like `quick`. `none` skips subdomains. |

What the scan does:
1. Fetches the homepage.
2. Fingerprints the build.
3. Reads up to 25 of the site's own JS bundles (at most 3 MB each, 12 MB in total) for API routes, hostnames and library signatures.
4. Collects social links, resolves subdomains and detects technologies.
5. Reports whether this server already watches the site.

The scan has a time budget of about **25 s**. Results that aren't ready by then are left out (partial result). Results are **cached for 60 s** per (url, subdomains mode), so a repeated scan within a minute returns the same `scannedAt`. The bot answers `502 scan_failed` if a scan is still running after 50 s, so use a client timeout of about **60 s**.

Private networks are never scanned:
- A URL whose host is internal (`localhost`, `*.localhost`, `*.local`, `*.internal`) or a private / loopback / link-local IP gets `400 invalid_url` before anything is fetched or resolved.
- A public name that resolves to a private address is not fetched either. You get `200` with `status: 0` and `error` saying so.

Page-provided strings are capped: `title` at 300 characters, `description` at 500, and each social URL at 300. `ogImage` and social URLs are always absolute `http(s)` URLs, or left out. Lists are capped too: `apiEndpoints` 200, `codeHosts` 300, `subdomains` 200, `socials` 40 (at most 3 per kind).

`200` returns a `ScanResult` (the values below are illustrative):

```json
{
  "url": "https://unpeg.io/",
  "finalUrl": "https://unpeg.io/",
  "host": "unpeg.io",
  "rootDomain": "unpeg.io",
  "status": 200,
  "blocked": false,
  "error": null,
  "title": "Unpeg — Launch, trade and track",
  "description": "Fair launches on Solana.",
  "ogImage": "https://unpeg.io/og.png",
  "tech": [
    { "name": "Vercel", "category": "hosting", "version": null, "evidence": "x-vercel-id header" },
    { "name": "Next.js", "category": "framework", "version": "14.2.5", "evidence": "__NEXT_DATA__ / _next/static" },
    { "name": "React", "category": "framework", "version": "18.3.1", "evidence": "bundle banner" },
    { "name": "Tailwind CSS", "category": "ui", "version": null, "evidence": "utility classes" },
    { "name": "Privy", "category": "auth", "version": null, "evidence": "script auth.privy.io" },
    { "name": "Solana web3.js", "category": "web3", "version": null, "evidence": "bundle contents" },
    { "name": "PostHog", "category": "analytics", "version": null, "evidence": "us.i.posthog.com" }
  ],
  "build": { "id": "KU79xF2pQe8vZ1", "assets": 23, "generator": null },
  "server": { "server": "Vercel", "poweredBy": "Next.js", "ips": ["76.76.21.21"] },
  "apiEndpoints": ["/api/launches/count", "/api/pools", "/api/token/[mint]"],
  "codeHosts": ["api.unpeg.io", "auth.privy.io", "mainnet.helius-rpc.com"],
  "subdomains": [
    { "host": "app.unpeg.io", "sources": ["dns", "code"], "alive": true },
    { "host": "docs.unpeg.io", "sources": ["link"], "alive": true },
    { "host": "staging.unpeg.io", "sources": ["dns"], "alive": false }
  ],
  "socials": [
    { "kind": "x", "url": "https://x.com/unpeg_io" },
    { "kind": "telegram", "url": "https://t.me/unpeg" },
    { "kind": "docs", "url": "https://docs.unpeg.io/" }
  ],
  "links": { "internal": 18, "external": 7 },
  "watched": { "id": 7, "name": "Unpeg", "url": "https://unpeg.io/" },
  "scannedAt": "2026-10-05T14:03:11.402Z",
  "elapsedMs": 3810
}
```

A site that is **down or blocks the bot is not an API error**. You still get `200` with `status: 0` (unreachable) or `blocked: true`, `error` explaining what happened, and whatever could still be learned (headers, DNS/CT subdomains). Errors:
- `400 invalid_url`: the URL is malformed, or its host is private / internal.
- `400 bad_request`: `subdomains` is not `"none"`, `"quick"` or `"full"`.
- `429 rate_limited`: 20 scans per 10 minutes per token, or 3 scans already running on the bot (`Retry-After: 5`).
- `502 scan_failed`: the scan could not run at all, or was still running after 50 s.

#### ScanResult schema

| Field | Type | Meaning |
|---|---|---|
| `url` | string | The requested URL, normalized |
| `finalUrl` | string | URL after redirects |
| `host` / `rootDomain` | string | `app.unpeg.io` / `unpeg.io` |
| `status` | number | HTTP status of the homepage; `0` = unreachable |
| `blocked` | boolean | The site showed the bot a bot-protection challenge; the results are partial |
| `error` | string \| null | What went wrong, if anything |
| `title`, `description`, `ogImage` | string \| null | From the homepage `<head>` |
| `tech` | TechHit[] | Detected technologies (below). Deduplicated by name and ordered by category, then name. |
| `build` | `{ id, assets, generator }` | Framework build id (or null), number of hashed JS/CSS bundles, `<meta name="generator">` |
| `server` | `{ server, poweredBy, ips }` | `Server` and `X-Powered-By` headers, and the resolved IPs |
| `apiEndpoints` | string[] | Route-like API paths referenced in the site's own JS (`/api/launches/count`) |
| `codeHosts` | string[] | Hostnames referenced in the site's code (APIs, RPCs, third-party services) |
| `subdomains` | `{ host, sources, alive }[]` | `sources` ⊂ `"dns"`, `"ct"`, `"code"`, `"link"`; `alive` = it resolves |
| `socials` | `{ kind, url }[]` | Kinds include `x`, `telegram`, `discord`, `github`, `docs`, `medium`, and more |
| `links` | `{ internal, external }` | Link counts on the homepage |
| `watched` | `{ id, name, url }` \| null | This server already watches the site |
| `scannedAt` | string | ISO-8601 time of the scan |
| `elapsedMs` | number | Scan duration |

`TechHit`:

```ts
{
  name: string;            // "Next.js", "Vercel", "Privy", "Solana web3.js"
  category: TechCategory;  // see below
  version: string | null;  // when detectable
  evidence: string;        // short reason, e.g. "x-vercel-id header", "script cdn.privy.io"
}
```

`TechCategory` is one of `framework`, `hosting`, `cdn`, `cms`, `docs`, `ui`, `analytics`, `monitoring`, `auth`, `payments`, `support`, `web3`, `fonts`, `security`, `other`. New categories may be added in v1: show unknown ones under "Other".

### GET /watches

Returns the server's watched sites.

```http
GET /api/v1/watches
GET /api/v1/watches?url=https%3A%2F%2Fhookedpad.com%2Fapp
```

`200`, without `?url=`:

```json
{
  "watches": [ { "id": 7, "name": "Unpeg", "...": "ApiWatch fields" } ],
  "summary": {
    "total": 13, "limit": 50,
    "counts": { "up": 9, "down": 0, "blocked": 1, "paused": 1, "scanning": 2 },
    "channels": [ { "id": "1290000000000000001", "name": "scans", "watches": 13 } ],
    "text": "Watching 13 sites · alerts in #scans · 9 up · 1 blocked · 1 paused · 2 scanning"
  }
}
```

`summary` (`ApiServerSummary`) is the dashboard's head line, computed over **all** of the server's watches (also when `?url=` filters `watches`):

| Field | Meaning |
|---|---|
| `total`, `limit` | Sites watched, and the server's limit (0 = unlimited) |
| `counts` | Per status, with the dashboard's precedence: paused > scanning (first scan pending) > down > blocked > up |
| `channels` | Alert channels in use, most watches first; `name` is null when Discord's cache doesn't know it |
| `text` | Plain text: `alerts in #name` when every watch uses one channel (the raw id when its name is unknown), else `alerts in N channels`; zero counts are left out; `"No sites yet."` with no watches |

`200`, with `?url=<u>`: returns only watches whose normalized URL **or host** matches `u`, plus `watched`:

```json
{
  "watches": [
    {
      "id": 12,
      "name": "Hookedpad",
      "url": "https://hookedpad.com/",
      "host": "hookedpad.com",
      "channelId": "1290000000000000001",
      "intervalSec": 2,
      "paused": false,
      "status": "up",
      "features": { "deploy": true, "text": true, "pages": true, "subdomains": true, "files": true, "status": true, "codeIntel": true },
      "createdAt": 1759673000000,
      "lastCheckAt": 1759676541000,
      "lastChangeAt": 1759675012000,
      "pagesTracked": 34,
      "subdomains": 6
    }
  ],
  "watched": true,
  "summary": { "total": 13, "...": "ApiServerSummary" }
}
```

This is how a client shows "✅ Tracked" for the current site: call with `?url=<tab URL>` and use `watched`. Matching is by host, ignoring a leading `www.`, so `https://hookedpad.com/app` matches the `hookedpad.com` watch. URL-encode the `url` parameter. A `url` that isn't a website URL gets `400 invalid_url`.

#### ApiWatch schema

| Field | Type | Meaning |
|---|---|---|
| `id` | number | Watch id (use it in `/watches/:id`) |
| `name` | string | Display name |
| `url`, `host` | string | Watched URL and its host |
| `channelId` | string | Discord channel the alerts go to |
| `intervalSec` | number | Seconds between homepage checks |
| `paused` | boolean | |
| `status` | string | `"up"`, `"down"`, `"blocked"` (bot protection), `"paused"` or `"scanning"` (first scan still running) |
| `features` | Record<string, boolean> | Alert types switched on: `deploy`, `text`, `pages`, `subdomains`, `files`, `status`, `codeIntel` (more keys may appear) |
| `createdAt` | number | ms |
| `lastCheckAt`, `lastChangeAt` | number \| null | ms |
| `pagesTracked` | number | Pages whose text is tracked |
| `subdomains` | number | Known subdomains |

### POST /watches

Adds a site to the token's server. Its alerts go to the token's channel.

```json
{
  "url": "https://hookedpad.com",
  "name": "Hookedpad",
  "intervalSec": 5,
  "features": { "subdomains": true, "files": false }
}
```

| Field | Type | Notes |
|---|---|---|
| `url` | string, required | Domain or URL, as for `/watch add`. Private / internal hosts get `400 invalid_url`. |
| `name` | string | Optional. The default comes from the domain (as for `/watch add`). The default, or a name you send that is already taken, is made unique within the server ("Hookedpad 2"). Leaving `name` out, or sending `""` or `null`, uses the default. A name that is only whitespace or only a number, or one over 100 characters, gets `400 bad_request`. |
| `intervalSec` | number | Optional. Defaults to the bot's default (2 s). Numbers are rounded and clamped to `[MIN_INTERVAL_SEC, 3600]`; a value that isn't a positive number gets `400 invalid_interval`. |
| `features` | object | Optional switches: `deploy`, `text`, `pages`, `subdomains`, `files`, `status`, `codeIntel`. Any switch you leave out keeps its default. A value that isn't `true`/`false` gets `400 bad_request`. |
| `channelId` | string | Optional alert channel: a text or announcement channel of the token's server (see `GET /guild`). Default: the token's channel. Another channel gets `400 invalid_channel`; `503 unavailable` while Discord isn't ready. |
| `pingRoleId` | string \| null | Optional role to ping on alerts: a role of the token's server; the server id itself means @everyone. Default: no ping. Another server's role gets `400 invalid_role`. |

Responses:
- **`201`**: the site was added:
  ```json
  { "created": true, "watch": { "id": 12, "name": "Hookedpad", "url": "https://hookedpad.com/", "status": "scanning", "...": "ApiWatch fields" } }
  ```
  The site's silent first scan runs in the background, so `status` is `"scanning"` until it finishes. The response does not wait for it. Discord gets two posts:
  - immediately: "➕ **Hookedpad** (https://hookedpad.com/) was added from **Matt's Chrome** — first scan running…"
  - when the scan finishes: "✅ Now watching **Hookedpad** …"

  No change alerts are sent for the first scan.
- **`200`**: the server already watched that URL. Nothing changed:
  ```json
  { "created": false, "watch": { "id": 12, "...": "ApiWatch fields" } }
  ```
  The existing watch keeps its own name, channel and settings (`channelId` and `pingRoleId` are ignored, but still validated).
- Errors:
  - `400 invalid_url` / `invalid_interval` / `bad_request` / `invalid_channel` / `invalid_role`
  - `409 limit_reached`: the server's site limit
  - `429 rate_limited`: 30 adds per hour per token
  - `503 unavailable`: the bot is still starting

Always display `watch.name` from the response, because the name actually used can differ from the one you sent.

### GET /watches/:id

```http
GET /api/v1/watches/12
```

`200`:

```json
{
  "watch": { "id": 12, "name": "Hookedpad", "...": "ApiWatch fields" },
  "card": {
    "id": 12, "name": "Hookedpad", "url": "https://hookedpad.com/", "host": "hookedpad.com", "rootDomain": "hookedpad.com",
    "status": "up", "statusLabel": "Up", "downSince": null, "downError": null,
    "lastCheckAt": 1759676541000, "lastChangeAt": 1759675012000,
    "schedule": { "intervalSec": 2, "sweepSec": 120 },
    "alerts": { "channelId": "1290000000000000001", "channelName": "scans", "canPost": true, "missing": [],
                "ping": "none", "pingRoleId": null, "pingRoleName": null },
    "build": { "id": null, "bundles": 51, "generator": null },
    "pages": { "tracked": 17, "maxPages": 150, "known": 18, "files": 0, "gone": 0, "dynamic": 1 },
    "subdomains": { "enabled": false, "known": 0, "live": 0 },
    "rules": { "ignorePatterns": 0, "excludePatterns": 0, "extraUrls": 0, "scopePath": null },
    "checks": [
      { "key": "deploy", "label": "Redeploys", "emoji": "🌐", "hint": "new JS/CSS bundles or build id", "on": true },
      { "key": "text", "label": "Text changes", "emoji": "📝", "hint": "visible text on tracked pages, with a diff", "on": true },
      { "key": "pages", "label": "New pages", "emoji": "🆕", "hint": "pages added or removed (links, sitemap, code)", "on": true },
      { "key": "subdomains", "label": "Subdomains", "emoji": "🛰️", "hint": "new subdomains (certificate logs, DNS, code)", "on": false },
      { "key": "files", "label": "Files", "emoji": "📄", "hint": "linked PDFs, docs, markdown…", "on": true },
      { "key": "status", "label": "Uptime", "emoji": "🚦", "hint": "site goes down / comes back up", "on": true },
      { "key": "codeIntel", "label": "Code intel", "emoji": "🔎", "hint": "new routes and hosts in freshly deployed code", "on": true },
      { "key": "maskNumbers", "label": "Ignore numbers", "emoji": "🔢", "hint": "ignore changes that only touch numbers", "on": false }
    ],
    "runtime": { "running": true, "baselineRunning": false, "lastTickAt": 1759676541000, "lastTickMs": 123, "nextTickAt": 1759676543000 },
    "lastError": null,
    "warnings": [],
    "createdAt": 1759673000000
  },
  "events": [
    { "id": 5821, "watchId": 12, "watchName": "Hookedpad", "watchUrl": "https://hookedpad.com/", "kind": "deploy", "summary": "Hookedpad redeployed", "createdAt": 1759675012000 }
  ],
  "limits": { "...": "ApiLimits (see GET /ping)" }
}
```

`events` contains the 20 newest alerts of that watch, **newest first**. A watch that doesn't exist or belongs to another server returns `404 not_found`.

#### ApiCard schema

`card` is the Discord site card as data. Every string in it comes from a website or from Discord: **render it as text**.

| Field | Meaning |
|---|---|
| `status`, `statusLabel` | `status` as in `ApiWatch`; `statusLabel` is the card's wording: `Up`, `Down`, `Paused`, `First scan pending`, `Blocked by the site’s bot protection` |
| `downSince`, `downError` | Only while down and not paused (ms, and the last error), else null |
| `lastCheckAt`, `lastChangeAt` | ms, null = never |
| `schedule` | `intervalSec` (homepage, redeploys, uptime) and `sweepSec` (every tracked page re-checked within this time) |
| `alerts` | `channelId`; `channelName` (null when Discord's cache doesn't know it); `canPost` (null = unknown, Discord not ready); `missing` (`View Channel`, `Send Messages`, `Embed Links`, or `channel not found`); `ping` = `none` \| `role` \| `everyone` with `pingRoleId` (the server id for @everyone) and `pingRoleName` |
| `build` | Build id, number of bundles and generator; null = no fingerprint yet ("unknown") |
| `pages` | Tracked pages (`maxPages` is the limit), known pages, files, tracked pages gone and too dynamic to diff |
| `subdomains` | Detection on/off, known and live subdomains |
| `rules` | Counts of ignore patterns, skipped URL patterns and extra pages, and the crawl scope (null = whole site) |
| `checks` | The 8 switches in the dashboard's order. `maskNumbers` ("Ignore numbers") is a watch setting, not an `ApiWatch.features` key |
| `runtime` | The monitor's view: running, first scan in progress, last check time and duration, next check; null before the monitor has started |
| `lastError` | The last check's error, else null |
| `warnings` | Plain-text lines: delivery problems ("I'm missing Send Messages in #alerts — alerts can't be delivered until that's fixed."), the shared Certificate Transparency quota note |

### DELETE /watches/:id

```http
DELETE /api/v1/watches/12
```

`200`:

```json
{ "deleted": true }
```

The bot stops watching the site and Discord gets "➖ **Hookedpad** was removed from **Matt's Chrome**". An unknown id or one from another server returns `404 not_found`. A token can remove **any** watch of its server, including ones added in Discord.

### POST /watches/:id/check

Checks a watched site right now. Any alerts it finds go to Discord as usual.

```http
POST /api/v1/watches/12/check
```

`200`:

```json
{ "alerts": 2, "kinds": ["deploy", "text"], "error": null }
```

| Field | Meaning |
|---|---|
| `alerts` | Number of alerts the check found and posted |
| `kinds` | Their alert kinds (see `ApiEvent.kind`) |
| `error` | Why the check didn't complete, else `null` |

A check that takes longer than 60 s returns `504 timeout`. The check may still finish and post its alerts. A bad id returns `404 not_found`; `503 unavailable` means the bot is still starting. An empty body is fine; so is `{}`. Optional body field: `full: true` re-checks every tracked page and file, not just the homepage (like `/watch check full:`); a value that isn't `true`/`false` gets `400 bad_request`. Concurrent checks of the same site share one run, whatever their `full`. Starting a new check of the same site within 30 s of the last one returns `429 rate_limited` with `Retry-After` (per site; see §5).

### Managing a watch: common rules

The management routes below do what the dashboard's buttons and forms do, with the same validation (and the same limits, see `limits` in `GET /ping`):

- Every `:id` must be a watch of the token's server; anything else is `404 not_found`.
- A request is validated **completely before anything is written**. A request that fails changes nothing; a request that changes nothing writes nothing (`changed: []`).
- Bodies are strict: an unknown top-level field, or a value of the wrong type, is `400 bad_request` with `field`. Strings are never converted to numbers.
- A change re-baselines only what it affects, silently, at the next scheduled check, so switching a check on or editing rules never causes a burst of alerts. Management routes never start a check themselves.
- Writes need the bot's monitor: `503 unavailable` + `Retry-After: 5` right after a start.
- Every management write answers an **`ApiManageResult`**:

```json
{
  "changed": ["intervalSec", "checks.text"],
  "message": "Saved — interval 2s → 5s · Text changes off",
  "warnings": [],
  "watch": { "id": 12, "...": "ApiWatch" },
  "card": { "id": 12, "...": "ApiCard" }
}
```

| Field | Meaning |
|---|---|
| `changed` | What changed (`name`, `intervalSec`, `sweepSec`, `channelId`, `pingRoleId`, `paused`, `checks.<key>`, `ignorePatterns`, `excludePatterns`, `extraUrls`, `scopePath`, `maxPages`); `[]` = nothing changed and nothing was written |
| `message` | Plain-text summary for a status line |
| `warnings` | Plain-text lines worth showing (the new alert channel can't receive alerts, subdomains announced twice, a skip pattern that also matches the start URL) |
| `watch`, `card` | The watch after the change |

### PATCH /watches/:id

⚙️ Settings, 🧩 Features and ⏸️ Pause in one call. Every field is optional:

```json
{
  "name": "Hookedpad",
  "intervalSec": 5,
  "sweepSec": 300,
  "channelId": "1290000000000000002",
  "pingRoleId": "1280000000000000077",
  "paused": false,
  "checks": { "text": false, "maskNumbers": true }
}
```

| Field | Type | Rules |
|---|---|---|
| `name` | string | Control characters become spaces, whitespace is collapsed and trimmed; 1–100 characters; not just a number (`12`, `#12`). Unique in the server, ignoring case: a taken name is `409 name_taken`; anything else invalid is `400 bad_request`. |
| `intervalSec` | number | Seconds between homepage / redeploy / uptime checks. Rounded and clamped to [`MIN_INTERVAL_SEC`, 3600]. Not a positive number → `400 invalid_interval`. |
| `sweepSec` | number | Every tracked page is re-checked within this time. Rounded and clamped to [30, 86400]. Not a positive number → `400 invalid_interval`. |
| `channelId` | string | A text or announcement channel of the token's server (`GET /guild`), else `400 invalid_channel`. Saved even when the bot can't post there (with a warning). `503` while Discord isn't ready. |
| `pingRoleId` | string \| null | A role of the token's server (the server id = @everyone), else `400 invalid_role`; `null` = no ping. |
| `paused` | boolean | Same as `/pause` / `/resume`. |
| `checks` | object | Partial switches: `deploy`, `text`, `pages`, `subdomains`, `files`, `status`, `codeIntel`, `maskNumbers` ("Ignore numbers"). An unknown key is `400 bad_request`. Switches you leave out keep their value. |

`200` `ApiManageResult`:

```json
{
  "changed": ["intervalSec", "checks.text", "checks.maskNumbers"],
  "message": "Saved — interval 2s → 5s · Text changes off · Ignore numbers on",
  "warnings": [],
  "watch": { "...": "ApiWatch" },
  "card": { "...": "ApiCard" }
}
```

The message lists, in this order: `name → X`, `interval As → Bs`, `full sweep As → Bs`, `channel → #name`, `ping → @Role` / `@everyone` / `none`, `paused` / `resumed`, `<Check> on|off`. Warnings: `I'm missing Send Messages, Embed Links in #alerts — alerts can't be delivered until that's fixed.` for a channel the bot can't post in; `Subdomains of hookedpad.com are already tracked by #7 Hookedpad app — new subdomains will be announced twice.` when subdomains are switched on while another watch of the same domain has them on.

Discord notices: moving the alerts posts `📢 Alerts for **Hookedpad** (https://hookedpad.com/) now post here — moved from #old by **Matt's Chrome**.` in the **new** channel; pausing or resuming posts `⏸️ **Hookedpad** was paused from **Matt's Chrome**.` / `▶️ … was resumed …`. Other changes post nothing (the dashboard's replies are private too).

Errors: `400 bad_request` / `invalid_interval` / `invalid_channel` / `invalid_role`, `404`, `409 name_taken`, `429 rate_limited` (management bucket), `503 unavailable`.

### POST /watches/:id/pause and POST /watches/:id/resume

No body (an empty body or `{}` is fine). Each sets an explicit state, so a stale screen can't flip it the wrong way:

- `changed: ["paused"]`, `message: "Paused Hookedpad — no checks until you resume it."` / `"Resumed Hookedpad."`, plus the Discord notice;
- or, when it already was in that state, `changed: []`, `message: "Hookedpad is already paused."` / `"Hookedpad is already running."`.

Pausing stops the site's checks; resuming restarts its normal schedule (staggered). Neither runs a check. `200` `ApiManageResult`; errors: `404`, `429` (management bucket), `503`.

### GET /watches/:id/rules and PATCH /watches/:id/rules

The 🚫 Rules form. `GET` → `200`:

```json
{
  "rules": { "ignorePatterns": ["Last updated.*"], "excludePatterns": ["/profile/*"], "extraUrls": ["https://hookedpad.com/secret"], "scopePath": null, "maxPages": 150 },
  "limits": { "...": "ApiLimits" }
}
```

| Rule | Meaning |
|---|---|
| `ignorePatterns` | Regexes (case-insensitive): matching text is removed before pages are compared, e.g. `Last updated.*` |
| `excludePatterns` | Never crawl, track or announce these URLs: a path glob (starts with `/`; `*` = one path segment, `**` = anything, a trailing `/*` = everything below, e.g. `/profile/*`) or a case-insensitive regex on the full URL |
| `extraUrls` | Pages always tracked even if nothing links to them (normalized absolute URLs) |
| `scopePath` | Only crawl under this path, e.g. `/docs`; null = the whole site |
| `maxPages` | Pages whose text is compared, 1–1000 |

`PATCH` body, every field optional. Each list takes **either** a full replacement array **or** an edit object:

```json
{
  "ignorePatterns": ["Last updated.*", "\\d+ online"],
  "excludePatterns": { "add": ["/blog/*"], "remove": ["/profile/*"] },
  "extraUrls": ["/secret", "https://hookedpad.com/hidden"],
  "scopePath": "/docs",
  "maxPages": 200
}
```

- **Replacement arrays**: entries are trimmed, empty ones dropped, duplicates removed keeping the first.
- **Edit objects** `{ "add": [...], "remove": [...] }` are applied to the current list: `remove` first (exact match after trimming; for `extraUrls` also the resolved form, so `"/secret"` removes `https://hookedpad.com/secret`; unknown entries are ignored), then `add` (appended in order, duplicates skipped). Use these for one-click actions ("ignore this folder"): they never overwrite a concurrent edit.
- Patterns: at most 25 per list; each **new** one (not in the current list) must be a valid regex of at most 300 characters without nested repetition like `(a+)+`, fast on long pages, and not so broad it would blank out all text / skip every URL. Otherwise `400 invalid_pattern` with `field` (`"ignorePatterns[1]"` = index in the request array, `"excludePatterns.add[0]"`). A new skip pattern that also matches the start URL is saved, with a warning.
- Extra pages: absolute `http(s)` URLs as they are; `host/path` when the host is the watched domain or a real public domain; anything else relative to the watch URL (`/secret`). At most 50 after removing duplicates (`400 bad_request`), each at most 2000 characters. An entry that isn't a URL or path, or a **new** one on a private / internal host (`localhost`, `10.x`, `*.internal`, … unless `ALLOW_PRIVATE_NETWORK`), is `400 invalid_url` with `field`.
- `scopePath`: `"/docs"`, `"docs/"` or a full URL (its path); `""`, `"/"`, `"none"`, `"off"`, `"all"` or `null` mean the whole site. At most 200 characters, no spaces, `?` or `#` (`400 bad_request`). Normalized to a leading `/` and no trailing `/`.
- `maxPages`: a whole number 1–1000, else `400 bad_request` (no clamping).

`200` `ApiManageResult` plus `rules`:

```json
{
  "changed": ["excludePatterns", "scopePath"],
  "message": "Rules saved — 1 skipped URL pattern · scope /docs. Affected pages are re-baselined silently.",
  "warnings": [],
  "rules": { "ignorePatterns": [], "excludePatterns": ["/blog/*"], "extraUrls": [], "scopePath": "/docs", "maxPages": 150 },
  "watch": { "...": "ApiWatch" },
  "card": { "...": "ApiCard" }
}
```

Errors: `400 bad_request` / `invalid_pattern` / `invalid_url`, `404`, `429` (management bucket), `503`.

### GET /watches/:id/pages

The 📄 Pages view. Read-only: pages are added through `extraUrls` and removed through `excludePatterns` / `scopePath`.

| Param | Default | Notes |
|---|---|---|
| `list` | `tracked` | `tracked` (pages whose text is compared), `untracked` (known pages only) or `files` |
| `limit` | `100` | 1–500 (clamped) |
| `offset` | `0` | |

`200`, ordered by crawl depth, then first seen, then URL:

```json
{
  "counts": { "tracked": 17, "maxPages": 150, "known": 18, "files": 0, "gone": 0, "dynamic": 1 },
  "list": "tracked",
  "total": 17,
  "pages": [
    { "url": "https://hookedpad.com/", "path": "/", "title": "Hookedpad", "kind": "page", "tracked": true, "gone": false, "dynamic": false,
      "status": 200, "source": "start", "depth": 0, "firstSeen": 1759673001000, "lastChecked": 1759676541000, "lastChanged": 1759675012000,
      "contentType": "text/html", "contentLength": null }
  ],
  "nextOffset": null
}
```

`nextOffset` is the `offset` of the next page when more remain, else `null`. `status` is the last HTTP status (0 = network error); `source` is how the page was found (`start`, `link`, `sitemap`, `extra`, `code`, `redirect`); `gone` = removed from the site; `dynamic` = changes too often to diff. Titles come from the website: render them as text.

### GET /watches/:id/subdomains and PATCH /watches/:id/subdomains

The 🛰️ Subdomains view. `GET` params: `limit` 1–1000 (default 200), `offset`. Live subdomains first, then by host:

```json
{
  "enabled": false, "rootDomain": "hookedpad.com", "known": 2, "live": 1, "total": 2,
  "subdomains": [
    { "host": "app.hookedpad.com", "sources": ["ct", "dns"], "alive": true, "firstSeen": 1759673100000, "lastSeen": 1759676000000,
      "dns": { "a": ["76.76.21.21"], "aaaa": [], "cname": [] },
      "http": { "status": 200, "title": "Hookedpad App", "finalUrl": "https://app.hookedpad.com/", "server": "Vercel" },
      "watchedAs": null },
    { "host": "beta.hookedpad.com", "sources": ["ct"], "alive": false, "firstSeen": 1759673100000, "lastSeen": 1759673100000,
      "dns": null, "http": null, "watchedAs": { "id": 14, "name": "Hookedpad (beta)" } }
  ],
  "nextOffset": null
}
```

`watchedAs` is set when the server already watches `https://<host>/`.

`PATCH` body `{ "enabled": true }` switches subdomain detection on or off (the same switch as `checks.subdomains`). `200` `ApiManageResult`, with the "announced twice" warning when another watch of the domain already tracks its subdomains.

### POST /watches/:id/subdomains/watch

"Watch this subdomain" (the button on subdomain alerts). Body: `{ "host": "app.hookedpad.com" }` (lowercased, trailing dots dropped).

- **`201`** `{ "created": true, "watch": ApiWatch }`: a new watch of `https://<host>/` that inherits the parent's alert channel, interval, full sweep, max pages, ping role, checks, ignore patterns and "Ignore numbers", with subdomains **off**, named `"<parent name> (<first label>)"` (made unique). Its silent first scan runs in the background, as for `POST /watches` (`status: "scanning"`, then the same two Discord notices).
- **`200`** `{ "created": false, "watch": ApiWatch }` when the server already watches `https://<host>/`.
- Errors: `400 invalid_url` (not a host under the parent's root domain, malformed, or private), `404` (parent), `409 limit_reached`, `429` (shares the 30-per-hour bucket with `POST /watches`), `503`.

### GET /watches/:id/history

The 🕘 History view, newest first.

| Param | Default | Notes |
|---|---|---|
| `limit` | `25` | 1–100 (clamped) |
| `before` | — | Event id: only older events (`id < before`) |

```json
{
  "events": [ { "id": 5821, "watchId": 12, "watchName": "Hookedpad", "watchUrl": "https://hookedpad.com/", "kind": "deploy", "summary": "Hookedpad redeployed", "createdAt": 1759675012000 } ],
  "nextBefore": null
}
```

`nextBefore` is the last event's id when a full page came back (pass it as `before` for the next page), else `null`. History is pruned by age, as for `/events`.

### GET /guild

The token's server as Discord's cache knows it, for the alert-channel and ping-role pickers:

```json
{
  "guild": { "id": "1280000000000000000", "name": "Alpha Calls" },
  "tokenChannelId": "1290000000000000001",
  "channels": [
    { "id": "1290000000000000001", "name": "scans", "type": "text", "category": "MONITORING", "canPost": true, "missing": [] },
    { "id": "1290000000000000002", "name": "announcements", "type": "announcement", "category": null, "canPost": false, "missing": ["Send Messages"] }
  ],
  "roles": [
    { "id": "1280000000000000077", "name": "Alpha", "everyone": false, "managed": false, "color": 15844367 },
    { "id": "1280000000000000000", "name": "@everyone", "everyone": true, "managed": false, "color": 0 }
  ]
}
```

- `channels`: text and announcement channels only, in Discord's order. `canPost` / `missing` say whether the bot has View Channel, Send Messages and Embed Links there.
- `roles`: highest first, @everyone (id = the server id) last. `managed` roles belong to bots and integrations.
- `503 unavailable` + `Retry-After: 5` while Discord isn't ready.

### GET /events

The server's alert feed, for clients that mirror alerts (desktop notifications, another bot).

```http
GET /api/v1/events?since=5812&limit=50
```

| Param | Default | Notes |
|---|---|---|
| `since` | `0` | Return events with `id > since` |
| `limit` | `50` | 1–200 (out-of-range values are clamped) |

A `since` or `limit` that isn't a non-negative integer gets `400 bad_request`.

`200`:

```json
{
  "events": [
    { "id": 5813, "watchId": 7, "watchName": "Unpeg", "watchUrl": "https://unpeg.io/", "kind": "subdomain", "summary": "New subdomain: beta.unpeg.io", "createdAt": 1759676102000 },
    { "id": 5814, "watchId": 12, "watchName": "Hookedpad", "watchUrl": "https://hookedpad.com/", "kind": "text", "summary": "Text changed on /launch", "createdAt": 1759676215000 }
  ],
  "nextSince": 5814
}
```

- `events` is **oldest first**. `nextSince` is the last returned id, or your `since` when nothing new arrived. Store it and pass it as `since` next time.
- If you get `limit` events back, more may be waiting: call again right away with `nextSince`.
- **First sync:** to start "from now" without replaying history, page through `since=0&limit=200` until fewer than 200 come back, keep the final `nextSince`, and don't notify for those events.
- Polling once a minute is plenty, and it costs 1 of the 120 requests per minute.
- Event ids only grow while the bot keeps its database (a Railway volume, see README). If the database is ever reset, ids start again from 1. A client whose cursor is ahead of every id would then see nothing new. Re-run the first sync when the user re-tests the connection, and optionally about once a day. If the newest id you get back is lower than your cursor, adopt it.
- History is pruned by age, so very old events disappear.

#### ApiEvent schema

| Field | Type | Meaning |
|---|---|---|
| `id` | number | Increasing event id (the cursor) |
| `watchId`, `watchName`, `watchUrl` | | The site it is about |
| `kind` | string | `deploy` (redeploy), `text` (text change, including JSON API diffs), `new_pages`, `removed_pages`, `subdomain` (new subdomain), `subdomain_live`, `file`, `status` (down / back up), `info` (notes). More kinds may be added. |
| `summary` | string | One-line human summary. Plain text that may contain Discord-style `**bold**`; display it as text, never as HTML. |
| `createdAt` | number | ms |

---

## 7. curl examples

```bash
API=https://site-watcher-production.up.railway.app/api/v1
TOKEN=swb_paste_yours_here   # from /link create — keep it out of shell history on shared machines
AUTH="Authorization: Bearer $TOKEN"

# test the connection
curl -s "$API/ping" -H "$AUTH"

# scan a site (quick subdomains)
curl -s -X POST "$API/scan" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"url":"unpeg.io","subdomains":"quick"}'

# is it tracked?
curl -s -G "$API/watches" -H "$AUTH" --data-urlencode 'url=https://hookedpad.com/app'

# add it (alerts go to the token's channel)
curl -s -X POST "$API/watches" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"url":"https://hookedpad.com","name":"Hookedpad"}'

# one watch + its newest alerts
curl -s "$API/watches/12" -H "$AUTH"

# check it now (full: every tracked page too)
curl -s -X POST "$API/watches/12/check" -H "$AUTH" -H 'Content-Type: application/json' -d '{"full":false}'

# the site card + the server's site list
curl -s "$API/watches/12" -H "$AUTH"
curl -s "$API/watches" -H "$AUTH"

# settings, checks and pause in one call
curl -s -X PATCH "$API/watches/12" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"intervalSec":5,"sweepSec":300,"checks":{"text":false,"maskNumbers":true}}'

# move the alerts / ping a role (ids from GET /guild)
curl -s "$API/guild" -H "$AUTH"
curl -s -X PATCH "$API/watches/12" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"channelId":"1290000000000000002","pingRoleId":"1280000000000000077"}'

# pause / resume
curl -s -X POST "$API/watches/12/pause" -H "$AUTH"
curl -s -X POST "$API/watches/12/resume" -H "$AUTH"

# rules: skip a folder (edit object), replace the ignore list, scope the crawl
curl -s -X PATCH "$API/watches/12/rules" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"excludePatterns":{"add":["/blog/*"]},"ignorePatterns":["Last updated.*"],"scopePath":"/docs"}'

# pages, subdomains, history
curl -s "$API/watches/12/pages?list=tracked&limit=50" -H "$AUTH"
curl -s "$API/watches/12/subdomains" -H "$AUTH"
curl -s -X POST "$API/watches/12/subdomains/watch" -H "$AUTH" -H 'Content-Type: application/json' -d '{"host":"app.hookedpad.com"}'
curl -s "$API/watches/12/history?limit=25" -H "$AUTH"

# alert feed since a cursor
curl -s "$API/events?since=5812&limit=50" -H "$AUTH"

# stop watching
curl -s -X DELETE "$API/watches/12" -H "$AUTH"

# preflight (no auth) — should print 204
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS "$API/scan" \
  -H 'Origin: chrome-extension://abc' -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type'
```

A minimal client in another bot (Node 18+):

```js
const api = (path, init = {}) =>
  fetch(`${process.env.SWB_API_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.SWB_TOKEN}`, 'Content-Type': 'application/json', ...init.headers },
  }).then(async (r) => {
    const body = await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error(body?.error?.message ?? r.statusText), { status: r.status, code: body?.error?.code, retryAfter: Number(r.headers.get('retry-after')) || null });
    return body;
  });

await api('/watches', { method: 'POST', body: JSON.stringify({ url: 'unpeg.io' }) });
```

## 8. Versioning

- `/api/v1` stays **backwards compatible**. Within v1 the bot only makes additive changes:
  - new endpoints
  - new optional request fields
  - new response fields
  - new values for open-ended strings: `TechCategory`, `ApiEvent.kind`, `ApiWatch.status`, social `kind`s, `features` keys, error `code`s
- **Clients must ignore unknown fields and tolerate unknown enum values.**
- Anything breaking (removing or renaming a field, changing a type or a status code's meaning) ships under a new prefix, `/api/v2`. `/api/v1` keeps working alongside it, because the extension ships to users as a zip and can't be updated in lockstep with the bot.
- `GET /ping` reports `apiVersion` so a client can tell what it is talking to.

## 9. Security notes

- Tokens are bearer credentials scoped to one server. They are stored as SHA-256 hashes only. The Discord backup of the watch list carries the hashes, never the tokens, so links survive redeploys.
- Revoking (`/link revoke`) is immediate. Sites a token added stay watched until someone removes them.
- The scan and the add endpoint refuse private, loopback, link-local and internal hosts (including Railway's private `*.railway.internal` network), and so do new extra pages (`PATCH …/rules`) and subdomain watches. A public name that resolves to such an address is never fetched. The operator can lift this with `ALLOW_PRIVATE_NETWORK` for self-hosting or tests.
- A token can change any watch of **its own** server, including moving its alerts to any text or announcement channel of that server (as Manage Server members can on the dashboard). It can never read or touch another server's watches, channels or roles. Management changes are logged (token label and the changed keys, never the token); pauses, resumes and moved alerts are also announced in Discord.
- A token stops working when its server removes the bot.
- Tokens are never logged. Unexpected errors answer with a generic message; details stay in the bot's logs.
- All scan output (titles, tech evidence, socials, API paths, event summaries), page titles, subdomain probes and Discord channel / role names come from third parties. **Render them as text, never as HTML.**

## 10. Local test server

`npm run dev:link` starts the Link API without Discord, for a client's integration tests (scripts/dev-link-server.ts). It runs the bot's real HTTP server, Link API, monitor and store (in-memory SQLite), listens on **127.0.0.1 only**, and fakes Discord: a cached server with channels and roles, and notices / alerts printed to the console.

```bash
PORT=8721 npm run dev:link
# API URL  http://127.0.0.1:8721/api/v1
# token    swb_dev-local-link-token-for-extension-tests000   (server "Dev Server", alerts in #scans)
# other    swb_dev-other-server-token-for-isolation-test00   (server "Other Server", for cross-server checks)
```

Seeded on every start:

| Id | Server | Watch | Notes |
|---|---|---|---|
| 1 | Dev Server | Fixture — `http://127.0.0.1:<PORT+1>/` | A local fixture site, crawled for real (offline). `GET http://127.0.0.1:<PORT+1>/__bump` makes its next check see a redeploy, a text change and a new page. |
| 2 | Dev Server | Fixture docs — `http://localhost:<PORT+1>/docs` | The same site under another host name, every 30 s |
| 3 | Dev Server | Hookedpad (seeded) — `https://hookedpad.com/` | Paused and never fetched: a full card (17 tracked pages, 1 too dynamic, 51 bundles, 3 subdomains, rules, ping @Alpha, 30 history events). Resuming it fetches the real site. |
| 4 | Other Server | Other server site — `https://secret.example/` | Paused; a `404` with the Dev Server token |

Channels: `#scans` 1290000000000000001, `#alerts` 1290000000000000002, `#announcements` 1290000000000000003 (announcement channel the bot can't post in). Roles: `@Alpha` 1280000000000000077, `@Site Watcher` 1280000000000000078 (managed), `@everyone` 1280000000000000000.

Environment: `PORT` (8721), `DEV_SITE_PORT` (PORT + 1), `DEV_DB` (a SQLite file instead of memory), `DEV_TOKEN` / `DEV_OTHER_TOKEN`, `DEV_SEED_URLS` (comma-separated real sites to add), `DEV_ALLOW_PRIVATE=1` (accept private targets such as extra pages on the 127.0.0.1 fixture, like `ALLOW_PRIVATE_NETWORK`), `DEV_REAL_NET=1` (real Certificate Transparency and DNS lookups), `LOG_LEVEL`. The tokens are fixed and public: never use them anywhere else.
