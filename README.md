# Site Watcher Bot

A Discord bot that watches websites 24/7 and posts in your server the moment something changes:

| Alert | What it means | How it's detected |
|---|---|---|
| 🌐 **redeployed** | New site code went live | Hashed JS/CSS bundle URLs or the framework build id (Next.js, Nuxt, Gatsby, SvelteKit) changed on the homepage |
| 🔎 **new routes / hosts in code** | The new build references paths like `/airdrop` or hosts like `api.site.io` that weren't there before | New JS bundles are scanned after every redeploy |
| 📝 **text changed** | Visible wording changed on a page, with a red/green diff | Every tracked page is re-fetched and its visible text compared; identical edits across many pages (like nav changes) are grouped |
| 🆕 **new page** / 🗑️ **page removed** | A page was added to or removed from the site | Links crawled from every page, `sitemap.xml`, and routes found in site code |
| 🛰️ **new subdomain** | e.g. `beta.site.io` or `app.site.io` appeared | Certificate Transparency logs (Cert Spotter + crt.sh), a DNS sweep of about 250 common names (with wildcard filtering), and hostnames referenced in the site's HTML/JS |
| 🟣 **subdomain went live** | A known subdomain started resolving | Periodic DNS re-checks |
| 📄 **file changed** | A linked PDF/doc (like a whitepaper) changed | Content hash of linked documents |
| 🔴 / 🟢 **down / back up** | The site stopped responding or recovered | 3 failed checks in a row |

Every site starts with a silent **baseline** scan, so you only get alerts for real changes after that. Noise protection is built in:

- Changes are confirmed by a second fetch before alerting.
- Rolling deploys that flip back and forth are ignored, and so are backend nodes that serve the same files with different `?ver=` values.
- A change back to a version seen in the last few hours (rotating testimonials, A/B content, a quick revert) is recorded silently.
- A number-only change is held back for one sweep (2 minutes by default): if the numbers stay put it is reported then; if they keep moving, digits on those lines are ignored from then on. Only the lines that tick are masked, so a fee or date edit elsewhere on the same page still alerts.
- Relative times ("5 minutes ago") never count as a change.
- Pages that change on every load, or more than 3 times an hour, are muted with a one-time notice (several pages at once share one notice). A muted page is compared again once it has been quiet for a day.
- Pages found while the first crawl is still being completed (large sites), and subdomains seen only on them, are recorded silently instead of being announced as "new".
- On hosted docs platforms (Mintlify, GitBook) the platform's own code releases are not reported as your site's redeploys.
- A site that answers `429 Too Many Requests` is backed off automatically (one note in the channel if it persists).
- You can add your own ignore patterns.

## 1. Create the Discord bot

1. Go to <https://discord.com/developers/applications> and click **New Application**, then name it (for example "Site Watcher").
2. Open the **Bot** tab and click **Reset Token**. Copy the token; it goes in `DISCORD_TOKEN`. No privileged intents are needed.
3. Open the **OAuth2** tab. Under **URL Generator**, tick the scopes `bot` and `applications.commands`, and the bot permissions **View Channels**, **Send Messages**, **Embed Links**, **Read Message History**, **Attach Files**, **Pin Messages** and **Mention Everyone** (Attach Files and Pin Messages are for the dashboard and its backup; Mention Everyone is only needed to ping roles that aren't mentionable).
   Open the generated URL and add the bot to your server. The bot also prints a ready-made invite link in its logs on startup.
4. **Make the bot private.** New applications are "public": anyone who finds the bot could add it to their own server and use your Railway resources. Open **Installation** and set **Install Link** to **None** (Discord refuses the next step while an install link is set), then open **Bot** and turn off **Public Bot**. Also set `DISCORD_GUILD_ID` (step 2) to your server's id: the bot then serves only that server, leaves any other server it is added to, and ignores commands from elsewhere.

## 2. Deploy on Railway

1. Push this repo to GitHub. In Railway, choose **New Project**, then **Deploy from GitHub repo**, and pick this repo. Railway builds it from the `Dockerfile` (see `railway.json`).
2. Under the service's **Variables**, set `DISCORD_TOKEN` and (recommended) `DISCORD_GUILD_ID` — right-click your server icon → **Copy Server ID** (turn on Developer Mode in Discord's Advanced settings first).
3. **Recommended: attach a volume** (right-click the service → **Add Volume**, mount path `/data`). The bot stores its database there automatically (`RAILWAY_VOLUME_MOUNT_PATH`), so page history and baselines survive redeploys too.
   **Your site list survives redeploys either way.** The bot keeps a pinned **dashboard** message in Discord that carries a backup of every watched site and its settings. When a deploy starts with an empty database, the bot finds that backup and restores all sites automatically. Each restored site re-scans silently, so a redeploy never floods the channel. Give the bot the **Pin Messages** permission so the dashboard stays pinned.
4. Deploy. The logs should show `Logged in as …`. `/health` answers `503` until the bot has logged in to Discord once, so a deploy with a bad token fails its healthcheck and the previous deployment keeps running. If Discord later rejects the token (you reset it), the process exits with a clear log line instead of running without Discord.
5. Keep **one replica**. Two replicas would send every alert twice. `railway.json` gives the old deployment 20 seconds on redeploys to finish its current check and deliver its alerts.

Optional: get a free [Cert Spotter API key](https://sslmate.com/certspotter/api/) and set `CERTSPOTTER_API_KEY`. The free plan is still **10 full-domain queries per hour**, like anonymous use, but the quota is then yours alone instead of shared with everyone else on Railway's outgoing IP. (100 queries/hour needs a paid plan; set `CERTSPOTTER_QUERIES_PER_HOUR` to match.)

## 3. Use it

Run **`/panel`** in the channel where you want the dashboard. The bot posts and pins a live **Site Watcher** dashboard:

```
🛰️ Site Watcher
Watching 3 sites · alerts in #alerts
🟢 2 up · ⏸️ 1 paused

🟢 Unpeg · unpeg.io · every 2s · #alerts
🟢 Docs · docs.foo.xyz · every 2s · #alerts
⏸️ Bar · bar.app · every 5m · #alerts
[ Manage a site… ▾ ]
[➕ Add site] [🔄 Refresh] [📖 Help]
```

- **➕ Add site** opens a form: URL, name, check interval, alert channel and ping role.
- **Manage a site…** opens a private card for that site with these buttons:
  - ⚡ **Check now**, ⏸️ **Pause/Resume**, ⚙️ **Settings** (name, interval, sweep, channel, ping role) and 🗑️ **Remove**.
  - 🧩 **Features** (toggle each alert type, including "ignore numbers").
  - 🚫 **Rules** (ignore patterns, skipped URLs, extra pages, crawl scope, max pages).
  - 📄 **Pages**, 🛰️ **Subdomains** and 🕘 **History**.
- Clicks are answered privately, so the shared dashboard stays clean. Changing anything requires **Manage Server**.
- The dashboard also holds the watch-list backup: don't delete it. If you do, the bot re-posts it. Run `/panel` again anywhere to move it.

Slash commands for quick use (Manage Server only):

```
/panel                                   # post / move the dashboard here
/watch add url:unpeg.io [name] [channel] [interval] [ping]
/watch remove site:Unpeg
/watch check site:Unpeg [full]
/watch list
/watch help
/link create label:"Matt's Chrome" [channel]   # API token for the browser extension / another bot (shown once)
/link list
/link revoke label:"Matt's Chrome"
```

Subdomain alerts have a **Watch <host>** button that starts watching that subdomain as its own site.

**Too many new-page alerts from one section** (user profiles, listings, etc.)? New-page alerts come with a **🚫 Ignore /profile/\*** button. One click stops announcing and tracking everything under that folder. You can also add skip rules yourself in the dashboard → **Rules**:
- `/profile/*` skips everything under `/profile/` (but not `/profile` itself).
- `/u/*/posts` uses `*` to stand for one path segment.
- `/blog/**` skips everything below `/blog/`.
- Anything else is treated as a regex matched against the full URL.

**API tracking:** when a site's code calls its own JSON API (e.g. `/api/launches/count`), the bot finds those endpoints and starts tracking them. It posts a one-time "🔌 Now tracking…" note. After that, any change in what the API returns is posted as a diff, like `- "status": "live"` / `+ "status": "paused"`. You can add any other endpoint yourself in the dashboard → **Rules → extra pages**. API routes added in a redeploy show up as new pages.

**Sites that block bots:** some sites (Vercel or Cloudflare bot protection) challenge traffic from cloud servers like Railway. When that happens:
- The bot posts one 🛡️ note.
- It stops crawling that site and checks only its homepage once a minute.
- The site shows 🛡️ on the dashboard.
- Subdomain alerts keep working, because they come from certificate logs and DNS rather than from the site itself.

When the site lets the bot back in, it says so and returns to normal speed. The bot does not try to get around the challenge.

**Update announcements:** after each deploy of new code, the bot posts "🚀 **Ver 2.0 has been updated!** Enjoy 🎉" (with the commit message) in the dashboard channel. It posts this once per build. Set `ANNOUNCE_UPDATES=false` to turn it off.

### How fast is "instant"?

- **Homepage, redeploys and uptime:** checked every `interval` seconds (default **2**, minimum 1). A DOWN alert needs 3 failed checks spanning at least 20 seconds, so one slow response doesn't page anyone.
- **Other tracked pages:** re-checked on a rolling schedule so each one is covered at least every `sweep` seconds (default 120). A detected redeploy triggers an immediate full sweep of every page, so text changes that ship with a deploy arrive seconds after the redeploy alert.
- **Subdomains:**
  - *Hostnames in the site's own links or code:* the next check (a few seconds to 2 minutes).
  - *Certificate Transparency (Cert Spotter):* the free quota is 10 queries an hour for the whole bot, shared by every watched domain, so each domain is polled about every `6 min × number of watched domains` (every 5 minutes with one domain). Most new subdomains get a TLS certificate, which appears in the CT logs within minutes, often before the site is announced.
  - *crt.sh* every 30 min (often slow or behind).
  - *DNS sweep* of about 250 common names every 15 min. Public resolvers cache "does not exist" answers for the zone's negative TTL (typically 30–60 minutes), so a brand-new name can take up to the sweep interval plus that TTL to show up this way.
  - In zones with a wildcard DNS record that rotates its addresses (Vercel DNS, CloudFront aliases), the DNS sweep can't tell real names from the wildcard and relies on the other sources.

## Link API / browser extension

The bot can be driven from outside Discord. The **Arkham Dev Tags** Chrome extension, another bot or a script talks to it over HTTPS:
- **🔎 Scan** any website: tech stack grouped by category, hosting, build id, subdomains, API endpoints and socials.
- **➕ Add to Discord tracker** in one click: the site is added to your server's watch list and its alerts land in your channel.
- See whether the current site is already tracked, remove it, trigger a check, and poll the alert feed (desktop notifications).

The two projects stay separate: two repos, two deploys. The extension calls this bot's **Link API** (`/api/v1`) on the bot's Railway domain, using a token issued in Discord. No shared secret is built into the extension.

**Set it up:**
1. **Give the bot a public domain.** In Railway, open this service → **Settings** → **Networking** → **Generate Domain**, then redeploy. The bot picks up `RAILWAY_PUBLIC_DOMAIN` automatically. For a custom domain or proxy, set `PUBLIC_URL`. The API is served by the same HTTP server as `/health`, so it needs no extra port or service.
2. **Create a link in Discord.** Run `/link create label:"Matt's Chrome"` (Manage Server). Add `channel:#alerts` to choose where sites added through it post; the default is the current channel.
   - The private reply shows the **API URL** and a **token** (`swb_…`). The token is **shown once**; only its hash is stored.
   - Each person or device should get its own link: up to 10 per server, each revocable on its own with `/link revoke`.
   - `/link list` shows each link's channel and when it was last used.
3. **Paste both into the extension:** options → **Discord tracker** → **Test connection**.

Links survive redeploys: the token hashes ride along in the dashboard's watch-list backup. A revoked token stops working immediately; sites it added stay watched.

**Docs:**
- [`INTEGRATION.md`](INTEGRATION.md) is the full API reference: auth, CORS, rate limits, errors, every endpoint with JSON examples, and curl.
- [`HANDOFF-EXTENSION.md`](HANDOFF-EXTENSION.md) is a self-contained brief for whoever maintains the extension. It covers the options page, the service-worker client, the on-page panel, notifications and the test plan.

## Configuration (environment variables)

| Variable | Default | Notes |
|---|---|---|
| `DISCORD_TOKEN` | — | **Required** |
| `DISCORD_GUILD_ID` | — | Serve only this server: commands are registered there, the bot leaves any other server, interactions from elsewhere are ignored |
| `DATA_DIR` | Railway volume path, else `./data` | SQLite database location |
| `CERTSPOTTER_API_KEY` | — | Optional: your own Certificate Transparency quota instead of one shared with the host's IP |
| `CERTSPOTTER_QUERIES_PER_HOUR` | 10 | Cert Spotter budget for the whole bot (free plan: 10) |
| `MAX_WATCHES_PER_GUILD` | 50 | Watches per Discord server (0 = no limit) |
| `DEFAULT_INTERVAL_SEC` / `MIN_INTERVAL_SEC` | 2 / 1 | Homepage check cadence |
| `DEFAULT_SWEEP_SEC` | 120 | Full page re-check period |
| `DEFAULT_MAX_PAGES` | 150 | Pages per site whose text is tracked |
| `SUBDOMAIN_INTERVAL_SEC` / `CRTSH_INTERVAL_SEC` / `DNS_SCAN_INTERVAL_SEC` | 300 / 1800 / 900 | Subdomain discovery cadence |
| `SITEMAP_INTERVAL_SEC` | 600 | Sitemap re-discovery |
| `GLOBAL_CONCURRENCY` / `PER_HOST_CONCURRENCY` | 16 / 4 | Politeness limits |
| `REQUEST_TIMEOUT_MS` | 20000 | |
| `USER_AGENT` | recent desktop Chrome | |
| `LOG_LEVEL` | info | debug / info / warn / error |
| `ANNOUNCE_UPDATES` | true | Post "Ver X has been updated!" after a deploy |
| `PORT` | 3000 (Railway sets it) | `/health` endpoint and the Link API |
| `PUBLIC_URL` | `https://$RAILWAY_PUBLIC_DOMAIN` | Public base URL of this service, shown by `/link create` (the API lives at `<PUBLIC_URL>/api/v1`). Only needed for a custom domain or proxy |
| `LINK_API` | true | Serve the Link API (`/api/v1`) for the browser extension and other bots. `false` turns it off; tokens are kept |
| `ALLOW_PRIVATE_NETWORK` | false | Let the bot fetch private / loopback / internal addresses (self-hosting and tests only). It also lets Link API clients scan and add such hosts, so **keep it off on Railway** |

## Local development

```bash
npm install
npm test                     # unit + end-to-end tests (fake sites, no internet needed)
npm run cli -- https://unpeg.io --once --no-subdomains   # dry run: baseline + one check, alerts printed to the console
npm run cli -- https://unpeg.io                          # keep watching in the console (Ctrl-C to stop)
cp .env.example .env && export $(grep -v '^#' .env | xargs) && npm run dev   # run the real bot locally
```

## Limitations

- **Client-side-only content.** Text is read from the server-rendered HTML. Content that only JavaScript renders in the browser isn't compared, but changes to that code still trigger the redeploy alert.
- **Bot challenges.** Sites behind aggressive bot protection (Cloudflare "Just a moment…" pages) may block the watcher. The bot tells you when that happens; subdomain checks keep running meanwhile.
- **Hosted docs platforms.** On Mintlify or GitBook the site's code belongs to the platform, so there are no redeploy alerts for such docs sites (text changes are still reported).
- **Late number edits.** A number-only edit (a fee changing from 0.3% to 0.5%) is reported about one sweep (2 minutes by default) after it appears, and never on lines whose numbers tick on their own.
- **Wildcard certificates.** Subdomains behind a wildcard certificate (common with Cloudflare) don't show up in CT logs. The DNS sweep and code scanning cover the common names.
