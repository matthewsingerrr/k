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
3. Open the **OAuth2** tab. Under **URL Generator**, tick the scopes `bot` and `applications.commands`, and the bot permissions **View Channels**, **Send Messages**, **Embed Links**, **Read Message History** and **Mention Everyone** (Mention Everyone is only needed to ping roles that aren't mentionable).
   Open the generated URL and add the bot to your server. The bot also prints a ready-made invite link in its logs on startup.
4. **Make the bot private.** New applications are "public": anyone who finds the bot could add it to their own server and use your Railway resources. Open **Installation** and set **Install Link** to **None** (Discord refuses the next step while an install link is set), then open **Bot** and turn off **Public Bot**. Also set `DISCORD_GUILD_ID` (step 2) to your server's id: the bot then serves only that server, leaves any other server it is added to, and ignores commands from elsewhere.

## 2. Deploy on Railway

1. Push this repo to GitHub. In Railway, choose **New Project**, then **Deploy from GitHub repo**, and pick this repo. Railway builds it from the `Dockerfile` (see `railway.json`).
2. Under the service's **Variables**, set `DISCORD_TOKEN` and (recommended) `DISCORD_GUILD_ID` — right-click your server icon → **Copy Server ID** (turn on Developer Mode in Discord's Advanced settings first).
3. **Attach a volume** (right-click the service, or open the command palette, then choose **Add Volume**) with mount path `/data`.
   The bot automatically stores its database on the volume (`RAILWAY_VOLUME_MOUNT_PATH`).
   Without a volume, every redeploy wipes your watch list.
4. Deploy. The logs should show `Logged in as …`. `/health` answers `503` until the bot has logged in to Discord once, so a deploy with a bad token fails its healthcheck and the previous deployment keeps running. If Discord later rejects the token (you reset it), the process exits with a clear log line instead of running without Discord.
5. Keep **one replica**. Two replicas would send every alert twice. `railway.json` gives the old deployment 20 seconds on redeploys to finish its current check and deliver its alerts.

Optional: get a free [Cert Spotter API key](https://sslmate.com/certspotter/api/) and set `CERTSPOTTER_API_KEY`. The free plan is still **10 full-domain queries per hour**, like anonymous use, but the quota is then yours alone instead of shared with everyone else on Railway's outgoing IP. (100 queries/hour needs a paid plan; set `CERTSPOTTER_QUERIES_PER_HOUR` to match.)

## 3. Use it

All commands live under `/watch`. By default only members with **Manage Server** can see them; you can change this in Server Settings → Integrations.

```
/watch add url:unpeg.io                     # watch a site; alerts go to this channel
/watch add url:https://unpeg.io/docs name:Unpeg channel:#alerts ping:@alpha interval:15
/watch list                                 # everything being watched
/watch info site:Unpeg                      # status, counts, build id, last change
/watch check site:Unpeg                     # check right now
/watch set site:Unpeg interval:20 subdomains:false text:true
/watch ignore site:Unpeg pattern:Last updated.*   # strip a changing line before comparing
/watch exclude site:Unpeg pattern:/blog/          # don't crawl matching URLs
/watch addpage site:Unpeg url:/secret-page         # track a page that isn't linked anywhere
/watch pages site:Unpeg                     # tracked pages
/watch subdomains site:Unpeg                # known subdomains
/watch history site:Unpeg                   # recent alerts
/watch pause | resume | remove site:Unpeg
/watch help
```

Subdomain alerts have a **Watch <host>** button that starts watching that subdomain as its own site.

Notes:

- If the URL you add redirects to another host of the same site (`site.io` → `www.site.io`, `docs.x.io` → `developers.x.io`), the bot watches that host instead and says so. A redirect to another domain is reported; only the start page can be checked then.
- Adding a second watch for the same site (for example `unpeg.io` and `docs.unpeg.io`) turns subdomain detection off on the new one when another watch already scans that domain, and names it after its subdomain or path ("Unpeg docs"). Redeploy and uptime alerts of one host come from every watch of that host; the reply tells you if there is overlap.
- Changing `ignore`, `exclude`, `scope`, `ignore_numbers` or switching a check on only re-baselines what that setting affects (silently); all other checks keep alerting as usual.
- A server can hold at most `MAX_WATCHES_PER_GUILD` watches (default 50).

### How fast is "instant"?

- **Homepage, redeploys and uptime:** checked every `interval` seconds (default 30, minimum 10).
- **Other tracked pages:** re-checked on a rolling schedule so each one is covered at least every `sweep` seconds (default 120). A detected redeploy triggers an immediate full sweep of every page, so text changes that ship with a deploy arrive seconds after the redeploy alert.
- **Subdomains:**
  - *Hostnames in the site's own links or code:* the next check (about 30 seconds to 2 minutes).
  - *Certificate Transparency (Cert Spotter):* the free quota is 10 queries an hour for the whole bot, shared by every watched domain, so each domain is polled about every `6 min × number of watched domains` (every 5 minutes with one domain). Most new subdomains get a TLS certificate, which appears in the CT logs within minutes, often before the site is announced.
  - *crt.sh* every 30 min (often slow or behind).
  - *DNS sweep* of about 250 common names every 15 min. Public resolvers cache "does not exist" answers for the zone's negative TTL (typically 30–60 minutes), so a brand-new name can take up to the sweep interval plus that TTL to show up this way.
  - In zones with a wildcard DNS record that rotates its addresses (Vercel DNS, CloudFront aliases), the DNS sweep can't tell real names from the wildcard and relies on the other sources.

## Configuration (environment variables)

| Variable | Default | Notes |
|---|---|---|
| `DISCORD_TOKEN` | — | **Required** |
| `DISCORD_GUILD_ID` | — | Serve only this server: commands are registered there, the bot leaves any other server, interactions from elsewhere are ignored |
| `DATA_DIR` | Railway volume path, else `./data` | SQLite database location |
| `CERTSPOTTER_API_KEY` | — | Optional: your own Certificate Transparency quota instead of one shared with the host's IP |
| `CERTSPOTTER_QUERIES_PER_HOUR` | 10 | Cert Spotter budget for the whole bot (free plan: 10) |
| `MAX_WATCHES_PER_GUILD` | 50 | Watches per Discord server (0 = no limit) |
| `DEFAULT_INTERVAL_SEC` / `MIN_INTERVAL_SEC` | 30 / 10 | Homepage check cadence |
| `DEFAULT_SWEEP_SEC` | 120 | Full page re-check period |
| `DEFAULT_MAX_PAGES` | 150 | Pages per site whose text is tracked |
| `SUBDOMAIN_INTERVAL_SEC` / `CRTSH_INTERVAL_SEC` / `DNS_SCAN_INTERVAL_SEC` | 300 / 1800 / 900 | Subdomain discovery cadence |
| `SITEMAP_INTERVAL_SEC` | 600 | Sitemap re-discovery |
| `GLOBAL_CONCURRENCY` / `PER_HOST_CONCURRENCY` | 16 / 4 | Politeness limits |
| `REQUEST_TIMEOUT_MS` | 20000 | |
| `USER_AGENT` | recent desktop Chrome | |
| `LOG_LEVEL` | info | debug / info / warn / error |
| `PORT` | 3000 (Railway sets it) | `/health` endpoint |

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
