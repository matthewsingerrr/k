# Link API v1 — integration guide

The Link API lets outside clients (the **Arkham Dev Tags** browser extension, other bots, scripts) talk to this Discord bot:

- **scan** any website (tech stack, hosting, build id, subdomains, API endpoints, socials),
- **add / list / remove** sites on a Discord server's watch list,
- **trigger a check** of a watched site,
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

A missing, malformed or unknown/revoked token gets **`401 unauthorized`**. So does a token whose Discord server has removed the bot (re-add the bot and `/link create` a new token).

Treat a token like a password. Anyone holding it can add and remove sites on that server and read its alert feed. Never commit it, bundle it in an extension zip, put it in a URL, or log it.

## 3. CORS

Every `/api/v1` response, errors included, carries:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Authorization, Content-Type, X-Link-Token
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Max-Age: 600
Access-Control-Expose-Headers: Retry-After
```

`OPTIONS` (preflight) on any `/api/v1` path returns **`204`** with no authentication required. A preflight that sends `Access-Control-Request-Private-Network: true` also gets `Access-Control-Allow-Private-Network: true`; this only matters for a self-hosted bot on a LAN. Auth uses a header, not a cookie, so the wildcard origin is safe: a page cannot call the API unless it already has the token. No `Access-Control-Allow-Credentials` is sent.

## 4. Requests, responses, errors

- Request bodies are JSON: send `Content-Type: application/json`. The maximum body size is **32 KB**, and the body must arrive within **15 s**. Compressed bodies (`Content-Encoding`) get `400 bad_request`.
- A trailing slash on a path is ignored (`/watches/` is `/watches`).
- Every response body is JSON (`content-type: application/json; charset=utf-8`).
- Timestamps named `…At` with numeric values are **Unix epoch milliseconds**. `scannedAt` is an ISO-8601 string.
- Errors always have this shape, with a fitting HTTP status:

```json
{ "error": { "code": "rate_limited", "message": "Too many requests — try again in 42s." } }
```

`message` is human-readable and may change. Branch on `code`:

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | Body is not valid JSON or not a JSON object, or a field has the wrong type (for example `features.text: "yes"` or an unknown `subdomains` mode) |
| 400 | `invalid_url` | `url` is not a usable website URL, or it points at a private / internal address (`localhost`, `127.0.0.1`, `10.x`, `192.168.x`, `169.254.x`, `*.internal`, `*.local`, …) |
| 400 | `invalid_interval` | `intervalSec` is not a usable number of seconds (in-range numbers are used, out-of-range ones are clamped) |
| 401 | `unauthorized` | Token missing, unknown or revoked, or the bot is no longer in the token's server |
| 404 | `not_found` | Unknown route, or a watch id that doesn't exist **in this token's server** |
| 405 | `method_not_allowed` | Known route, wrong HTTP method (the response has an `Allow` header) |
| 408 | `timeout` | The request body didn't arrive within 15 s |
| 409 | `limit_reached` | The server already watches its maximum number of sites (`MAX_WATCHES_PER_GUILD`, default 50) |
| 413 | `too_large` | Request body over 32 KB |
| 429 | `rate_limited` | A rate limit was hit (see §5). Always has a `Retry-After` header. |
| 500 | `internal_error` | Unexpected error on the bot. The message is generic; details stay in the bot's logs. |
| 502 | `scan_failed` | The scan itself could not run (not "the site is down"; see `POST /scan`) |
| 503 | `unavailable` | The bot is still starting up: adding and checking need its monitor, and right after a redeploy it may still be restoring link tokens from its Discord backup, so an unknown token gets `503` + `Retry-After: 15` instead of `401` for up to a few minutes. Retry; don't treat it as a revoked token. |
| 504 | `timeout` | `POST /watches/:id/check` took longer than 60 s |

Treat any other 400 as "fix the request". Treat any other 5xx (for example during a redeploy) as a temporary failure and retry later. Treat an unknown `code` as a generic error.

## 5. Rate limits

Limits are per token, enforced as in-memory token buckets:

| Bucket | Limit |
|---|---|
| All requests | 120 per minute |
| `POST /scan` | 20 per 10 minutes |
| `POST /watches` | 30 per hour |

The bot also caps how many scans run at once across all tokens (3), because scans share its outbound HTTP budget with the monitoring. When that cap is hit, `POST /scan` returns `429 rate_limited` with `Retry-After: 5`.

When a limit is exceeded the API returns `429 rate_limited` with `Retry-After: <seconds>`. The header is exposed to browser callers. Wait at least that long before calling that endpoint again. The buckets live in memory, so they reset when the bot restarts. Don't rely on that.

---

## 6. Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/ping` | Check the token and connection; returns which server and channel it's bound to |
| POST | `/scan` | One-off scan of any site (nothing is stored) |
| GET | `/watches` | The server's watched sites (optionally only those matching `?url=`) |
| POST | `/watches` | Add a site to the server's watch list |
| GET | `/watches/:id` | One watch plus its 20 newest alerts |
| DELETE | `/watches/:id` | Stop watching a site |
| POST | `/watches/:id/check` | Check a watched site now |
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
  "watches": 7
}
```

- `version` is the bot's build version. It is informational; don't parse it.
- `apiVersion` is `1` for everything under `/api/v1`.
- `guild.id` and `channelId` are Discord snowflakes (strings). Names are not exposed.
- `label` is the label given at `/link create`.
- `watches` is the number of sites the server watches.

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
{ "watches": [ { "id": 7, "name": "Unpeg", "...": "ApiWatch fields" } ] }
```

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
  "watched": true
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
  The existing watch keeps its own name, channel and settings.
- Errors:
  - `400 invalid_url` / `invalid_interval` / `bad_request`
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
  "events": [
    { "id": 5821, "watchId": 12, "watchName": "Hookedpad", "watchUrl": "https://hookedpad.com/", "kind": "deploy", "summary": "Hookedpad redeployed", "createdAt": 1759675012000 }
  ]
}
```

`events` contains the 20 newest alerts of that watch, **newest first**. A watch that doesn't exist or belongs to another server returns `404 not_found`.

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

A check that takes longer than 60 s returns `504 timeout`. The check may still finish and post its alerts. A bad id returns `404 not_found`; `503 unavailable` means the bot is still starting. The endpoint takes no parameters. An empty body is fine; so is `{}`. Concurrent checks of the same site share one run. Starting a new check of the same site within 30 s of the last one returns `429 rate_limited` with `Retry-After`.

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

# check it now
curl -s -X POST "$API/watches/12/check" -H "$AUTH"

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
- The scan and the add endpoint refuse private, loopback, link-local and internal hosts (including Railway's private `*.railway.internal` network). A public name that resolves to such an address is never fetched. The operator can lift this with `ALLOW_PRIVATE_NETWORK` for self-hosting or tests.
- A token stops working when its server removes the bot.
- Tokens are never logged. Unexpected errors answer with a generic message; details stay in the bot's logs.
- All scan output (titles, tech evidence, socials, API paths, event summaries) comes from third-party websites. **Render it as text, never as HTML.**
