# Link API v1 — management additions (contract)

Status: implemented on branch `ext-manage` (base `22be810`); see §10 for the implementation notes.

This adds site **management** to Link API v1, so the extension's Discord view can show and edit everything the Discord site card shows: the card, Check now, Pause/Resume, Settings, Remove, Features, Rules, Pages, Subdomains, History and the server list.

Every change is **additive**. Existing routes, fields, status codes and error codes keep their meaning. `apiVersion` stays `1`. Older clients keep working unchanged.

Permission model: a Link token is created by a member with **Manage Server** (`/link create`). It therefore has the same rights as the Discord dashboard buttons, **for its own server only**:

- It can read and change any watch of its server, including watches added in Discord and watches posting to other channels. `DELETE` already works this way.
- A watch id from another server is `404 not_found`, exactly like an unknown id.
- A channel or role from another server is `400 invalid_channel` / `400 invalid_role`.

---

## 1. Source map: Discord UI → code → API

### 1.1 Site card fields (`renderSiteInfo`, src/discord/commands.ts)

| Card element | Source in the bot | API field (`GET /watches/:id` → `card`) |
|---|---|---|
| Title: status emoji + name, link | `siteStatus(w, safeState(store, id))`, `w.name`, `w.url` | `status`, `statusLabel`, `name`, `url` |
| Description line 1 | `w.url` | `url` |
| `Up` / `Down since … (error)` / `Paused` / `First scan pending` / `Blocked by the site’s bot protection` | `siteStatus().label`; `state.status.downSince`, `state.status.lastError` (only when not paused and down) | `statusLabel`, `downSince`, `downError` |
| `last check …` · `last change …` | `state.lastCheckAt`, `state.lastChangeAt` (0 = never) | `lastCheckAt`, `lastChangeAt` (null = never) |
| **Schedule**: `every 2s` / `all pages ~2m` | `w.intervalSec`, `w.sweepSec` | `schedule.intervalSec`, `schedule.sweepSec` |
| **Alerts**: `#channel` / `ping: none` | `w.channelId`, `roleMention(w.pingRoleId, w.guildId)` (guild id = @everyone) | `alerts.channelId`, `alerts.channelName`, `alerts.ping`, `alerts.pingRoleId`, `alerts.pingRoleName` |
| **Build**: build id · `51 bundles` · generator | `state.deploy.buildId`, `state.deploy.assets.length`, `state.deploy.generator` (`unknown` when no fingerprint) | `build` (null = unknown) |
| **Pages**: `17 tracked (max 150) · 18 known` / `0 files · 0 gone · 1 too dynamic` | `listPages(id,{kind:'page',tracked:true})`, `w.maxPages`, `countPages(id,{kind:'page'})`, `countPages(id,{kind:'file'})`, tracked `.gone` / `.dynamic` | `pages.tracked`, `pages.maxPages`, `pages.known`, `pages.files`, `pages.gone`, `pages.dynamic` |
| **Subdomains**: `N known · M live` + CT-quota note, or `off (N known)` | `w.features.subdomains`, `listSubdomains(id)` (`alive`), `ctNote()` | `subdomains.enabled`, `subdomains.known`, `subdomains.live`, CT note in `warnings` |
| **Rules**: `0 ignore patterns · 0 skipped URL patterns · 0 extra pages · scope: whole site` | `w.ignorePatterns.length`, `w.excludePatterns.length`, `w.extraUrls.length`, `w.scopePath` | `rules.ignorePatterns`, `rules.excludePatterns`, `rules.extraUrls`, `rules.scopePath` |
| **Checks** grid (8 switches) | `FEATURE_TOGGLES` + `toggleValue(w, key)`: `maskNumbers` reads `w.maskNumbers`, the rest `w.features[key]` | `checks[]` (key, label, emoji, hint, on) |
| **Runtime**: `running` · `baseline scan in progress` · `last check took 123ms` · `next …` | `monitor.runtimeInfo(id)` → `{ running, baselineRunning, lastTickAt, lastTickMs, nextTickAt }` | `runtime` (null when the monitor hasn't started) |
| **Last error** (only when set) | `state.lastError` | `lastError` |
| **Delivery** warning (missing perms / deleted channel) | `permsWarning(i, w.channelId)` → `missingChannelPerms` (View Channel, Send Messages, Embed Links) | `alerts.canPost`, `alerts.missing`, plain-text line in `warnings` |
| Footer: `#12 · host · added 2026-10-05` | `w.id`, `w.host`, `w.createdAt` | `id`, `host`, `createdAt` |

### 1.2 Buttons, modals and selects (src/discord/panel.ts)

| Discord control | custom_id | Handler → bot functions | Rights | API |
|---|---|---|---|---|
| Dashboard summary + "Manage a site…" picker | `panel:pick:<n>` | `buildPanelMessage`: `store.listWatches(guild)`, `siteStatus` per watch | anyone | `GET /watches` (+ new `summary`) |
| ➕ Add site (modal: url, name, interval, channel, ping role) | `panel:add` → `panel:m:add` | `submitAdd` → `prepareAdd` → `finishAdd` (baseline, `startWatch`) | Manage Server | `POST /watches` (+ new optional `channelId`, `pingRoleId`) |
| 🔄 Refresh / 📖 Help | `panel:refresh` / `panel:help` | `PanelHost.refresh` / `renderHelp` | anyone | client-side (re-GET) |
| Open card / ◀ Back | `panel:site:<id>` | `cardView` → `renderSiteInfo` | anyone | `GET /watches/:id` (+ new `card`) |
| ⚡ Check now | `panel:check:<id>` | `runCheck(deps, w, false)` → `monitor.checkNow(id,{full:false})` | Manage Server | `POST /watches/:id/check` (exists; + optional `full`) |
| ⏸️ Pause / ▶️ Resume | `panel:pause:<id>:<1/0>` (desired state) | `store.updateWatch(id,{paused})` + `notifyUpdated` (no-op if already in that state) | Manage Server | `POST /watches/:id/pause`, `POST /watches/:id/resume`, or `PATCH /watches/:id {paused}` |
| ⚙️ Settings (modal: name, interval, full sweep, alert channel, ping role) | `panel:settings:<id>` → `panel:m:settings:<id>` | `submitSettings`: `cleanName`, `nameTaken(…, w.id)`, `parseSeconds(interval, minInterval..3600)`, `parseSeconds(sweep, 30..86400)`, channel select (text/announcement), role select; one `store.updateWatch` + `notifyUpdated` | Manage Server | `PATCH /watches/:id` |
| 🗑️ Remove → confirm | `panel:remove:<id>` → `panel:rmyes:<id>` | `removeWatch` → `store.deleteWatch` + `monitor.onWatchRemoved` | Manage Server | `DELETE /watches/:id` (exists) |
| 🧩 Features → one toggle per check | `panel:features:<id>`, `panel:toggle:<id>:<key>:<1/0>` (desired state) | `maskNumbers` → `{maskNumbers}`, else `{features:{…w.features,[key]:on}}`; `store.updateWatch` + `notifyUpdated` | Manage Server | `PATCH /watches/:id {checks}` |
| 🚫 Rules (modal: ignore, skip URLs, extra pages, scope, max pages) | `panel:rules:<id>` → `panel:m:rules:<id>` | `submitRules`: `validateNewPatterns` (≤ 25, `validatePattern` on new entries), start-URL warning, `resolvePageUrl` (≤ 50), `parseScope`, max pages 1..1000; `resetPageNoise` if ignore changed; `store.updateWatch` + `notifyUpdated` | Manage Server | `GET/PATCH /watches/:id/rules` |
| 🚫 Ignore `/folder/*` (button on new-page alerts) | `panel:exclude:<id>:<pattern>` | `validatePattern(p,'exclude')`, ≤ 25, refuses a pattern matching the start URL, append | Manage Server | `PATCH /watches/:id/rules {excludePatterns:{add:[…]}}` |
| 📄 Pages | `panel:pages:<id>` | `renderPages`: tracked pages (path, title, gone/dynamic), files, counts | anyone | `GET /watches/:id/pages` |
| 🛰️ Subdomains | `panel:subs:<id>` | `renderSubdomains`: `listSubdomains` sorted live-first then host; sources | anyone | `GET /watches/:id/subdomains`; on/off: `PATCH /watches/:id/subdomains` |
| "Watch this subdomain" (button on subdomain alerts) | `watchsub:<id>:<host>` | `handleButton` (commands.ts): host under parent root domain, duplicate check, `checkWatchLimit`, `createWatch` inheriting the parent's settings (subdomains off), baseline, start | Manage Server | `POST /watches/:id/subdomains/watch` |
| 🕘 History | `panel:history:<id>` | `renderHistory(deps, w, 15)` → `store.listEvents(id, 1..25)` newest first | anyone | `GET /watches/:id/history` |

"Subdomain modes": a **watch** only has an on/off switch (`features.subdomains`). The `none` / `quick` / `full` modes belong to the one-off `POST /scan` and are unchanged.

---

## 2. Validation rules and limits (same as the Discord UI)

Constants come from src/discord/commands.ts. The API must import them, never copy the numbers.

| Field | Rule | On failure |
|---|---|---|
| `name` | `cleanName()`: control characters become spaces, whitespace is collapsed, then trimmed. 1..`MAX_NAME_CHARS` (100) characters. Not number-only (`/^#?\d+$/`). Unique within the server, case-insensitive (`nameTaken(deps, guild, name, w.id)`). | `400 bad_request`; taken → `409 name_taken` |
| `intervalSec` | A JSON number, finite and > 0. Rounded and **clamped** to [`minInterval(config)` (env `MIN_INTERVAL_SEC`, default 1), `MAX_INTERVAL_SEC` 3600], as `POST /watches` already does. | `400 invalid_interval` |
| `sweepSec` | A JSON number, finite and > 0. Rounded and **clamped** to [`SWEEP_MIN_SEC` 30, `SWEEP_MAX_SEC` 86400]. | `400 invalid_interval` |
| `channelId` | Snowflake string. Must be a **text or announcement** channel of the **token's** server, per `deps.guildInfo(token.guildId)`. Threads, voice, forum and other servers' channels are refused. If the bot can't post there, the change is still saved and a `warnings` line says why (parity with Settings). | `400 invalid_channel`; Discord cache not ready → `503 unavailable` |
| `pingRoleId` | `null` (no ping) or a role id of the token's server. The guild id itself means @everyone, as in `roleMention`. | `400 invalid_role`; cache not ready → `503 unavailable` |
| `paused` | boolean | `400 bad_request` |
| `checks.<key>` | boolean. Keys: `deploy`, `text`, `pages`, `subdomains`, `files`, `status`, `codeIntel`, `maskNumbers` (= `FEATURE_TOGGLES` keys). | `400 bad_request` (also for an unknown key) |
| `ignorePatterns` | At most `MAX_PATTERNS` (25) entries. **New** entries (not in the current list) go through `validatePattern(p, 'ignore')`: non-empty, ≤ `MAX_PATTERN_CHARS` (300), valid JS regex (flags `gi`), no nested quantifier (`hasNestedQuantifier`), fast on adversarial input (`regexIsFast`, 200 ms vm probe), and not matching a whole line of any text. | `400 invalid_pattern` + `field` |
| `excludePatterns` | At most 25 entries. New entries go through `validatePattern(p, 'exclude')`. A path glob (starts with `/`, contains `*`, no `.*`, URL-path characters only: `*` = one segment, `**` = anything, trailing `/*` = everything below) or a case-insensitive regex on the full URL. Must not match every URL. A new pattern matching the start URL is saved with a `warnings` line, as in the Rules modal. | `400 invalid_pattern` + `field` |
| `extraUrls` | Each entry ≤ 2000 characters, through `resolvePageUrl(entry, w)`: absolute http(s) URLs as-is, `host/path` when the host is the watched domain or a real public domain, otherwise relative to the watch URL (`/secret`). De-duplicated. At most `MAX_EXTRA_URLS` (50). A resolved host that is private or internal (`isPrivateTarget`) is refused unless `ALLOW_PRIVATE_NETWORK`. | `400 invalid_url` + `field`; too many → `400 bad_request` |
| `scopePath` | `null`, or a string through `parseScope()`: `""`, `/`, `none`, `off`, `all` mean the whole site; `/docs`, `docs/` or a full URL (its path) are accepted; ≤ `MAX_SCOPE_CHARS` (200); no whitespace, `?` or `#`. Normalized to a leading `/` with no trailing `/`. | `400 bad_request` |
| `maxPages` | Integer 1..`MAX_PAGES_LIMIT` (1000). No clamping, as in the Rules modal and `prepareAdd`. | `400 bad_request` |
| `host` (subdomain watch) | Lowercase, trailing dots stripped, `/^[a-z0-9_.-]{1,253}$/`. `parseWatchInput('https://'+host+'/')` must succeed, `isUnderDomain(host, parent.rootDomain)` must hold, and the host must not be private. | `400 invalid_url` |
| `limit` / `offset` / `before` query params | Non-negative integers (`intParam`). `limit` is clamped to the route's range. | `400 bad_request` |

All validation of a request happens **before** anything is written. A request that fails changes nothing.

---

## 3. Changes to existing behaviour (all additive)

1. **CORS**: `Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS`.
2. **Bodies**: `PATCH` bodies are read like `POST` bodies (JSON object, ≤ 32 KB, 15 s, no compression). An empty body or `{}` is a no-op.
3. **Error envelope**: unchanged, plus an optional `field` on validation errors:
   ```json
   { "error": { "code": "invalid_pattern", "message": "Skip-URL pattern (a+)+: That pattern has nested repetition like (a+)+, which can freeze the bot on some pages. Please simplify it.", "field": "excludePatterns[0]" } }
   ```
   `field` is a JSON path into the request body. Clients may ignore it.
4. **New error codes**:

   | Status | Code | When |
   |---|---|---|
   | 400 | `invalid_pattern` | An ignore or skip-URL pattern failed `validatePattern`, or a list has more than 25 entries |
   | 400 | `invalid_channel` | `channelId` is not a text or announcement channel of the token's server |
   | 400 | `invalid_role` | `pingRoleId` is not a role of the token's server |
   | 409 | `name_taken` | Another site in the server already has that name |

5. **New rate-limit class** `manage`: **60 per 10 minutes** per token. It covers `PATCH /watches/:id`, `POST /watches/:id/pause|resume`, `PATCH /watches/:id/rules` and `PATCH /watches/:id/subdomains`, on top of `all` (120/min). `POST /watches/:id/subdomains/watch` uses `add` (30/hour), like `POST /watches`.
6. **New response fields**:
   - `GET /ping` → `limits`
   - `GET /watches` → `summary`
   - `GET /watches/:id` → `card` and `limits`
7. **New optional request fields**:
   - `POST /watches` → `channelId`, `pingRoleId`
   - `POST /watches/:id/check` → `full`
8. **`503 unavailable`** (with `Retry-After: 5`) also when:
   - a mutating route runs before the monitor has started (writes need `notifyUpdated`), or
   - a request needs Discord's guild cache (channel or role validation, `GET /guild`) before it's ready.
9. **`405` `Allow` headers** follow the new method lists (`/watches/:id` → `GET, PATCH, DELETE, OPTIONS`).

---

## 4. Schemas (add to src/link/types.ts)

```ts
export type ToggleKey = 'deploy' | 'text' | 'pages' | 'subdomains' | 'files' | 'status' | 'codeIntel' | 'maskNumbers';

/** Validation limits, so a client can check input before sending it. */
export interface ApiLimits {
  minIntervalSec: number;   // minInterval(config)
  maxIntervalSec: number;   // MAX_INTERVAL_SEC (3600)
  sweepMinSec: number;      // SWEEP_MIN_SEC (30)
  sweepMaxSec: number;      // SWEEP_MAX_SEC (86400)
  maxPagesLimit: number;    // MAX_PAGES_LIMIT (1000)
  maxPatterns: number;      // MAX_PATTERNS (25), per list
  maxPatternChars: number;  // MAX_PATTERN_CHARS (300)
  maxExtraUrls: number;     // MAX_EXTRA_URLS (50)
  maxScopeChars: number;    // MAX_SCOPE_CHARS (200)
  maxNameChars: number;     // MAX_NAME_CHARS (100)
  maxWatches: number;       // config.maxWatchesPerGuild (0 = unlimited)
}

/** The Discord site card as data. Every string from a website or from Discord is plain text: render it as text. */
export interface ApiCard {
  id: number;
  name: string;
  url: string;
  host: string;
  rootDomain: string;
  status: string;                 // same value as ApiWatch.status: up | down | blocked | paused | scanning
  statusLabel: string;            // siteStatus().label: "Up" | "Down" | "Paused" | "First scan pending" | "Blocked by the site’s bot protection"
  downSince: number | null;       // ms; only while down and not paused
  downError: string | null;       // state.status.lastError; only while down and not paused
  lastCheckAt: number | null;
  lastChangeAt: number | null;
  schedule: { intervalSec: number; sweepSec: number };
  alerts: {
    channelId: string;
    channelName: string | null;   // null when Discord's cache doesn't know it
    canPost: boolean | null;      // null = unknown (Discord not ready)
    missing: string[];            // "View Channel" | "Send Messages" | "Embed Links" | "channel not found"
    ping: 'none' | 'role' | 'everyone';
    pingRoleId: string | null;    // the guild id when ping = everyone
    pingRoleName: string | null;
  };
  build: { id: string | null; bundles: number; generator: string | null } | null; // null = no fingerprint yet ("unknown")
  pages: { tracked: number; maxPages: number; known: number; files: number; gone: number; dynamic: number };
  subdomains: { enabled: boolean; known: number; live: number };
  rules: { ignorePatterns: number; excludePatterns: number; extraUrls: number; scopePath: string | null };
  checks: Array<{ key: ToggleKey; label: string; emoji: string; hint: string; on: boolean }>; // FEATURE_TOGGLES order
  runtime: { running: boolean; baselineRunning: boolean; lastTickAt: number | null; lastTickMs: number | null; nextTickAt: number | null } | null;
  lastError: string | null;       // state.lastError
  warnings: string[];             // plain text: delivery problem, shared CT quota
  createdAt: number;
}

export interface ApiRules {
  ignorePatterns: string[];
  excludePatterns: string[];
  extraUrls: string[];            // normalized absolute URLs
  scopePath: string | null;       // null = whole site
  maxPages: number;
}

/** Result of every management write. */
export interface ApiManageResult {
  changed: string[];              // e.g. ["intervalSec", "checks.text"]; [] = nothing changed (nothing written)
  message: string;                // plain text, e.g. "Saved — interval 2s → 5s · Text changes off" | "Nothing changed."
  warnings: string[];             // plain text
  watch: ApiWatch;
  card: ApiCard;
}

export interface ApiServerSummary {
  total: number;
  limit: number;                  // config.maxWatchesPerGuild (0 = unlimited)
  counts: { up: number; down: number; blocked: number; paused: number; scanning: number };
  channels: Array<{ id: string; name: string | null; watches: number }>; // most watches first
  text: string;                   // "Watching 13 sites · alerts in #scans · 9 up · 1 blocked · 1 paused · 2 scanning"
}

export interface ApiPage {
  url: string;
  path: string;                   // urlPath(url)
  title: string | null;
  kind: 'page' | 'file';
  tracked: boolean;
  gone: boolean;
  dynamic: boolean;
  status: number | null;          // last HTTP status (0 = network error)
  source: string;                 // start | link | sitemap | extra | code | redirect
  depth: number;
  firstSeen: number;
  lastChecked: number | null;     // 0 → null
  lastChanged: number | null;
  contentType: string | null;
  contentLength: number | null;
}

export interface ApiSubdomain {
  host: string;
  sources: string[];              // ct | crtsh | dns | link | code
  alive: boolean;
  firstSeen: number;
  lastSeen: number;
  dns: { a: string[]; aaaa: string[]; cname: string[] } | null;
  http: { status: number; title: string | null; finalUrl: string | null; server: string | null } | null;
  watchedAs: { id: number; name: string } | null; // this server already watches https://<host>/
}

export interface ApiGuildInfo {
  guild: { id: string; name: string };
  tokenChannelId: string;
  channels: Array<{ id: string; name: string; type: 'text' | 'announcement'; category: string | null; canPost: boolean; missing: string[] }>;
  roles: Array<{ id: string; name: string; everyone: boolean; managed: boolean; color: number }>;
}
```

`ApiWatch`, `ApiEvent` and `ScanResult` are **unchanged**.

---

## 5. Routes

All routes require the Bearer token, are scoped to the token's server, and use the existing pipeline: route `404` → method `405` → auth `401`/`503` → rate limit `429` → body → handler.

In the handler, every `:id` goes through `ownWatch()`. An unknown id, or an id of another server, is `404 not_found` (`"Unknown watch."`).

### 5.1 GET /ping (existing, + `limits`)

```json
{ "ok": true, "bot": "site-watcher", "version": "2.0.0", "apiVersion": 1, "guild": { "id": "1280000000000000000" },
  "channelId": "1290000000000000001", "label": "Matt's Chrome", "watches": 13,
  "limits": { "minIntervalSec": 1, "maxIntervalSec": 3600, "sweepMinSec": 30, "sweepMaxSec": 86400, "maxPagesLimit": 1000,
              "maxPatterns": 25, "maxPatternChars": 300, "maxExtraUrls": 50, "maxScopeChars": 200, "maxNameChars": 100, "maxWatches": 50 } }
```

### 5.2 GET /watches (existing, + `summary`): the server list

`summary` is computed over **all** of the server's watches, also when `?url=` filters `watches`. Counts use the same status precedence as the dashboard (`apiStatus` = `siteStatus`).

`text` is the dashboard's head line in plain text:

- `alerts in #name` when every watch uses one channel, else `alerts in N channels`;
- zero counts are left out;
- with no watches: `"No sites yet."`.

```json
{
  "watches": [ { "id": 12, "name": "Hookedpad", "...": "ApiWatch fields" } ],
  "summary": {
    "total": 13, "limit": 50,
    "counts": { "up": 9, "down": 0, "blocked": 1, "paused": 1, "scanning": 2 },
    "channels": [ { "id": "1290000000000000001", "name": "scans", "watches": 13 } ],
    "text": "Watching 13 sites · alerts in #scans · 9 up · 1 blocked · 1 paused · 2 scanning"
  }
}
```

With `?url=` the response also keeps `watched: boolean`, as today.

### 5.3 GET /watches/:id (existing, + `card`, `limits`): the site card

```json
{
  "watch": { "id": 12, "name": "Hookedpad", "url": "https://hookedpad.com/", "host": "hookedpad.com", "channelId": "1290000000000000001",
             "intervalSec": 2, "paused": false, "status": "up",
             "features": { "deploy": true, "text": true, "pages": true, "subdomains": false, "files": true, "status": true, "codeIntel": true },
             "createdAt": 1759673000000, "lastCheckAt": 1759676541000, "lastChangeAt": 1759675012000, "pagesTracked": 17, "subdomains": 0 },
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
  "events": [ { "id": 5821, "watchId": 12, "watchName": "Hookedpad", "watchUrl": "https://hookedpad.com/", "kind": "deploy", "summary": "Hookedpad redeployed", "createdAt": 1759675012000 } ],
  "limits": { "minIntervalSec": 1, "maxIntervalSec": 3600, "sweepMinSec": 30, "sweepMaxSec": 86400, "maxPagesLimit": 1000,
              "maxPatterns": 25, "maxPatternChars": 300, "maxExtraUrls": 50, "maxScopeChars": 200, "maxNameChars": 100, "maxWatches": 50 }
}
```

Errors: `404 not_found`.

### 5.4 PATCH /watches/:id: Settings + Features + Pause

The ⚙️ Settings modal, the 🧩 Features toggles and Pause/Resume in one call. Every field is optional. Unknown top-level fields → `400 bad_request` (`field` = that key). Rules, scope and max pages are **not** here (they live on the 🚫 Rules modal): see §5.6.

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

| Field | Type | Effect |
|---|---|---|
| `name` | string | Rename (see §2) |
| `intervalSec` | number | Homepage / redeploy / uptime interval, clamped |
| `sweepSec` | number | Full page sweep, clamped |
| `channelId` | string | Move alerts to another channel of the token's server |
| `pingRoleId` | string \| null | Role to ping; `null` = no ping; the guild id = @everyone |
| `paused` | boolean | Same as `/pause` / `/resume` |
| `checks` | object of booleans | Partial; keys = `ToggleKey`. `maskNumbers` → `watch.maskNumbers`; the rest → `features` (merged by `store.updateWatch`) |

`200`:

```json
{
  "changed": ["intervalSec", "checks.text", "checks.maskNumbers"],
  "message": "Saved — interval 2s → 5s · Text changes off · Ignore numbers on",
  "warnings": [],
  "watch": { "id": 12, "intervalSec": 5, "...": "ApiWatch fields" },
  "card": { "id": 12, "...": "ApiCard fields" }
}
```

Messages and warnings:

- `message` parts, in this order:
  - `name → X`
  - `interval As → Bs`
  - `full sweep As → Bs`
  - `channel → #name` (the id when the name is unknown)
  - `ping → @Role` / `ping → @everyone` / `ping → none`
  - `paused` / `resumed`
  - `<Label> on|off` per check
- A body that changes nothing → `changed: []`, `message: "Nothing changed."`, nothing written, no `notifyUpdated`.
- `warnings`:
  - `"I'm missing Send Messages, Embed Links in #alerts — alerts can't be delivered until that's fixed."` when the new channel isn't postable.
  - `"Subdomains of hookedpad.com are already tracked by #7 Hookedpad app — new subdomains will be announced twice."` when `checks.subdomains` is switched on while another watch with the same `rootDomain` has it on. This mirrors the `prepareAdd` note.

Errors:

- `400`: `bad_request`, `invalid_interval`, `invalid_channel`, `invalid_role`
- `404`
- `409 name_taken`
- `429 rate_limited` (`manage`)
- `503 unavailable` (monitor not started, or the Discord cache is needed and not ready)

### 5.5 POST /watches/:id/pause and POST /watches/:id/resume

No body (an empty body or `{}` is fine). These are explicit desired states, like the panel's `panel:pause:<id>:<1|0>`, so a stale UI can't flip them the wrong way.

`200` is an `ApiManageResult`:

- `changed: ["paused"]`, `message: "Paused Hookedpad — no checks until you resume it."` / `"Resumed Hookedpad."`
- or `changed: []`, `message: "Hookedpad is already paused."` / `"… already running."`

Pausing or resuming never starts a check. Resume restarts the normal schedule through `onWatchUpdated` (staggered start).

Errors: `404`, `429` (`manage`), `503`.

### 5.6 GET /watches/:id/rules and PATCH /watches/:id/rules: the 🚫 Rules modal

`GET` → `200`:

```json
{
  "rules": { "ignorePatterns": ["Last updated.*"], "excludePatterns": ["/profile/*"], "extraUrls": ["https://hookedpad.com/secret"], "scopePath": null, "maxPages": 150 },
  "limits": { "...": "ApiLimits" }
}
```

`PATCH` body. Every field is optional. Each list takes **either** a full replacement array **or** an edit object:

```json
{
  "ignorePatterns": ["Last updated.*", "\\d+ online"],
  "excludePatterns": { "add": ["/blog/*"], "remove": ["/profile/*"] },
  "extraUrls": ["/secret", "https://hookedpad.com/hidden"],
  "scopePath": "/docs",
  "maxPages": 200
}
```

How lists are applied:

- **Replacement arrays**: entries are trimmed, empties dropped, duplicates removed keeping the first (the modal's `uniqueLines`).
- **Edit objects** `{ add?: string[], remove?: string[] }` are applied to the **current** list read in the same synchronous step:
  - `remove` first, by exact match after trimming. For `extraUrls`, matching is on the trimmed entry or its `resolvePageUrl` form. Unknown entries are ignored.
  - then `add`, appended in order and skipping duplicates.
  - This lets one-click "ignore this folder" never clobber a concurrent edit.
- The resulting list is validated as in §2. Only entries that weren't already in the current list go through `validatePattern`, as `validateNewPatterns` does. The first failure answers `400 invalid_pattern` with `field`, e.g. `"ignorePatterns[1]"` (index in the request array) or `"excludePatterns.add[0]"`.

`200` is an `ApiManageResult` plus `rules`:

```json
{
  "changed": ["excludePatterns", "scopePath"],
  "message": "Rules saved — 1 skipped URL pattern · scope /docs. Affected pages are re-baselined silently.",
  "warnings": ["/docs/* also matches the start URL."],
  "rules": { "ignorePatterns": [], "excludePatterns": ["/blog/*"], "extraUrls": [], "scopePath": "/docs", "maxPages": 150 },
  "watch": { "...": "ApiWatch" },
  "card": { "...": "ApiCard" }
}
```

Order of operations, exactly as `submitRules`:

1. Validate every field.
2. If `ignorePatterns` changed → `store.resetPageNoise(id)`.
3. Run `store.updateWatch(id, patch)` once.
4. Call `notifyUpdated()`.

Errors:

- `400`: `bad_request`, `invalid_pattern`, `invalid_url` (extra page not http(s), or a private host)
- `404`
- `429` (`manage`)
- `503`

### 5.7 GET /watches/:id/pages: the 📄 Pages view

Query:

- `list`: `tracked` (default; tracked pages) | `untracked` (known pages only) | `files`
- `limit`: 1..500, default 100
- `offset`: ≥ 0, default 0

The order is `store.listPages`'s (depth, first seen, url).

`200`:

```json
{
  "counts": { "tracked": 17, "maxPages": 150, "known": 18, "files": 0, "gone": 0, "dynamic": 1 },
  "list": "tracked",
  "total": 17,
  "pages": [
    { "url": "https://hookedpad.com/", "path": "/", "title": "Hookedpad", "kind": "page", "tracked": true, "gone": false, "dynamic": false,
      "status": 200, "source": "start", "depth": 0, "firstSeen": 1759673001000, "lastChecked": 1759676541000, "lastChanged": 1759675012000,
      "contentType": "text/html", "contentLength": null },
    { "url": "https://hookedpad.com/launch", "path": "/launch", "title": "Launch", "kind": "page", "tracked": true, "gone": false, "dynamic": true,
      "status": 200, "source": "link", "depth": 1, "firstSeen": 1759673002000, "lastChecked": 1759676500000, "lastChanged": null,
      "contentType": "text/html", "contentLength": null }
  ],
  "nextOffset": null
}
```

`nextOffset` is `offset + pages.length` when more remain, else `null`. The route is read-only: pages are added through `extraUrls` and removed through `excludePatterns` / `scopePath`, as in Discord.

### 5.8 GET /watches/:id/subdomains and PATCH /watches/:id/subdomains: the 🛰️ Subdomains view

`GET` query:

- `limit`: 1..1000, default 200
- `offset`: ≥ 0, default 0

The order matches `renderSubdomains`: live first, then by host.

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

`PATCH` body: `{ "enabled": boolean }`, the same switch as `checks.subdomains`. `200` is an `ApiManageResult`, with the duplicate-owner warning from §5.4. Errors: `400 bad_request`, `404`, `429` (`manage`), `503`.

### 5.9 POST /watches/:id/subdomains/watch: "watch this subdomain as its own site"

The `watchsub:` alert button, over the API. Body: `{ "host": "app.hookedpad.com" }`.

- **`201`** `{ "created": true, "watch": ApiWatch }`.
  - The new watch inherits the parent's channel, interval, sweep, max pages, ping role, ignore patterns and "Ignore numbers", with subdomains **off**.
  - Its name is `"<parent name ≤60> (<first label>)"`, made unique.
  - `createdBy` is `link:<label>`.
  - Its silent first scan runs in the background, exactly as for `POST /watches` (`status: "scanning"`, then the two Discord notices).
- **`200`** `{ "created": false, "watch": ApiWatch }` when the server already watches `https://<host>/`.
- Errors:
  - `400 invalid_url` (not under the parent's root domain, malformed, or private)
  - `404` (parent)
  - `409 limit_reached`
  - `429` (`add`, 30/hour)
  - `503`

### 5.10 GET /watches/:id/history: the 🕘 History view

Query:

- `limit`: 1..100, default 25
- `before`: event id; returns events with `id < before`

Newest first.

```json
{
  "events": [ { "id": 5821, "watchId": 12, "watchName": "Hookedpad", "watchUrl": "https://hookedpad.com/", "kind": "deploy", "summary": "Hookedpad redeployed", "createdAt": 1759675012000 } ],
  "nextBefore": null
}
```

`nextBefore` is the last event's id when `events.length === limit`, else `null`. History is pruned by age, as for `/events`.

### 5.11 GET /guild: pickers for the alert channel and ping role

Built from the gateway cache only, with no REST calls.

- Channels: text and announcement channels only, in Discord's display order (category position, then channel position).
- Roles: highest first, with @everyone last.
- `canPost` / `missing` use the same checks as `missingChannelPerms` (View Channel, Send Messages, Embed Links).

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

Errors: `503 unavailable` + `Retry-After: 5` when Discord isn't ready or the guild isn't cached.

### 5.12 Existing write routes: additions

- **`POST /watches`**:
  - Optional `channelId` (default: the token's channel) and `pingRoleId` (default: no ping), validated as in §2 and passed to `prepareAdd`.
  - Ignored when the site is already watched (`200 created:false`, existing settings untouched).
  - Supplying them may answer `400 invalid_channel` / `invalid_role` / `503 unavailable`.
- **`POST /watches/:id/check`**:
  - Optional `full: boolean` (default `false`), like `/watch check full:`. Non-boolean → `400 bad_request`.
  - A request that finds a check already running joins it, whatever its `full` value.
  - The 30 s per-site cooldown (`CHECK_COOLDOWN_SEC`) applies to both kinds.

---

## 6. Discord notices for API changes

Posted through the existing `announce()`, which truncates, never throws, uses no mentions, and escapes names with `nameOf()` / `escapeMarkdown(token.label)`.

| Change | Channel | Text |
|---|---|---|
| Pause (route or `PATCH paused:true`), only when it changed | watch channel | `⏸️ **<name>** was paused from **<label>**.` |
| Resume, only when it changed | watch channel | `▶️ **<name>** was resumed from **<label>**.` |
| `channelId` changed | **new** channel | `📢 Alerts for **<name>** (<url>) now post here — moved from <#old> by **<label>**.` |
| Subdomain watched | new watch's channel | the `POST /watches` pair: `➕ … was added from **<label>** — first scan running…`, then `✅ Now watching …` |

Other settings, check toggles and rule edits post nothing. That matches the panel, whose replies are ephemeral. They are audit-logged: `audit(token, 'update' | 'rules' | 'subdomains' | 'pause' | 'resume', { watchId, changes: [keys] })`. Log keys only, never the token.

---

## 7. Implementation rules (must follow)

From the bot's maintainer:

1. **Reuse the panel's code paths.** After any `store.updateWatch`, call `notifyUpdated(deps, watch)` → `monitor.onWatchUpdated`. That is what silently re-baselines when a check is switched on or the ignore / exclude / scope / mask rules change, so no burst of alerts follows.
2. **Ignore and exclude patterns go through `validatePattern`** (src/discord/commands.ts). It has the ReDoS guard and accepts path globs like `/profile/*` (exclude only). When ignore patterns change, call `store.resetPageNoise(id)`, as the Rules modal does.
3. **Feature patches merge in `store.updateWatch`**, so send a partial `{ features: { text: false } }`. The toggle keys are in `FEATURE_TOGGLES`. "Ignore numbers" maps to `watch.maskNumbers`, not to `features`.
4. **Limits.**
   - Clamp intervals to [`config.minIntervalSec` (1), 3600], using `minInterval(config)`.
   - Sweep is `SWEEP_MIN_SEC`..`SWEEP_MAX_SEC`.
   - Max pages is 1..`MAX_PAGES_LIMIT`.
   - Extra pages go through `resolvePageUrl`, capped at `MAX_EXTRA_URLS`.
5. **Server isolation.**
   - Every `:id` goes through `ownWatch(route, token)`, so another server's id gets `404`.
   - Keep the order 404 → 405 → auth → rate limit → body.
   - Unknown tokens answer `503 unavailable` (not `401`) while `deps.isRestoring()` is true.
   - `POST /watches/:id/check` has a 30 s per-site cooldown (`CHECK_COOLDOWN_SEC`), so pause, resume and settings changes must **not** trigger checks implicitly.
6. **`store.updateWatch` / `deleteWatch` emit `onWatchesChanged`**, which refreshes the pinned Discord dashboard and the watch-list backup. Don't call the panel host yourself.
7. **Update `INTEGRATION.md` and `HANDOFF-EXTENSION.md`** (its error table and the §4 message list) along with the code. See §8.
8. **Before handing off**, run `npx tsc --noEmit`, `npx vitest run` and `npm run build`. 1192 tests were green at `22be810`, per the maintainer; this contract run didn't re-run them, because the clone has no `node_modules`.

Also required by this contract:

9. **Validate everything, then write once.** No `await` between `ownWatch()` and `store.updateWatch()`. The body is read before dispatch; `validatePattern`, `resolvePageUrl`, `parseScope` and `deps.guildInfo` are synchronous. A failed request writes nothing, and a no-op request writes nothing and doesn't call `notifyUpdated`.
10. **Writes need the monitor.** Call `requireMonitor()` (`503`) before writing, and build `CommandDeps` as `addWatch` does: `{ store, config, log, monitor }`. Read routes work without it (`card.runtime = null`).
11. **Channels and roles only from the token's server**, via a new synchronous dep `guildInfo?: (guildId) => ApiGuildInfo | null`.
    - Implement it in src/index.ts from `bot.client.guilds.cache` and `guild.members.me` permissions, with no REST and no `channels.fetch`.
    - `null`, a throw, or an absent dep means "unknown": channel and role changes and `GET /guild` answer `503`, and the card shows `channelName: null, canPost: null`.
    - A channel id that isn't in that guild's list is `400 invalid_channel`, even if it exists elsewhere.
12. **SSRF guard.** Every resolved `extraUrls` host and every subdomain-watch host goes through `refusePrivate()` (`isPrivateTarget`) unless `config.allowPrivateNetwork`.
13. **Plain text out.**
    - Pass `UserError` messages through `plain()`.
    - Build API warnings and messages as plain text: no `<#id>`, no `**`. Use `#name`, or the raw id when the name is unknown.
    - Discord markdown is only used inside `announce()`.
14. **Strict request bodies.** Unknown top-level fields in `PATCH` bodies → `400 bad_request` with `field`. Wrong types → `400 bad_request`. Don't coerce strings to numbers.
15. **Rate limits.** Add the `manage` class (60 per 10 min) to `LIMITS` and apply it in `handle()` for the routes in §3.5. `POST …/subdomains/watch` uses `add`.
16. **Read paths must not load page text.**
    - Add `store.pageStats(watchId)`: one aggregate `SELECT SUM(kind='page' AND tracked=1), SUM(kind='page'), SUM(kind='file'), SUM(kind='page' AND tracked=1 AND gone=1), SUM(kind='page' AND tracked=1 AND dynamic=1) FROM pages WHERE watch_id=?`.
    - Add `store.listPageSummaries(watchId, { kind, tracked, limit, offset })` that never selects `text`.
    - Add `store.subdomainStats(watchId)` (count and `SUM(alive)`).
    - Add `store.listEvents(watchId, limit, beforeId?)` (optional third parameter, `id < beforeId`).
    - The Discord renderers may keep their current code.
17. **Factor, don't fork.**
    - Move the subdomain-watch creation in `handleButton` into an exported helper in commands.ts, e.g. `subdomainWatchInput(deps, parent, host, userId)`, used by both the button and the API. Its behaviour stays identical.
    - Build `card.checks` from `FEATURE_TOGGLES` / `toggleValue` and `card.statusLabel` from `siteStatus`.
    - Build `summary` counts from `apiStatus`.
18. **Additive only.** Don't change existing fields, codes or statuses. `ApiWatch` stays as is. CORS gains `PATCH`. `readJsonBody` runs for `POST` and `PATCH`. `ApiError` gains an optional `field` that `sendError` includes only when set.
19. **No implicit network work.** Only `POST /check`, `POST /watches` and `POST …/subdomains/watch` may start checks or scans.

---

## 8. Doc updates (part of the same change)

**INTEGRATION.md**

| Section | Update |
|---|---|
| Intro | Add "manage" to the feature list |
| §2 | A token can now also change settings, rules, checks and the alert channel of any watch in its server |
| §3 | Allow-Methods now includes `PATCH` |
| §4 | Add rows for `invalid_pattern`, `invalid_channel`, `invalid_role`, `name_taken`; document the optional `field`; extend `503` to "Discord not ready" |
| §5 | Add the `manage` bucket |
| §6 | Add table rows and one section each for §5.4–§5.11 of this contract. Add `summary`, `card`, `limits`, `POST /watches` `channelId`/`pingRoleId` and `/check` `full` to the existing sections |
| §7 | curl examples for `PATCH /watches/:id`, `PATCH …/rules` |
| §9 | Extra pages are SSRF-guarded; a token can now move alerts to any channel of its own server |

**HANDOFF-EXTENSION.md**

| Section | Update |
|---|---|
| §4 `swbErrorText` | Add `invalid_pattern`, `invalid_channel`, `invalid_role`, `name_taken` (show the server message) |
| §4 `swbBucket` | Add `manage` (PATCH and pause/resume routes). Key the per-site check cooldown as `check:<id>`, not `all`: today a cooldown `429` blocks every call for 30 s |
| §4 message table | Add the rows below |
| §8 error table | The same four codes, plus "Discord not ready → 503, retry" |
| Appendix | Error codes, route table, `ApiCard` / `ApiRules` / `ApiManageResult` / `ApiServerSummary` / `ApiPage` / `ApiSubdomain` / `ApiGuildInfo`, CORS line |

New §4 message rows:

| Message | Payload | Calls | `data` on success |
|---|---|---|---|
| `swb:list` | — | `GET /watches` | `{ watches, summary }` |
| `swb:card` | `{ id }` | `GET /watches/:id` | `{ watch, card, events, limits }` |
| `swb:update` | `{ id, patch }` | `PATCH /watches/:id` | `ApiManageResult` |
| `swb:pause` / `swb:resume` | `{ id }` | `POST …/pause` / `…/resume` | `ApiManageResult` |
| `swb:rules` | `{ id }` | `GET …/rules` | `{ rules, limits }` |
| `swb:setRules` | `{ id, patch }` | `PATCH …/rules` | `ApiManageResult & { rules }` |
| `swb:pages` | `{ id, list?, limit?, offset? }` | `GET …/pages` | pages response |
| `swb:subdomains` | `{ id, limit?, offset? }` | `GET …/subdomains` | subdomains response |
| `swb:setSubdomains` | `{ id, enabled }` | `PATCH …/subdomains` | `ApiManageResult` |
| `swb:watchSubdomain` | `{ id, host }` | `POST …/subdomains/watch` | `{ created, watch }` |
| `swb:history` | `{ id, limit?, before? }` | `GET …/history` | `{ events, nextBefore }` |
| `swb:guild` | — | `GET /guild` | `ApiGuildInfo` |
| `swb:check` (existing) | `+ full?` | | |
| `swb:add` (existing) | `+ channelId?, pingRoleId?` | | |

Rules for these messages:

- The worker forwards only the known keys of `patch`, re-validating their types.
- `id` goes through `idOf()`.
- The messages are answered only for the extension's own pages, as today.

---

## 9. Tests to add (test/link-api.test.ts or a new test/link-manage.test.ts, same harness)

- **Fake monitor**: gains `onWatchUpdated` (records calls) and `runtimeInfo`.
- **Fake `guildInfo`**: G1 has a text channel C1, an announcement channel C3, a voice channel, and roles R1 and @everyone (= G1).
- **Isolation**: every new route with a G2 watch id → `404`. `channelId` = a G2 channel → `400 invalid_channel`. The G2 role → `400 invalid_role`.
- **Pipeline**: unknown route → 404 before 405 before 401. `PATCH` on `/watches` → `405` with `Allow`. Restoring + unknown token → `503`.
- **`PATCH /watches/:id`**:
  - Each field: change, no-op (`changed: []`, no `updateWatch`, no `onWatchUpdated`), wrong type → 400, unknown field → 400.
  - `intervalSec: 0.4` → clamped to `minInterval`; `99999` → 3600. `sweepSec: 5` → 30.
  - `name` taken → `409 name_taken`; a number-only name → 400.
  - `checks.maskNumbers` writes `maskNumbers`, not `features`. A partial `checks` keeps the other features.
  - Exactly one `onWatchUpdated` per successful write.
  - `paused` announces; `channelId` announces in the new channel; other fields don't.
  - **No `checkNow` call from any manage route.**
- **pause/resume**: desired-state semantics, idempotent, `changed: []` the second time.
- **rules**:
  - Replacement vs `add`/`remove`.
  - `(a+)+` → `invalid_pattern` with `field`. A 26th pattern → `invalid_pattern`.
  - A glob `/profile/*` is accepted.
  - An existing (grandfathered) pattern isn't re-validated.
  - Ignore change → `resetPageNoise` called before `updateWatch`.
  - Extra `/secret` resolves against the watch URL; `http://127.0.0.1/x` → `invalid_url`; 51 extras → 400.
  - `scopePath` `""` / `null` / `"/docs/"` → `null` / `null` / `"/docs"`; `maxPages` 0 or 1001 → 400.
  - A failed request writes nothing.
- **pages / subdomains / history**: counts match `renderSiteInfo`; pagination (`nextOffset`, `nextBefore`); `list=files`; `watchedAs`; the read paths never select `text` (spy on the store, or check the SQL).
- **subdomains/watch**: inherits the parent's settings with subdomains off; duplicate → `200 created:false`; outside the root domain → 400; limit → 409; `add` bucket.
- **`GET /watches` `summary`**: counts and text (one channel vs several), computed over all watches with `?url=`.
- **Rate limits**: the 61st manage call in 10 min → `429` + `Retry-After`.
- **CORS**: Allow-Methods includes `PATCH`; `OPTIONS` → `204`.
- **Discord UI unchanged**: existing panel and `watchsub` tests still pass after the `handleButton` refactor.

---

## 10. Implementation notes (ext-manage)

Where the implementation had to choose, it chose this:

- **`guildInfo` dep.** It returns a `GuildSnapshot` (src/link/api.ts): `ApiGuildInfo` without `tokenChannelId` (the API adds it from the token), plus an optional `otherChannels` list of the other cached text-capable channels (threads, voice-channel chats). Alerts may already go there (a watch added with `/watch add` inside a thread), so the card shows their name and permissions instead of "channel not found"; they are never accepted as a new `channelId`. Built by `guildSnapshot()` in src/discord/guild-info.ts from the gateway cache, with `missingChannelPerms` (now exported).
- **Shared rules.** `validateNewPatterns` moved from panel.ts to commands.ts (same messages) and throws `ListEntryError` with the failing index; the extra-page loop of `submitRules` is now `resolveExtraPages()` in commands.ts. `checkWatchLimit` throws `WatchLimitError` (a `UserError`, same message). The `watchsub:` button and the API share `subdomainTarget()` + `addSubdomainWatch()`.
- **Extra pages SSRF guard** applies to entries that are not already in the watch's list: a private target added in Discord before stays (the bot's HTTP client still refuses to fetch it), so an API client is never blocked by an entry it didn't send.
- **No-ops need no Discord.** A `channelId` equal to the current one, or `pingRoleId` = the server id (@everyone) or `null`, is accepted without the guild cache.
- **Order in mutating handlers**: `404` (ownWatch) → `503` (monitor not started) → `400` / `409` validation → one write.
- **`503` + `Retry-After: 5`** now also on the existing "monitor not started" answers of `POST /watches` and `/check` (a header was added; status and code are unchanged).
- **pause / resume bodies** are strict too: only an empty body or `{}`.
- **`health.ts`** gained an optional `host` (the production server still listens on every interface); the local dev server binds 127.0.0.1.
- **Local dev server**: `npm run dev:link` (scripts/dev-link-server.ts, INTEGRATION.md §10).

