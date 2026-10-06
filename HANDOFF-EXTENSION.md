# Hand-off: connect **Arkham Dev Tags** to the "web" Site Watcher Discord bot

> Paste this whole file into the chat that maintains the Arkham Dev Tags Chrome MV3 extension. It is self-contained; you don't need the bot's repo.

## What to build

The extension gets a **Site Watcher panel** that works on any website:
- **🔎 Scan** shows what the site is built with: tech grouped by category, hosting, build id, subdomains, API endpoints and socials.
- **➕ Add to Discord tracker** adds the site to the bot's watch list. The bot then posts redeploys, text changes, new pages, new subdomains and downtime for that site in Discord, 24/7.
- When the site is already tracked, the panel shows **✅ Tracked** with a **Remove** button.
- **Manage** a tracked site like the Discord dashboard: its card (status, schedule, alerts, build, pages, subdomains, rules, checks, runtime), Check now, Pause / Resume, Settings (name, interval, full sweep, alert channel, ping role), the 8 check switches, Rules, Pages, Subdomains (with "watch this subdomain") and History, plus the server's site list. A token has the dashboard's rights for **its own server only** (it was created by a Manage Server member).
- Optionally, the extension mirrors the Discord alerts as desktop notifications.

The bot (separate repo, separate Railway service) already exposes an HTTPS JSON API for this, the **Link API v1**. **Nothing changes in your own backend or Railway service** (if you have one), and nothing changes in your release flow. The extension talks straight to the bot:

```
 Chrome (Arkham Dev Tags)                                   Railway: "web" bot                         Discord
 ┌───────────────────────────┐   HTTPS + Bearer swb_…   ┌────────────────────────────┐   posts   ┌──────────────┐
 │ content script panel      │ ── runtime messages ──▶  │ /api/v1  (Link API)        │ ────────▶ │ #alerts      │
 │ options page              │      service worker ───▶ │ watch list, scans, alerts  │           │ channel      │
 └───────────────────────────┘                          └────────────────────────────┘           └──────────────┘
```

**Auth:** a server admin runs `/link create label:<name>` in Discord. The bot privately shows an **API URL** and a **token** (`swb_…`, shown once). The user pastes both into the extension's options. Each token belongs to one Discord server and one alert channel.

**Never put a URL or token in the source, the manifest or the release zip.** They come only from the user and live only in `chrome.storage.local`.

---

## 1. Ground rules

1. **All API calls go through the background service worker.** Content scripts and the options page talk to it with `chrome.runtime.sendMessage` (message names in §4). This way:
   - the token never enters a web page's context;
   - the page's CORS origin and CSP don't matter;
   - there is one place for auth, timeouts and back-off.
2. **Only the service worker reads `swbToken`.** UIs never receive it back; the options page only writes it.
3. **Render API data with `textContent` / `append(string)`, never `innerHTML`.** Everything a scan returns comes from third-party websites. Only put `http:`/`https:` URLs into `href`.
4. **Tolerate unknown fields and enum values.** The API adds fields over time; it never breaks `/api/v1`.

## 2. manifest.json (merge into yours)

```jsonc
{
  "permissions": ["storage", "alarms", "activeTab", "scripting", "contextMenus"],
  "optional_permissions": ["notifications"],
  "optional_host_permissions": ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
  "commands": {
    "swb-toggle-panel": { "suggested_key": { "default": "Alt+Shift+S" }, "description": "Site Watcher: scan / track this site" }
  }
}
```

### Host permission for the API: two options

The API answers with `Access-Control-Allow-Origin: *` and handles CORS preflights. A `fetch` from the service worker therefore **works even without any host permission**; it is then an ordinary CORS request. With a host permission for the API origin, Chrome treats the calls as privileged extension requests, which saves the preflight round-trips. Choose one:

| Option | How | Pros | Cons |
|---|---|---|---|
| **A, recommended** | `optional_host_permissions` (above). When the user presses **Test connection**, call `chrome.permissions.request({ origins: [apiOrigin + "/*"] })`. | Least privilege: only the user's bot origin. No install-time warning. Works with a custom domain (`PUBLIC_URL`). If the user declines, everything still works via CORS. | One permission prompt. The call must happen inside the click handler, before any `await`. |
| B | Static `"host_permissions": ["https://*.up.railway.app/*"]` | No prompt and no code | Install-time warning covering all of `up.railway.app`, which is every Railway app, not just the bot. Breaks if the bot moves to a custom domain. |

If your manifest already has `"<all_urls>"` or `"https://*/*"` in `host_permissions`, you're covered; skip the request.

### How the panel opens: on-demand injection

`activeTab` + `scripting` inject the panel into the current tab only when the user asks. This works on every site without a broad host permission. The user can open it from:
- the context-menu item "🛰️ Site Watcher: scan / track this site",
- the keyboard shortcut Alt+Shift+S,
- a button in your toolbar popup, if you have one (opening the popup grants `activeTab`).

If you already inject a content script on `<all_urls>`, you can also show a small floating 🛰️ launcher there. Keep it opt-in.

## 3. Storage keys (`chrome.storage.local`)

| Key | Type | Written by | Meaning |
|---|---|---|---|
| `swbApiUrl` | string | options | Normalized base URL ending in `/api/v1`, no trailing slash |
| `swbToken` | string | options | `swb_` + 43 URL-safe chars. Never sent to UIs or logged. |
| `swbLink` | object | service worker | Last `/ping` result: `{ label, guildId, channelId, version, watches, checkedAt, broken }`. `broken: true` after a `401`. |
| `swbNotify` | boolean | options | Mirror alerts as notifications (default `false`) |
| `swbEventsCursor` | number | service worker | `nextSince` of the event feed |
| `swbEventsSyncedAt` | number | service worker | ms of the last full cursor re-sync |

Don't use `chrome.storage.sync` for the token. Unlinking removes all `swb*` keys.

## 4. Service worker: API client, router, triggers

Add a file, `swb-background.js`. Load it from your worker with `importScripts('swb-background.js')` (classic worker) or `import './swb-background.js'` (`"type": "module"` worker). Change the icon path to your own.

```js
// swb-background.js — Site Watcher (Discord tracker) client. All Link API traffic goes through here.
const SWB_ICON = 'icons/icon128.png'; // ← your icon
const SWB_KIND = { deploy: '🌐 Redeploy', text: '📝 Text changed', new_pages: '🆕 New page', removed_pages: '🗑️ Page removed',
  subdomain: '🛰️ New subdomain', subdomain_live: '🟣 Subdomain live', file: '📄 File changed', status: '🚦 Up / down', info: 'ℹ️ Note' };

class SwbError extends Error {
  constructor(code, message, status = 0, retryAfter = null) { super(message); this.code = code; this.status = status; this.retryAfter = retryAfter; }
}

function swbErrorText(e) {
  switch (e.code) {
    case 'not_linked': return 'Connect the Discord tracker first: extension options → Discord tracker.';
    case 'unauthorized': return 'This link was revoked, the token is wrong, or the bot left that Discord server. Re-link in Discord with /link create and paste the new token in the options.';
    case 'rate_limited': return `Slow down — try again in ${e.retryAfter ?? 60} s.`;
    case 'limit_reached': return 'That Discord server already watches its maximum number of sites. Remove one first.';
    case 'invalid_url': return "This page can't be scanned or tracked (it must be a public http(s) website).";
    case 'scan_failed': return e.message || 'The scan failed. Try again.'; // the bot's message already says so
    // Management validation: the bot's message says exactly what to fix (plain text).
    case 'invalid_pattern': case 'invalid_channel': case 'invalid_role': case 'name_taken': return e.message || 'The bot refused that change.';
    case 'timeout': case 'client_timeout': return 'The bot took too long to answer. Try again.';
    case 'offline': return 'You are offline.';
    case 'network': return "Can't reach the bot (it may be redeploying). Try again in a minute.";
    default: return e.message || 'Something went wrong.';
  }
}

// Per-bucket back-off after 429 (in memory; the server re-sends 429 if the worker restarted).
// The 30 s "checked too recently" 429 of POST /watches/:id/check concerns ONE site: key it check:<id>, never 'all',
// or a single cooldown would block every call for 30 s. Management writes have their own 60-per-10-min bucket.
const swbBackoff = new Map();
function swbBucket(method, path) {
  const check = /^\/watches\/(\d+)\/check$/.exec(path);
  if (method === 'POST' && check) return `check:${check[1]}`;
  if (method === 'POST' && path === '/scan') return 'scan';
  if (method === 'POST' && (path === '/watches' || /^\/watches\/\d+\/subdomains\/watch$/.test(path))) return 'add';
  if (method === 'PATCH' || method === 'DELETE' || (method === 'POST' && /^\/watches\/\d+\/(pause|resume)$/.test(path))) return 'manage';
  return 'all';
}

async function swbFetch(method, path, body, { timeoutMs = 20000 } = {}) {
  const { swbApiUrl: base, swbToken: token } = await chrome.storage.local.get(['swbApiUrl', 'swbToken']);
  if (!base || !token) throw new SwbError('not_linked', 'Not linked');
  const bucket = swbBucket(method, path);
  const until = Math.max(swbBackoff.get(bucket) || 0, swbBackoff.get('all') || 0);
  if (Date.now() < until) { const s = Math.ceil((until - Date.now()) / 1000); throw new SwbError('rate_limited', 'Rate limited', 429, s); }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(base + path, {
      method, cache: 'no-store', signal: ctrl.signal,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new SwbError('client_timeout', 'Timed out');
    throw new SwbError(navigator.onLine === false ? 'offline' : 'network', String(e.message || e));
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => null);
  if (res.ok) return data;
  const code = data?.error?.code || `http_${res.status}`;
  const message = data?.error?.message || `HTTP ${res.status}`;
  if (res.status === 429) {
    // Retry-After is exposed via Access-Control-Expose-Headers; default to 60 s if a proxy strips it.
    const s = Math.max(1, Number(res.headers.get('Retry-After')) || 60);
    swbBackoff.set(bucket, Date.now() + s * 1000); // per bucket: a site's check cooldown never blocks other calls
    throw new SwbError('rate_limited', message, 429, s);
  }
  if (res.status === 401) {
    const { swbLink } = await chrome.storage.local.get('swbLink');
    await chrome.storage.local.set({ swbLink: { ...(swbLink || {}), broken: true } });
  }
  throw new SwbError(code, message, res.status);
}

/** The site a message is about: msg.url (e.g. a token's website on GMGN) or the sender tab — reduced to its origin. */
function swbSite(msg, sender) {
  let u;
  try { u = new URL(msg.url || sender.tab?.url || ''); } catch { throw new SwbError('invalid_url', 'Bad URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SwbError('invalid_url', 'Not a website');
  return u.origin + '/';
}
function swbId(id) { const n = Number(id); if (!Number.isInteger(n) || n <= 0) throw new SwbError('bad_request', 'Bad watch id'); return n; }

/** Forward only known keys with the right JSON types (the bot re-validates everything; this keeps junk out of requests). */
const SWB_SETTINGS = { name: 'string', intervalSec: 'number', sweepSec: 'number', channelId: 'string', pingRoleId: 'string|null', paused: 'boolean' };
const SWB_CHECKS = ['deploy', 'text', 'pages', 'subdomains', 'files', 'status', 'codeIntel', 'maskNumbers'];
const swbIs = (v, t) => t.split('|').some((x) => (x === 'null' ? v === null : typeof v === x && (x !== 'number' || Number.isFinite(v))));
function swbSettingsPatch(p) {
  const out = {};
  for (const [k, t] of Object.entries(SWB_SETTINGS)) if (p && k in p) { if (!swbIs(p[k], t)) throw new SwbError('bad_request', `Bad ${k}`); out[k] = p[k]; }
  if (p && p.checks !== undefined) {
    out.checks = {};
    for (const k of SWB_CHECKS) if (k in p.checks) { if (typeof p.checks[k] !== 'boolean') throw new SwbError('bad_request', `Bad check ${k}`); out.checks[k] = p.checks[k]; }
  }
  return out;
}
function swbRulesPatch(p) {
  const out = {};
  const strings = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');
  for (const k of ['ignorePatterns', 'excludePatterns', 'extraUrls']) {
    if (!p || !(k in p)) continue;
    const v = p[k];
    if (strings(v)) out[k] = v;
    else if (v && typeof v === 'object' && (v.add === undefined || strings(v.add)) && (v.remove === undefined || strings(v.remove))) out[k] = { ...(v.add ? { add: v.add } : {}), ...(v.remove ? { remove: v.remove } : {}) };
    else throw new SwbError('bad_request', `Bad ${k}`);
  }
  if (p && 'scopePath' in p) { if (!swbIs(p.scopePath, 'string|null')) throw new SwbError('bad_request', 'Bad scopePath'); out.scopePath = p.scopePath; }
  if (p && 'maxPages' in p) { if (!Number.isInteger(p.maxPages)) throw new SwbError('bad_request', 'Bad maxPages'); out.maxPages = p.maxPages; }
  return out;
}
const swbQuery = (o) => { const q = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v)); const s = q.toString(); return s ? `?${s}` : ''; };

/** Highest event id on the bot (pages through the feed). */
async function swbLatestEventId() {
  let since = 0;
  for (let page = 0; page < 50; page++) {
    const { events, nextSince } = await swbFetch('GET', `/events?since=${since}&limit=200`);
    since = nextSince;
    if (events.length < 200) break;
  }
  return since;
}

/** Start the alert feed "from now" (no replay of history). */
async function swbResyncEvents() {
  const latest = await swbLatestEventId();
  await chrome.storage.local.set({ swbEventsCursor: latest, swbEventsSyncedAt: Date.now() });
  return { cursor: latest };
}

async function swbPollEvents() {
  const s = await chrome.storage.local.get(['swbNotify', 'swbEventsCursor', 'swbEventsSyncedAt', 'swbLink', 'swbToken']);
  if (!s.swbNotify || !s.swbToken || s.swbLink?.broken) return;
  if (typeof s.swbEventsCursor !== 'number') { await swbResyncEvents(); return; }
  let since = s.swbEventsCursor;
  let shown = 0, more = 0;
  for (let page = 0; page < 5; page++) {
    const { events, nextSince } = await swbFetch('GET', `/events?since=${since}&limit=50`);
    for (const e of events) {
      if (shown < 5) { swbNotifyEvent(e); shown++; } else more++;
    }
    since = nextSince;
    await chrome.storage.local.set({ swbEventsCursor: since });
    if (events.length < 50) break;
  }
  if (more) chrome.notifications.create(`swb-more-${since}`, { type: 'basic', iconUrl: SWB_ICON, title: 'Site Watcher', message: `…and ${more} more alerts — see Discord.` });
  // Once a day: if the bot's database was reset, event ids restart at 1 → adopt the lower id.
  if (shown === 0 && Date.now() - (s.swbEventsSyncedAt || 0) > 86_400_000) {
    const latest = await swbLatestEventId();
    await chrome.storage.local.set({ swbEventsSyncedAt: Date.now(), ...(latest < since ? { swbEventsCursor: latest } : {}) });
  }
}

function swbNotifyEvent(e) {
  const id = `swb-ev-${e.id}`;
  chrome.notifications.create(id, {
    type: 'basic', iconUrl: SWB_ICON,
    title: `${SWB_KIND[e.kind] || '🔔 Alert'} — ${e.watchName}`.slice(0, 120),
    message: String(e.summary || '').replace(/\*\*/g, '').slice(0, 250),
    contextMessage: (() => { try { return new URL(e.watchUrl).host; } catch { return ''; } })(),
  });
  chrome.storage.session.set({ [id]: e.watchUrl });
}

async function swbOpenPanel(tab) {
  if (!tab?.id) return;
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['swb-panel.js'] }); }
  catch { /* chrome://, Web Store, PDF viewer… can't be scripted */ }
}

async function swbHandle(msg, sender) {
  switch (msg.type) {
    case 'swb:ping': {
      const d = await swbFetch('GET', '/ping');
      await chrome.storage.local.set({ swbLink: { label: d.label, guildId: d.guild?.id, channelId: d.channelId, version: d.version, watches: d.watches, checkedAt: Date.now(), broken: false } });
      return d;
    }
    case 'swb:scan':   return swbFetch('POST', '/scan', { url: swbSite(msg, sender), subdomains: ['none', 'quick', 'full'].includes(msg.subdomains) ? msg.subdomains : 'quick' }, { timeoutMs: 60000 }); // the bot gives up at 50 s
    case 'swb:status': return swbFetch('GET', `/watches?url=${encodeURIComponent(swbSite(msg, sender))}`);
    case 'swb:add':    return swbFetch('POST', '/watches', { url: swbSite(msg, sender), ...(msg.name ? { name: String(msg.name).slice(0, 100) } : {}),
                          ...(typeof msg.channelId === 'string' ? { channelId: msg.channelId } : {}), ...(typeof msg.pingRoleId === 'string' ? { pingRoleId: msg.pingRoleId } : {}) });
    case 'swb:remove': return swbFetch('DELETE', `/watches/${swbId(msg.id)}`);
    case 'swb:check':  return swbFetch('POST', `/watches/${swbId(msg.id)}/check`, { full: msg.full === true }, { timeoutMs: 70000 });
    // Management (the Discord card and its buttons)
    case 'swb:list':   return swbFetch('GET', '/watches');
    case 'swb:card':   return swbFetch('GET', `/watches/${swbId(msg.id)}`);
    case 'swb:update': return swbFetch('PATCH', `/watches/${swbId(msg.id)}`, swbSettingsPatch(msg.patch));
    case 'swb:pause':  return swbFetch('POST', `/watches/${swbId(msg.id)}/pause`, {});
    case 'swb:resume': return swbFetch('POST', `/watches/${swbId(msg.id)}/resume`, {});
    case 'swb:rules':  return swbFetch('GET', `/watches/${swbId(msg.id)}/rules`);
    case 'swb:setRules': return swbFetch('PATCH', `/watches/${swbId(msg.id)}/rules`, swbRulesPatch(msg.patch));
    case 'swb:pages':  return swbFetch('GET', `/watches/${swbId(msg.id)}/pages${swbQuery({ list: ['tracked', 'untracked', 'files'].includes(msg.list) ? msg.list : undefined, limit: msg.limit, offset: msg.offset })}`);
    case 'swb:subdomains': return swbFetch('GET', `/watches/${swbId(msg.id)}/subdomains${swbQuery({ limit: msg.limit, offset: msg.offset })}`);
    case 'swb:setSubdomains': return swbFetch('PATCH', `/watches/${swbId(msg.id)}/subdomains`, { enabled: msg.enabled === true });
    case 'swb:watchSubdomain': return swbFetch('POST', `/watches/${swbId(msg.id)}/subdomains/watch`, { host: String(msg.host || '').slice(0, 253) });
    case 'swb:history': return swbFetch('GET', `/watches/${swbId(msg.id)}/history${swbQuery({ limit: msg.limit, before: msg.before })}`);
    case 'swb:guild':  return swbFetch('GET', '/guild');
    case 'swb:resyncEvents': return swbResyncEvents();
    case 'swb:openOptions':  return chrome.runtime.openOptionsPage();
    case 'swb:openPanel': { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return swbOpenPanel(tab); }
    default: throw new SwbError('unknown_message', `Unknown message ${msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('swb:')) return false; // not ours → other listeners
  if (sender.id !== chrome.runtime.id) return false;
  swbHandle(msg, sender).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: { code: err.code || 'error', message: swbErrorText(err), status: err.status || 0, retryAfter: err.retryAfter ?? null } }),
  );
  return true; // async response
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'swb-panel', title: '🛰️ Site Watcher: scan / track this site', contexts: ['page'] }, () => void chrome.runtime.lastError);
  chrome.alarms.create('swb-events', { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('swb-events', { periodInMinutes: 1 }));
chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === 'swb-panel') swbOpenPanel(tab); });
chrome.commands.onCommand.addListener((cmd, tab) => { if (cmd === 'swb-toggle-panel') swbOpenPanel(tab); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'swb-events') swbPollEvents().catch(() => {}); });
chrome.notifications?.onClicked.addListener(async (id) => {
  if (!id.startsWith('swb-ev-')) return;
  const { [id]: url } = await chrome.storage.session.get(id);
  if (url) chrome.tabs.create({ url });
  chrome.notifications.clear(id);
});
```

**Message protocol.** Every reply is `{ ok: true, data }` or `{ ok: false, error: { code, message, status, retryAfter } }`, where `message` is already user-friendly.

| Message | Payload | `data` on success |
|---|---|---|
| `swb:ping` | — | `PingResponse` (Appendix) |
| `swb:scan` | `{ url?, subdomains?: "none"\|"quick"\|"full" }` | `ScanResult` |
| `swb:status` | `{ url? }` | `{ watches: ApiWatch[], watched: boolean }` |
| `swb:add` | `{ url?, name?, channelId?, pingRoleId? }` | `{ created: boolean, watch: ApiWatch }` |
| `swb:remove` | `{ id }` | `{ deleted: true }` |
| `swb:check` | `{ id, full? }` | `{ alerts, kinds, error }` |
| `swb:list` | — | `{ watches: ApiWatch[], summary: ApiServerSummary }` (`GET /watches`) |
| `swb:card` | `{ id }` | `{ watch, card: ApiCard, events, limits }` (`GET /watches/:id`) |
| `swb:update` | `{ id, patch }` | `ApiManageResult` (`PATCH /watches/:id`) |
| `swb:pause` / `swb:resume` | `{ id }` | `ApiManageResult` (`POST …/pause` / `…/resume`) |
| `swb:rules` | `{ id }` | `{ rules: ApiRules, limits }` (`GET …/rules`) |
| `swb:setRules` | `{ id, patch }` | `ApiManageResult & { rules }` (`PATCH …/rules`) |
| `swb:pages` | `{ id, list?, limit?, offset? }` | pages response (`GET …/pages`) |
| `swb:subdomains` | `{ id, limit?, offset? }` | subdomains response (`GET …/subdomains`) |
| `swb:setSubdomains` | `{ id, enabled }` | `ApiManageResult` (`PATCH …/subdomains`) |
| `swb:watchSubdomain` | `{ id, host }` | `{ created, watch }` (`POST …/subdomains/watch`) |
| `swb:history` | `{ id, limit?, before? }` | `{ events, nextBefore }` (`GET …/history`) |
| `swb:guild` | — | `ApiGuildInfo` (`GET /guild`) |
| `swb:resyncEvents` | — | `{ cursor }` |
| `swb:openOptions`, `swb:openPanel` | — | — |

`url` defaults to the sender tab and is always reduced to its origin, so a scan or add of `https://hookedpad.com/app?x=1` uses `https://hookedpad.com/`.

Rules for the management messages:
- The worker forwards only the known keys of `patch`, re-checking their JSON types (`swbSettingsPatch`, `swbRulesPatch`); the bot validates everything again and answers `400` with `field` for anything it refuses.
- `id` always goes through `swbId()`.
- Like every `swb:*` message, they are answered only for the extension's own pages (`sender.id === chrome.runtime.id`); content scripts on websites must never be able to change Discord settings.
- Render `card`, page titles, subdomain probes and channel / role names as text: they come from websites and from Discord.

## 5. Options page: "Discord tracker" section

```html
<section id="swb">
  <h2>Discord tracker</h2>
  <p>Connect to the Site Watcher bot: in Discord run <code>/link create label:My Chrome</code> and paste what it shows.</p>
  <label>API URL <input id="swbApiUrl" type="url" placeholder="https://your-bot.up.railway.app/api/v1" spellcheck="false" autocomplete="off"></label>
  <label>Token <input id="swbToken" type="password" placeholder="swb_…" spellcheck="false" autocomplete="off"></label>
  <label><input id="swbNotify" type="checkbox"> Show desktop notifications for this server's alerts</label>
  <button id="swbTest" type="button">Save &amp; test connection</button>
  <button id="swbUnlink" type="button">Unlink</button>
  <p id="swbStatus" role="status"></p>
</section>
```

```js
// options.js (Discord tracker part)
const $ = (id) => document.getElementById(id);
const swbStatus = (text, kind = '') => { const p = $('swbStatus'); p.textContent = text; p.dataset.kind = kind; };
/** "bot.up.railway.app" / "https://bot.up.railway.app/" / ".../api/v1" → "https://bot.up.railway.app/api/v1". Throws on junk. */
function swbNormalizeBase(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) throw new Error('Paste the API URL from /link create.');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error("That doesn't look like a URL."); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) throw new Error('The API URL must start with https://');
  let path = u.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/api/v1')) path += '/api/v1';
  return u.origin + path;
}

(async function load() {
  const { swbApiUrl = '', swbToken = '', swbNotify = false, swbLink } = await chrome.storage.local.get(['swbApiUrl', 'swbToken', 'swbNotify', 'swbLink']);
  $('swbApiUrl').value = swbApiUrl;
  $('swbToken').placeholder = swbToken ? `saved (…${swbToken.slice(-4)}) — paste a new one to replace` : 'swb_…';
  $('swbNotify').checked = swbNotify;
  if (swbLink?.broken) swbStatus('⚠️ The bot rejected the token (revoked?). Re-link in Discord with /link create and paste the new token.', 'error');
  else if (swbLink?.label) swbStatus(`✅ Linked as "${swbLink.label}".`, 'ok');
})();

$('swbTest').addEventListener('click', () => {
  let base;
  try { base = swbNormalizeBase($('swbApiUrl').value); } catch (e) { swbStatus(e.message, 'error'); return; }
  const notify = $('swbNotify').checked;
  // Must run synchronously inside the click (user gesture) — before any await.
  const granted = chrome.permissions
    .request({ origins: [new URL(base).origin + '/*'], ...(notify ? { permissions: ['notifications'] } : {}) })
    .catch(() => false);
  (async () => {
    const typed = $('swbToken').value.trim();
    const { swbToken: saved } = await chrome.storage.local.get('swbToken');
    const token = typed || saved || '';
    if (!/^swb_[A-Za-z0-9_-]{20,}$/.test(token)) { swbStatus('Paste the token from /link create (it starts with swb_).', 'error'); return; }
    const ok = await granted;
    await chrome.storage.local.set({ swbApiUrl: base, swbToken: token, swbNotify: notify && ok });
    $('swbApiUrl').value = base;
    $('swbToken').value = '';
    swbStatus('Testing…');
    const r = await chrome.runtime.sendMessage({ type: 'swb:ping' });
    if (!r?.ok) { swbStatus(r?.error?.message || 'Failed.', 'error'); return; }
    const d = r.data;
    swbStatus(`✅ Connected as "${d.label}" — ${d.watches} sites tracked in that Discord server (bot ${d.version}).` +
      (ok ? '' : ' Permission declined: it still works, just a little slower.'), 'ok');
    if (notify && ok) chrome.runtime.sendMessage({ type: 'swb:resyncEvents' });
  })();
});

$('swbUnlink').addEventListener('click', async () => {
  const { swbApiUrl } = await chrome.storage.local.get('swbApiUrl');
  await chrome.storage.local.remove(['swbApiUrl', 'swbToken', 'swbLink', 'swbEventsCursor', 'swbEventsSyncedAt']);
  if (swbApiUrl) chrome.permissions.remove({ origins: [new URL(swbApiUrl).origin + '/*'] }).catch(() => {});
  $('swbApiUrl').value = ''; $('swbToken').placeholder = 'swb_…';
  swbStatus('Unlinked. Also run /link revoke in Discord so the old token stops working.');
});
```

Users paste the API URL in whatever form they have it: the bare domain, the domain with `/`, or the full `/api/v1` URL. Normalization handles all three.

## 6. The on-page panel (`swb-panel.js`, injected on demand)

Behaviour:
- **Open:** the panel sends `swb:status` and shows either **➕ Add to Discord tracker** or **✅ Tracked as <name>** (status `up` / `down` / `blocked` / `paused` / `scanning`) with **Remove**.
- **🔎 Scan** sends `swb:scan` (shows "Scanning… up to 25 s") and renders:
  - a header line: HTTP status, 🛡️ "bot protection — partial results" when `blocked`, the `server.server` header, the short `build.id`, `build.assets` bundles;
  - `error`, if any;
  - **tech grouped by category** (chips; `evidence` as tooltip; version appended);
  - subdomains (🟢 alive first, sources);
  - API endpoints and hosts in code (monospace, collapsible);
  - socials as links.
  
  `ScanResult.watched` also updates the tracked state. A **Deeper subdomain scan** link re-scans with `subdomains: "full"`.
- **➕ Add** sends `swb:add`:
  - `created: true`: "✅ Tracked — first scan running; alerts will appear in Discord".
  - `created: false`: "✅ Already tracked as <name>".
- **Remove** asks `confirm()`, sends `swb:remove`, then re-runs the status check.
- **Errors** show `error.message`:
  - `not_linked` / `unauthorized`: also show an **Open options** button (`swb:openOptions`).
  - `rate_limited`: disable the button and count down `retryAfter`.
  - other errors: keep the panel usable.
- Pressing the shortcut or menu item again toggles the panel. Close with ×.

```js
// swb-panel.js — injected with chrome.scripting.executeScript; idempotent (re-injection toggles).
(() => {
  if (window.__swbPanel) { window.__swbPanel.toggle(); return; }
  const CATS = [['framework', 'Framework'], ['hosting', 'Hosting'], ['cdn', 'CDN'], ['cms', 'CMS'], ['docs', 'Docs'], ['ui', 'UI'],
    ['auth', 'Auth / wallets'], ['web3', 'Web3'], ['payments', 'Payments'], ['analytics', 'Analytics'], ['monitoring', 'Monitoring'],
    ['support', 'Support'], ['security', 'Security'], ['fonts', 'Fonts'], ['other', 'Other']];
  const STATUS = { up: '🟢 up', down: '🔴 down', blocked: '🛡️ blocked by bot protection', paused: '⏸️ paused', scanning: '⏳ first scan running' };

  const hostEl = document.createElement('div');
  hostEl.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;';
  const root = hostEl.attachShadow({ mode: 'closed' });
  document.documentElement.append(hostEl);

  const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c)); // strings → text nodes
    return el;
  };
  const safeHref = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; } };
  const link = (u, text) => { const href = safeHref(u); return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : h('span', {}, text); };
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => ({ ok: false, error: { code: 'extension_reloaded', message: 'The extension was updated — reload this page.' } }));

  const style = h('style', {}, `
    .p{font:13px/1.4 system-ui,sans-serif;color:#e5e7eb;background:#111827;border:1px solid #374151;border-radius:10px;width:380px;max-height:70vh;overflow:auto;box-shadow:0 8px 30px #0008}
    header{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #374151;font-weight:600}
    .body{padding:8px 10px} .row{margin:4px 0} .muted{color:#9ca3af} .warn{color:#fbbf24} .err{color:#f87171}
    button{font:inherit;border:1px solid #4b5563;background:#1f2937;color:#e5e7eb;border-radius:6px;padding:4px 8px;cursor:pointer;margin:2px 4px 2px 0}
    button[disabled]{opacity:.5;cursor:default} .chip{display:inline-block;background:#1f2937;border:1px solid #374151;border-radius:999px;padding:0 6px;margin:2px}
    code{font:12px ui-monospace,monospace;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} a{color:#93c5fd}
    details{margin:6px 0} summary{cursor:pointer;font-weight:600}`);
  const tracker = h('div', { class: 'row' });
  const msgEl = h('div', { class: 'row' });
  const results = h('div');
  const scanBtn = h('button', { onclick: () => scan('quick') }, '🔎 Scan');
  const panel = h('div', { class: 'p' },
    h('header', {}, h('span', {}, '🛰️ Site Watcher · ', location.host), h('button', { onclick: () => toggle(false), title: 'Close' }, '×')),
    h('div', { class: 'body' }, tracker, h('div', { class: 'row' }, scanBtn), msgEl, results));
  root.append(style, panel);

  function toggle(show = hostEl.style.display === 'none') { hostEl.style.display = show ? '' : 'none'; if (show) refresh(); }
  window.__swbPanel = { toggle };

  function showError(err, btn) {
    msgEl.replaceChildren(h('span', { class: 'err' }, '⚠️ ', err?.message || 'Something went wrong.'));
    if (err?.code === 'not_linked' || err?.code === 'unauthorized') msgEl.append(' ', h('button', { onclick: () => send({ type: 'swb:openOptions' }) }, 'Open options'));
    if (err?.code === 'rate_limited' && btn) {
      let left = err.retryAfter || 60; btn.disabled = true;
      const t = setInterval(() => { left -= 1; if (left <= 0) { clearInterval(t); btn.disabled = false; msgEl.replaceChildren(); } }, 1000);
    }
  }

  function renderTracked(watch, note) {
    if (!watch) {
      const add = h('button', { onclick: async () => {
        add.disabled = true; msgEl.replaceChildren(h('span', { class: 'muted' }, 'Adding…'));
        const r = await send({ type: 'swb:add', url: location.href });
        add.disabled = false; msgEl.replaceChildren();
        if (!r.ok) return showError(r.error, add);
        renderTracked(r.data.watch, r.data.created ? '✅ Tracked — first scan running; alerts will appear in Discord.' : `✅ Already tracked as ${r.data.watch.name}.`);
      } }, '➕ Add to Discord tracker');
      tracker.replaceChildren(add);
      return;
    }
    const remove = h('button', { onclick: async () => {
      if (!confirm(`Stop watching ${watch.name} in Discord?`)) return;
      remove.disabled = true;
      const r = await send({ type: 'swb:remove', id: watch.id });
      if (!r.ok) { remove.disabled = false; return showError(r.error, remove); }
      renderTracked(null); msgEl.replaceChildren(h('span', { class: 'muted' }, `Removed ${watch.name}.`));
    } }, 'Remove');
    tracker.replaceChildren(h('span', {}, '✅ Tracked as ', h('b', {}, watch.name), watch.status ? [' · ', STATUS[watch.status] || watch.status] : null, ' '), remove);
    if (note) msgEl.replaceChildren(h('span', {}, note));
  }

  async function refresh() {
    tracker.replaceChildren(h('span', { class: 'muted' }, 'Checking the tracker…'));
    const r = await send({ type: 'swb:status', url: location.href });
    if (!r.ok) { tracker.replaceChildren(); return showError(r.error); }
    renderTracked(r.data.watched ? r.data.watches[0] : null);
  }

  const section = (title, items, open = items.length <= 8) => (items.length ? h('details', { open }, h('summary', {}, `${title} (${items.length})`), ...items) : null);

  async function scan(mode) {
    scanBtn.disabled = true; msgEl.replaceChildren(h('span', { class: 'muted' }, 'Scanning… (up to 25 s)')); results.replaceChildren();
    const r = await send({ type: 'swb:scan', url: location.href, subdomains: mode });
    scanBtn.disabled = false; msgEl.replaceChildren();
    if (!r.ok) return showError(r.error, scanBtn);
    const s = r.data;
    const head = [s.status ? `HTTP ${s.status}` : 'unreachable', s.server?.server, s.build?.id && `build ${s.build.id.slice(0, 12)}`, s.build?.assets && `${s.build.assets} bundles`, s.build?.generator].filter(Boolean).join(' · ');
    const groups = new Map();
    const known = new Set(CATS.map(([c]) => c));
    for (const t of s.tech || []) { const c = known.has(t.category) ? t.category : 'other'; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(t); }
    const tech = CATS.filter(([c]) => groups.has(c)).map(([c, label]) =>
      h('div', { class: 'row' }, h('b', {}, label, ': '), ...groups.get(c).map((t) => h('span', { class: 'chip', title: t.evidence }, t.version ? `${t.name} ${t.version}` : t.name))));
    const subs = [...(s.subdomains || [])].sort((a, b) => Number(b.alive) - Number(a.alive) || a.host.localeCompare(b.host))
      .map((d) => h('div', {}, d.alive ? '🟢 ' : '⚪ ', link(`https://${d.host}/`, d.host), h('span', { class: 'muted' }, ` ${d.sources.join(', ')}`)));
    results.replaceChildren(...[
      h('div', { class: 'row muted' }, head),
      s.blocked ? h('div', { class: 'row warn' }, '🛡️ The site shows bots a challenge — results are partial.') : null,
      s.error ? h('div', { class: 'row warn' }, s.error) : null,
      section('Tech', tech.length ? tech : [h('span', { class: 'muted' }, 'Nothing detected')], true),
      section('Subdomains', subs),
      mode !== 'full' ? h('button', { onclick: () => scan('full') }, 'Deeper subdomain scan') : null,
      section('API endpoints', (s.apiEndpoints || []).map((p) => h('code', { title: p }, p))),
      section('Hosts in code', (s.codeHosts || []).map((x) => h('code', { title: x }, x))),
      section('Socials', (s.socials || []).map((x) => h('div', {}, `${x.kind}: `, link(x.url, x.url))), true),
      h('div', { class: 'row muted' }, `Scanned in ${((s.elapsedMs || 0) / 1000).toFixed(1)} s`),
    ].filter(Boolean)); // replaceChildren(null) would print "null"
    if (s.watched) renderTracked(s.watched); // { id, name, url } — enough for Remove
  }

  refresh();
})();
```

Note: `ScanResult.watched` has only `{ id, name, url }`. That's enough for **Remove**; call `refresh()` if you also want the live status.

**Optional GMGN/Axiom tie-in:** your existing content script already runs on token pages. You can add a "🛰️ Track website" action next to a token's website link that sends `{ type: 'swb:add', url: <that link> }`, or `swb:scan` for the same link. Always show the exact URL before adding.

## 7. Alert mirroring (optional, off by default)

The code in §4 handles this:
- `chrome.alarms` fires every minute (MV3 service workers can't keep `setInterval` alive).
- When `swbNotify` is on and the link isn't broken, the worker calls `GET /events?since=<swbEventsCursor>&limit=50` (up to 5 pages).
- It shows up to 5 `chrome.notifications` per poll, plus an "…and N more" one.
- It stores `nextSince`. Clicking a notification opens the site.
- **The first sync never replays history:** `swb:resyncEvents` (sent after Test connection) fast-forwards the cursor.
- A `401` stops polling (`swbLink.broken`) until the user re-links.
- Polling once a minute uses 1 of the 120 requests/minute the token is allowed.

## 8. Error handling

| What happens | API | Show / do |
|---|---|---|
| Not configured | — (`not_linked`) | "Connect the Discord tracker first" + **Open options** |
| Token revoked / wrong, or the bot left that server | `401 unauthorized` | "Re-link in Discord with /link create" + **Open options**; set `swbLink.broken`; stop polling |
| Too many requests | `429 rate_limited` + `Retry-After` | Disable that button and count down `retryAfter` (default 60 s). Back-off is per bucket: scan / add / everything. |
| Server at its site limit | `409 limit_reached` | Show the message |
| A management change was refused | `400 invalid_pattern` / `invalid_channel` / `invalid_role`, `409 name_taken` (`error.field` names the input) | Show the bot's message next to that input; nothing was saved |
| Discord not ready yet (channel / role changes, `GET /guild`) | `503 unavailable` + `Retry-After: 5` | "Discord isn't ready yet — try again in a few seconds"; retry |
| Bot still starting (also right after a redeploy, while it restores links: even a valid token can get this for up to a few minutes) | `503 unavailable` + `Retry-After` | "The bot is starting — try again in a few seconds" (the default branch shows the server's message). **Never** set `swbLink.broken` on a 503; keep polling. |
| Site checked again within 30 s | `429 rate_limited` + `Retry-After` | Disable **Check now** for **that site** and count down (bucket `check:<id>`; never block other calls) |
| Too many management changes | `429 rate_limited` + `Retry-After` | 60 changes per 10 min: disable the management controls and count down (bucket `manage`) |
| Not a public website (including `localhost`, LAN IPs, `*.internal`) | `400 invalid_url` | "This page can't be scanned or tracked" |
| Scan couldn't run, or still running after 50 s | `502 scan_failed` | Message + allow retry |
| Unexpected error on the bot | `500 internal_error` | Generic message + allow retry |
| Check took > 60 s | `504 timeout` | "Still running — alerts will appear in Discord" |
| Offline / bot redeploying / DNS | fetch throws (`offline` / `network`) | "Can't reach the bot — try again in a minute"; keep the UI usable |
| Extension reloaded under an open tab | `sendMessage` rejects | "Reload this page" |

## 9. Release flow: unchanged

- Bump `version` in `manifest.json`, build the zip, publish the GitHub Release and update `latest.json` exactly as you do today.
- The zip contains **no** API URL and **no** token. Each user configures their own in the options.
- The new permissions are `activeTab`, `scripting`, `contextMenus` and `alarms`; `notifications` and the API host are optional, requested at runtime. Chrome applies them when the user loads or reloads the new version. Mention them in the release notes.

## 10. Test plan

1. Discord: `/link create label:Test` → copy the API URL and token. If the reply says the bot has **no public domain**, the bot owner must first do Railway → service → Settings → Networking → Generate Domain and redeploy.
2. Options → Discord tracker → paste → **Save & test connection** → "✅ Connected as "Test" — N sites…".
3. Open `https://unpeg.io` → Alt+Shift+S → the panel shows ➕ or ✅. Press **🔎 Scan** → tech, subdomains, endpoints and socials render, with no HTML injection (try a site whose title contains `<b>`).
4. **➕ Add** → Discord shows "➕ **Unpeg** (https://unpeg.io/) was added from **Test** — first scan running…" and then "✅ Now watching…". Reopen the panel → ✅ Tracked.
5. **Remove** → Discord shows "➖ **Unpeg** was removed from **Test**".
6. Press Scan more than 20 times in 10 minutes → a countdown appears; no request is sent until it ends.
7. `/link revoke label:Test` → the next action says to re-link; polling stops.
8. Turn Wi-Fi off → "Can't reach the bot" / "You are offline".
9. Grep the built zip for `swb_` and `railway.app` → no hits.

---

## Appendix: Link API v1 reference

**Base URL:** `https://<bot domain>/api/v1`, exactly as shown by `/link create` (example: `https://site-watcher-production.up.railway.app/api/v1`).

**Auth:** `Authorization: Bearer swb_…` (or `X-Link-Token: swb_…`). Missing, unknown or revoked, or the bot is no longer in the token's server → `401 unauthorized`.

**Rights:** a token can read and change every watch of **its own** server (it was created by a Manage Server member) and nothing of other servers: their watch ids are `404`, their channels / roles `400 invalid_channel` / `invalid_role`. Changes need the creator to **still** have Manage Server (re-checked, cached 5 min): once they lost it, left or were removed, every management write is `403 forbidden` (reads and Check now still work); show the message and point to a new `/link create`. Alert channels are limited to the ones the creator can see: `GET /guild` lists only those, and any other `channelId` is `400 invalid_channel`.

**CORS:** every response sends `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Authorization, Content-Type, X-Link-Token`, `Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS`, `Access-Control-Max-Age: 600` and `Access-Control-Expose-Headers: Retry-After`. `OPTIONS` → `204` without auth.

**Limits per token:** 120 requests/min overall; `POST /scan` 20 per 10 min; `POST /watches` and `POST /watches/:id/subdomains/watch` together 30 per hour; management writes (`PATCH /watches/:id`, `DELETE /watches/:id`, `POST …/pause|resume`, `PATCH …/rules`, `PATCH …/subdomains`) 60 per 10 min. Exceeding one returns `429 rate_limited` + `Retry-After` (seconds). `POST /watches/:id/check` also has a 30 s cooldown **per site**. At most 3 scans run on the bot at once; beyond that `POST /scan` also gets `429 rate_limited`, with `Retry-After: 5`.

**Bodies:** JSON objects up to 32 KB (`413 too_large`), for `POST` and `PATCH`; invalid JSON returns `400 bad_request`; a body that takes over 15 s to arrive returns `408 timeout`. Every response is JSON. `PATCH` bodies are strict: unknown fields and wrong types are `400 bad_request`.

**Errors:** `{ "error": { "code": "snake_case", "message": "human text", "field"?: "json.path" } }` (`field` only on some validation errors). Codes:

| Code | Status |
|---|---|
| `bad_request`, `invalid_url` (also private / internal hosts), `invalid_interval`, `invalid_pattern`, `invalid_channel`, `invalid_role` | 400 |
| `unauthorized` | 401 |
| `forbidden` (the token's creator lost Manage Server; management writes only) | 403 |
| `not_found` | 404 |
| `method_not_allowed` | 405 |
| `timeout` | 408 (slow request body) or 504 (check over 60 s) |
| `limit_reached`, `name_taken` | 409 |
| `too_large` | 413 |
| `rate_limited` | 429 |
| `internal_error` | 500 |
| `scan_failed` | 502 |
| `unavailable` | 503 (bot starting: every write and `/check`; Discord not ready: channel / role changes and `/guild`; `Retry-After`) |

Treat unknown codes as generic.

| Method | Path | Body | Success |
|---|---|---|---|
| GET | `/ping` | — | `200 PingResponse` |
| POST | `/scan` | `{ url, subdomains?: "none"\|"quick"\|"full" }` (default `quick`) | `200 ScanResult` (about 25 s budget, cached 60 s; `502` after 50 s) |
| GET | `/watches[?url=<u>]` | — | `200 { watches: ApiWatch[], summary: ApiServerSummary }`; with `?url=`: only watches matching u's normalized URL or host, plus `watched: boolean` (the summary still covers every watch) |
| POST | `/watches` | `{ url, name?, intervalSec?, features?: { deploy?, text?, pages?, subdomains?, files?, status?, codeIntel? }, channelId?, pingRoleId? }` | `201 { created: true, watch }` (first scan runs in the background, `status: "scanning"`); `200 { created: false, watch }` if already watched; `409 limit_reached`; `503 unavailable` |
| GET | `/watches/:id` | — | `200 { watch: ApiWatch, card: ApiCard, events: ApiEvent[] (20 newest), limits: ApiLimits }`; `404` if not in this server |
| PATCH | `/watches/:id` | `{ name?, intervalSec?, sweepSec?, channelId?, pingRoleId?, paused?, checks?: { [ToggleKey]: boolean } }` | `200 ApiManageResult`; `409 name_taken` |
| DELETE | `/watches/:id` | — | `200 { deleted: true }` |
| POST | `/watches/:id/check` | `{ full?: boolean }` | `200 { alerts: number, kinds: string[], error: string \| null }`; `504 timeout` after 60 s; `503 unavailable` |
| POST | `/watches/:id/pause`, `/watches/:id/resume` | — | `200 ApiManageResult` (`changed: []` when already in that state) |
| GET | `/watches/:id/rules` | — | `200 { rules: ApiRules, limits: ApiLimits }` |
| PATCH | `/watches/:id/rules` | `{ ignorePatterns?, excludePatterns?, extraUrls? (each string[] or { add?, remove? }), scopePath?: string \| null, maxPages? }` | `200 ApiManageResult & { rules: ApiRules }` |
| GET | `/watches/:id/pages?list=tracked\|untracked\|files&limit=1..500&offset=n` | — | `200 { counts, list, total, pages: ApiPage[], nextOffset: number \| null }` |
| GET | `/watches/:id/subdomains?limit=1..1000&offset=n` | — | `200 { enabled, rootDomain, known, live, total, subdomains: ApiSubdomain[], nextOffset }` |
| PATCH | `/watches/:id/subdomains` | `{ enabled: boolean }` | `200 ApiManageResult` |
| POST | `/watches/:id/subdomains/watch` | `{ host }` | `201 { created: true, watch }` / `200 { created: false, watch }`; `400 invalid_url`; `409 limit_reached` |
| GET | `/watches/:id/history?limit=1..100&before=<event id>` | — | `200 { events: ApiEvent[] (newest first), nextBefore: number \| null }` |
| GET | `/guild` | — | `200 ApiGuildInfo`; `503 unavailable` while Discord isn't ready |
| GET | `/events?since=<id>&limit=<1..200, default 50>` | — | `200 { events: ApiEvent[] (oldest first, id > since), nextSince: number }` |

```ts
interface PingResponse {
  ok: true; bot: 'site-watcher'; version: string; apiVersion: 1;
  guild: { id: string }; channelId: string; label: string; watches: number;
  limits: ApiLimits;
}

type TechCategory = 'framework' | 'hosting' | 'cdn' | 'cms' | 'docs' | 'ui' | 'analytics' | 'monitoring'
  | 'auth' | 'payments' | 'support' | 'web3' | 'fonts' | 'security' | 'other'; // may grow

interface TechHit { name: string; category: TechCategory; version: string | null; evidence: string }

interface ScanResult {
  url: string; finalUrl: string; host: string; rootDomain: string;
  status: number;            // homepage HTTP status, 0 = unreachable
  blocked: boolean;          // bot-protection challenge → partial results
  error: string | null;
  title: string | null;       // ≤ 300 chars
  description: string | null; // ≤ 500 chars
  ogImage: string | null;     // absolute http(s) URL or null
  tech: TechHit[];           // deduped, ordered by category then name
  build: { id: string | null; assets: number; generator: string | null };
  server: { server: string | null; poweredBy: string | null; ips: string[] };
  apiEndpoints: string[];    // "/api/launches/count"
  codeHosts: string[];       // "api.unpeg.io", "mainnet.helius-rpc.com"
  subdomains: Array<{ host: string; sources: string[] /* dns|ct|code|link */; alive: boolean }>;
  socials: Array<{ kind: string /* x, telegram, discord, github, docs, medium, … */; url: string }>;
  links: { internal: number; external: number };
  watched: { id: number; name: string; url: string } | null; // already tracked by this Discord server
  scannedAt: string;         // ISO-8601
  elapsedMs: number;
}

interface ApiWatch {
  id: number; name: string; url: string; host: string; channelId: string;
  intervalSec: number; paused: boolean;
  status: string;            // "up" | "down" | "blocked" | "paused" | "scanning"
  features: Record<string, boolean>; // deploy, text, pages, subdomains, files, status, codeIntel
  createdAt: number; lastCheckAt: number | null; lastChangeAt: number | null; // epoch ms
  pagesTracked: number; subdomains: number;
}

interface ApiEvent {
  id: number; watchId: number; watchName: string; watchUrl: string;
  kind: string;              // deploy | text | new_pages | removed_pages | subdomain | subdomain_live | file | status | info
  summary: string;           // plain text (may contain **bold**) — render as text
  createdAt: number;         // epoch ms
}

type ToggleKey = 'deploy' | 'text' | 'pages' | 'subdomains' | 'files' | 'status' | 'codeIntel' | 'maskNumbers';

interface ApiLimits {
  minIntervalSec: number; maxIntervalSec: number; sweepMinSec: number; sweepMaxSec: number; maxPagesLimit: number;
  maxPatterns: number; maxPatternChars: number; maxExtraUrls: number; maxScopeChars: number; maxNameChars: number;
  maxWatches: number;        // 0 = unlimited
}

/** The Discord site card as data. Every string is plain text from a website or Discord: render it as text. */
interface ApiCard {
  id: number; name: string; url: string; host: string; rootDomain: string;
  status: string;            // as ApiWatch.status
  statusLabel: string;       // "Up" | "Down" | "Paused" | "First scan pending" | "Blocked by the site’s bot protection"
  downSince: number | null; downError: string | null;   // only while down and not paused
  lastCheckAt: number | null; lastChangeAt: number | null;
  schedule: { intervalSec: number; sweepSec: number };
  alerts: {
    channelId: string; channelName: string | null;   // null: Discord's cache doesn't know it
    canPost: boolean | null;                          // null: unknown (Discord not ready)
    missing: string[];                                // "View Channel" | "Send Messages" | "Embed Links" | "channel not found"
    ping: 'none' | 'role' | 'everyone'; pingRoleId: string | null; pingRoleName: string | null;
  };
  build: { id: string | null; bundles: number; generator: string | null } | null;   // null: "unknown"
  pages: { tracked: number; maxPages: number; known: number; files: number; gone: number; dynamic: number };
  subdomains: { enabled: boolean; known: number; live: number };
  rules: { ignorePatterns: number; excludePatterns: number; extraUrls: number; scopePath: string | null };
  checks: Array<{ key: ToggleKey; label: string; emoji: string; hint: string; on: boolean }>;   // dashboard order
  runtime: { running: boolean; baselineRunning: boolean; lastTickAt: number | null; lastTickMs: number | null; nextTickAt: number | null } | null;
  lastError: string | null;
  warnings: string[];        // plain text: delivery problem, shared CT quota
  createdAt: number;
}

interface ApiRules { ignorePatterns: string[]; excludePatterns: string[]; extraUrls: string[]; scopePath: string | null; maxPages: number }

interface ApiManageResult {
  changed: string[];         // [] = nothing changed, nothing written
  message: string;           // "Saved — interval 2s → 5s · Text changes off" | "Nothing changed."
  warnings: string[];
  watch: ApiWatch; card: ApiCard;
}

interface ApiServerSummary {
  total: number; limit: number;   // limit 0 = unlimited
  counts: { up: number; down: number; blocked: number; paused: number; scanning: number };
  channels: Array<{ id: string; name: string | null; watches: number }>;   // most watches first
  text: string;              // "Watching 13 sites · alerts in #scans · 9 up · 1 blocked · 1 paused · 2 scanning"
}

interface ApiPage {
  url: string; path: string; title: string | null; kind: 'page' | 'file'; tracked: boolean; gone: boolean; dynamic: boolean;
  status: number | null; source: string; depth: number; firstSeen: number; lastChecked: number | null; lastChanged: number | null;
  contentType: string | null; contentLength: number | null;
}

interface ApiSubdomain {
  host: string; sources: string[]; alive: boolean; firstSeen: number; lastSeen: number;
  dns: { a: string[]; aaaa: string[]; cname: string[] } | null;
  http: { status: number; title: string | null; finalUrl: string | null; server: string | null } | null;
  watchedAs: { id: number; name: string } | null;   // this server already watches https://<host>/
}

interface ApiGuildInfo {
  guild: { id: string; name: string }; tokenChannelId: string;
  channels: Array<{ id: string; name: string; type: 'text' | 'announcement'; category: string | null; canPost: boolean; missing: string[] }>;
  roles: Array<{ id: string; name: string; everyone: boolean; managed: boolean; color: number }>;   // highest first, @everyone last
}
```

Example `POST /scan` → `200`, abbreviated:

```json
{
  "url": "https://unpeg.io/", "finalUrl": "https://unpeg.io/", "host": "unpeg.io", "rootDomain": "unpeg.io",
  "status": 200, "blocked": false, "error": null, "title": "Unpeg", "description": null, "ogImage": null,
  "tech": [
    { "name": "Next.js", "category": "framework", "version": "14.2.5", "evidence": "__NEXT_DATA__ / _next/static" },
    { "name": "Vercel", "category": "hosting", "version": null, "evidence": "x-vercel-id header" },
    { "name": "Privy", "category": "auth", "version": null, "evidence": "script auth.privy.io" }
  ],
  "build": { "id": "KU79xF2pQe8vZ1", "assets": 23, "generator": null },
  "server": { "server": "Vercel", "poweredBy": "Next.js", "ips": ["76.76.21.21"] },
  "apiEndpoints": ["/api/launches/count"], "codeHosts": ["api.unpeg.io"],
  "subdomains": [{ "host": "app.unpeg.io", "sources": ["dns", "code"], "alive": true }],
  "socials": [{ "kind": "x", "url": "https://x.com/unpeg_io" }],
  "links": { "internal": 18, "external": 7 }, "watched": null,
  "scannedAt": "2026-10-05T14:03:11.402Z", "elapsedMs": 3810
}
```

Example `POST /watches` with `{ "url": "https://hookedpad.com" }` → `201`:

```json
{ "created": true, "watch": { "id": 12, "name": "Hookedpad", "url": "https://hookedpad.com/", "host": "hookedpad.com",
  "channelId": "1290000000000000001", "intervalSec": 2, "paused": false, "status": "scanning",
  "features": { "deploy": true, "text": true, "pages": true, "subdomains": true, "files": true, "status": true, "codeIntel": true },
  "createdAt": 1759673000000, "lastCheckAt": null, "lastChangeAt": null, "pagesTracked": 0, "subdomains": 0 } }
```

**Versioning:** `/api/v1` only gets additive changes: new fields, new endpoints, new enum values. Anything breaking ships as `/api/v2`, and v1 keeps running.

**Local test server:** `PORT=8721 npm run dev:link` in the bot's repo serves this API on `http://127.0.0.1:8721/api/v1` without Discord (token `swb_dev-local-link-token-for-extension-tests000`, seeded watches, a local fixture site). See INTEGRATION.md §10.
