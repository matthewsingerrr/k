import { beforeEach, describe, expect, it } from 'vitest';
import {
  ButtonStyle,
  ComponentType,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { CommandDeps } from '../src/discord/commands.js';
import {
  PANEL_COLOR,
  PanelIds,
  buildPanelMessage,
  handlePanelComponent,
  handlePanelModal,
  isPanelCustomId,
  type PanelHost,
} from '../src/discord/panel.js';
import { embedLength } from '../src/discord/format.js';
import { testConfig, type Config } from '../src/config.js';
import { Store } from '../src/db/store.js';
import type { BaselineSummary, Monitor, TickSummary, WatchRuntimeInfo } from '../src/monitor/scheduler.js';
import { defaultWatchState, type Logger, type PageRecord, type Watch } from '../src/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const GUILD = '100000000000000001';
const OTHER_GUILD = '100000000000000002';
const CHANNEL = '200000000000000001';
const ALERTS = '200000000000000002';
const USER = '300000000000000001';
const ROLE = '400000000000000001';

// ---------------------------------------------------------------------------
// Fakes (same shapes as test/commands.test.ts)
// ---------------------------------------------------------------------------

interface Call {
  type: 'reply' | 'defer' | 'edit' | 'followUp' | 'update' | 'modal' | 'deferUpdate';
  payload: any;
}

interface SpyLogger extends Logger {
  entries: Array<{ level: string; msg: string; meta?: Record<string, unknown> }>;
}

function spyLogger(): SpyLogger {
  const entries: SpyLogger['entries'] = [];
  const log: SpyLogger = {
    entries,
    debug: (msg, meta) => entries.push({ level: 'debug', msg, meta }),
    info: (msg, meta) => entries.push({ level: 'info', msg, meta }),
    warn: (msg, meta) => entries.push({ level: 'warn', msg, meta }),
    error: (msg, meta) => entries.push({ level: 'error', msg, meta }),
    child: () => log,
  };
  return log;
}

function fakeMonitor(store: Store) {
  const calls = { baseline: [] as number[], added: [] as Watch[], removed: [] as number[], updated: [] as Watch[], checkNow: [] as number[] };
  const m = {
    calls,
    async runBaseline(id: number): Promise<BaselineSummary> {
      calls.baseline.push(id);
      store.updateWatch(id, { baselineDone: true });
      return { watchId: id, pagesTracked: 3, pagesKnown: 3, files: 0, subdomains: 1, buildId: null, assets: 4, homeStatus: 200, homeBlocked: false, durationMs: 900 };
    },
    onWatchAdded: (w: Watch) => calls.added.push(w),
    onWatchRemoved: (id: number) => calls.removed.push(id),
    onWatchUpdated: (w: Watch) => calls.updated.push(w),
    async checkNow(id: number): Promise<TickSummary> {
      calls.checkNow.push(id);
      return { watchId: id, alerts: [], durationMs: 800, error: null };
    },
    runtimeInfo: (): WatchRuntimeInfo => ({ running: true, lastTickAt: 1, lastTickMs: 400, nextTickAt: null, baselineRunning: false }),
    lastActivityAt: () => null,
  };
  return m;
}

function fakeHost() {
  const host: PanelHost & { refreshed: string[] } = {
    refreshed: [],
    placePanel: async (g, c) => `https://discord.com/channels/${g}/${c}/1`,
    refresh(g) {
      host.refreshed.push(g);
    },
  };
  return host;
}

interface Base {
  guildId?: string | null;
  manage?: boolean;
  /** The clicked message is ephemeral (a card) — false for the shared dashboard. */
  ephemeral?: boolean;
}

function baseFake(customId: string, o: Base, calls: Call[]) {
  return {
    customId,
    guildId: o.guildId === undefined ? GUILD : o.guildId,
    channelId: CHANNEL,
    channel: undefined,
    user: { id: USER },
    deferred: false,
    replied: false,
    memberPermissions: { has: (p: bigint) => o.manage !== false && p === PermissionFlagsBits.ManageGuild },
    message: { flags: { has: () => o.ephemeral !== false } },
    inGuild() {
      return this.guildId !== null;
    },
    async reply(payload: unknown) {
      if (this.deferred || this.replied) throw new Error('InteractionAlreadyReplied');
      this.replied = true;
      calls.push({ type: 'reply', payload });
    },
    async update(payload: unknown) {
      if (this.deferred || this.replied) throw new Error('InteractionAlreadyReplied');
      this.replied = true;
      calls.push({ type: 'update', payload });
    },
    async deferUpdate() {
      this.deferred = true;
      calls.push({ type: 'deferUpdate', payload: null });
    },
    async deferReply(payload: unknown) {
      if (this.deferred || this.replied) throw new Error('InteractionAlreadyReplied');
      this.deferred = true;
      calls.push({ type: 'defer', payload });
    },
    async editReply(payload: unknown) {
      if (!this.deferred && !this.replied) throw new Error('InteractionNotReplied');
      this.replied = true;
      calls.push({ type: 'edit', payload });
    },
    async followUp(payload: unknown) {
      calls.push({ type: 'followUp', payload });
    },
    async showModal(payload: unknown) {
      if (this.deferred || this.replied) throw new Error('InteractionAlreadyReplied');
      this.replied = true;
      calls.push({ type: 'modal', payload });
    },
  };
}

function fakeClick(customId: string, o: Base & { values?: string[] } = {}) {
  const calls: Call[] = [];
  const i = {
    ...baseFake(customId, o, calls),
    values: o.values ?? [],
    isStringSelectMenu: () => o.values !== undefined,
    isModalSubmit: () => false,
    isFromMessage: () => true,
  };
  return { i: i as unknown as ButtonInteraction & StringSelectMenuInteraction, calls };
}

function fakeModal(
  customId: string,
  text: Record<string, string>,
  selects: Record<string, string[]> = {},
  o: Base & { fromMessage?: boolean } = {},
) {
  const calls: Call[] = [];
  const picked = (id: string) => {
    if (!(id in selects)) throw new Error(`no field ${id}`);
    return selects[id].length ? new Map(selects[id].map((x) => [x, { id: x }])) : null;
  };
  const i = {
    ...baseFake(customId, o, calls),
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    isFromMessage: () => o.fromMessage !== false,
    fields: {
      getTextInputValue(id: string) {
        if (!(id in text)) throw new Error(`no field ${id}`);
        return text[id];
      },
      getSelectedChannels: picked,
      getSelectedRoles: picked,
    },
  };
  return { i: i as unknown as ModalSubmitInteraction, calls };
}

const last = (calls: Call[]) => calls[calls.length - 1];
const isEphemeral = (call: Call | undefined) => Boolean(call && (call.payload?.flags ?? 0) & 64);

function textOf(call: Call | undefined): string {
  if (!call) return '';
  const p = call.payload ?? {};
  const parts: string[] = [p.content ?? ''];
  for (const e of p.embeds ?? []) {
    parts.push(e.title ?? '', e.description ?? '');
    for (const f of e.fields ?? []) parts.push(`${f.name}: ${f.value}`);
  }
  return parts.join('\n');
}

/** Every button / select in a message payload. */
function componentsOf(payload: any): any[] {
  return (payload?.components ?? []).flatMap((r: any) => r.components);
}

function buttonById(payload: any, customId: string): any {
  return componentsOf(payload).find((c) => c.custom_id === customId);
}

/** Assert Discord's message component limits. */
function expectMessageLimits(payload: any): void {
  const rows = payload.components ?? [];
  expect(rows.length).toBeLessThanOrEqual(5);
  const ids = new Set<string>();
  for (const r of rows) {
    expect(r.type).toBe(ComponentType.ActionRow);
    const selects = r.components.filter((c: any) => c.type === ComponentType.StringSelect);
    if (selects.length) expect(r.components).toHaveLength(1);
    else expect(r.components.length).toBeLessThanOrEqual(5);
    for (const c of r.components) {
      expect(c.custom_id.length).toBeLessThanOrEqual(100);
      expect(isPanelCustomId(c.custom_id)).toBe(true);
      expect(ids.has(c.custom_id)).toBe(false);
      ids.add(c.custom_id);
      if (c.type === ComponentType.Button) expect(c.label.length).toBeLessThanOrEqual(80);
      if (c.type === ComponentType.StringSelect) {
        expect(c.options.length).toBeGreaterThan(0);
        expect(c.options.length).toBeLessThanOrEqual(25);
        for (const opt of c.options) {
          expect(opt.label.length).toBeLessThanOrEqual(100);
          expect(opt.label.length).toBeGreaterThan(0);
          expect((opt.description ?? '').length).toBeLessThanOrEqual(100);
          expect(opt.value.length).toBeLessThanOrEqual(100);
        }
      }
    }
  }
  for (const e of payload.embeds ?? []) {
    expect((e.title ?? '').length).toBeLessThanOrEqual(256);
    expect((e.description ?? '').length).toBeLessThanOrEqual(4096);
    expect((e.fields ?? []).length).toBeLessThanOrEqual(25);
    for (const f of e.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
    expect(embedLength(e)).toBeLessThanOrEqual(6000);
  }
}

/** Assert Discord's modal limits. */
function expectModalLimits(modal: any): void {
  expect(modal.custom_id.length).toBeLessThanOrEqual(100);
  expect(isPanelCustomId(modal.custom_id)).toBe(true);
  expect(modal.title.length).toBeLessThanOrEqual(45);
  expect(modal.components.length).toBeGreaterThan(0);
  expect(modal.components.length).toBeLessThanOrEqual(5);
  for (const l of modal.components) {
    expect(l.type).toBe(ComponentType.Label);
    expect(l.label.length).toBeLessThanOrEqual(45);
    expect((l.description ?? '').length).toBeLessThanOrEqual(100);
    const c = l.component;
    expect(c.custom_id.length).toBeLessThanOrEqual(100);
    if (c.type === ComponentType.TextInput) {
      expect(c.label).toBeUndefined();
      expect((c.value ?? '').length).toBeLessThanOrEqual(c.max_length ?? 4000);
      expect(c.max_length ?? 4000).toBeLessThanOrEqual(4000);
      expect((c.placeholder ?? '').length).toBeLessThanOrEqual(100);
    }
  }
}

function field(modal: any, id: string): any {
  return modal.components.find((l: any) => l.component.custom_id === id)?.component;
}

// ---------------------------------------------------------------------------

let store: Store;
let mon: ReturnType<typeof fakeMonitor>;
let host: ReturnType<typeof fakeHost>;
let log: SpyLogger;
let config: Config;
let deps: CommandDeps;

function makeWatch(url = 'https://unpeg.io/', over: Partial<Parameters<Store['createWatch']>[0]> = {}): Watch {
  const u = new URL(url);
  const w = store.createWatch({
    guildId: GUILD,
    channelId: ALERTS,
    name: 'Unpeg',
    url,
    host: u.hostname,
    rootDomain: 'unpeg.io',
    createdBy: USER,
    intervalSec: 30,
    ...over,
  });
  return store.updateWatch(w.id, { baselineDone: true });
}

function page(watchId: number, url: string, over: Partial<PageRecord> = {}): PageRecord {
  return {
    watchId, url, kind: 'page', tracked: true, title: null, text: 'hello', textHash: 'abc', etag: null, lastModified: null,
    contentLength: null, contentType: 'text/html', status: 200, failCount: 0, gone: false, maskNumbers: false,
    numericChangeTimes: [], flapCount: 0, dynamic: false, pendingHash: null, pendingSince: null, hashHistory: [], changeTimes: [],
    maskedLines: [], source: 'link', depth: 1, firstSeen: 1, lastChecked: 1, lastChanged: null, ...over,
  };
}

async function click(customId: string, o: Base & { values?: string[] } = {}) {
  const f = fakeClick(customId, o);
  await handlePanelComponent(f.i, deps);
  return f;
}

async function submit(customId: string, text: Record<string, string>, selects: Record<string, string[]> = {}, o: Base & { fromMessage?: boolean } = {}) {
  const f = fakeModal(customId, text, selects, o);
  await handlePanelModal(f.i, deps);
  return f;
}

beforeEach(() => {
  store = new Store(':memory:');
  mon = fakeMonitor(store);
  host = fakeHost();
  log = spyLogger();
  config = testConfig({ minIntervalSec: 2, defaultIntervalSec: 2 });
  deps = { store, monitor: mon as unknown as Monitor, config, log, panel: host };
});

// ---------------------------------------------------------------------------
// Dashboard rendering
// ---------------------------------------------------------------------------

describe('buildPanelMessage', () => {
  const NOW = new Date('2026-09-28T12:00:00Z');

  it('empty server: friendly empty state, no select, Add/Refresh/Help buttons', () => {
    const msg = buildPanelMessage(deps, GUILD, NOW);
    expectMessageLimits(msg);
    const [e] = msg.embeds;
    expect(e.title).toBe('🛰️ Site Watcher');
    expect(e.color).toBe(PANEL_COLOR);
    expect(e.timestamp).toBe(NOW.toISOString());
    expect(e.description).toContain('No sites yet — press **Add site**');
    expect(msg.components).toHaveLength(1);
    const buttons = msg.components[0].components as any[];
    expect(buttons.map((b) => [b.custom_id, b.label, b.style])).toEqual([
      ['panel:add', 'Add site', ButtonStyle.Primary],
      ['panel:refresh', 'Refresh', ButtonStyle.Secondary],
      ['panel:help', 'Help', ButtonStyle.Secondary],
    ]);
    expect(buttons.map((b) => b.emoji.name)).toEqual(['➕', '🔄', '📖']);
  });

  it('one site: summary, a compact line and a one-option select', () => {
    const w = makeWatch();
    store.createWatch({ guildId: OTHER_GUILD, channelId: 'c', name: 'Hidden', url: 'https://x.io/', host: 'x.io', rootDomain: 'x.io', createdBy: 'u' });
    const msg = buildPanelMessage(deps, GUILD, NOW);
    expectMessageLimits(msg);
    const d = msg.embeds[0].description!;
    expect(d).toContain(`Watching **1** site · alerts in <#${ALERTS}>`);
    expect(d).toContain('🟢 1 up');
    expect(d).toContain(`🟢 **Unpeg** · unpeg.io · every 30s · <#${ALERTS}>`);
    expect(d).not.toContain('Hidden');
    expect(msg.components).toHaveLength(2);
    const select = msg.components[0].components[0] as any;
    expect(select).toMatchObject({ type: ComponentType.StringSelect, custom_id: 'panel:pick:0', placeholder: 'Manage a site…' });
    expect(select.options).toEqual([{ label: 'Unpeg', description: 'unpeg.io · every 30s', value: String(w.id), emoji: { name: '🟢' } }]);
  });

  it('shows paused, down and first-scan-pending sites', () => {
    const a = makeWatch('https://a.unpeg.io/', { name: 'A', channelId: CHANNEL });
    const b = makeWatch('https://b.unpeg.io/', { name: 'B' });
    const c = makeWatch('https://c.unpeg.io/', { name: 'C' });
    store.updateWatch(a.id, { paused: true });
    const st = defaultWatchState();
    st.status.up = false;
    store.saveState(b.id, st);
    store.updateWatch(c.id, { baselineDone: false });
    const d = buildPanelMessage(deps, GUILD, NOW).embeds[0].description!;
    expect(d).toContain('Watching **3** sites · alerts in 2 channels');
    expect(d).toContain('🔴 1 down · ⏸️ 1 paused · ⏳ 1 scanning');
    expect(d).toContain('⏸️ **A**');
    expect(d).toContain('🔴 **B**');
    expect(d).toContain('⏳ **C**');
  });

  it('30 sites: 25 lines then "+5 more", two selects of ≤ 25 options, all within Discord limits', () => {
    for (let n = 0; n < 30; n++) {
      makeWatch(`https://s${n}.${'x'.repeat(40)}.unpeg.io/`, { name: `Site ${n} ${'x'.repeat(120)}`, intervalSec: 3600 });
    }
    const msg = buildPanelMessage(deps, GUILD, NOW);
    expectMessageLimits(msg);
    const d = msg.embeds[0].description!;
    expect(d.split('\n').filter((l) => l.startsWith('🟢 **'))).toHaveLength(25);
    expect(d).toContain('+5 more');
    const selects = msg.components.filter((r) => r.components[0].type === ComponentType.StringSelect).map((r) => r.components[0] as any);
    expect(selects.map((s) => s.options.length)).toEqual([25, 5]);
    expect(selects.map((s) => s.placeholder)).toEqual(['Manage a site… (1–25 of 30)', 'Manage a site… (26–30 of 30)']);
    expect(msg.components.at(-1)!.components.map((c: any) => c.custom_id)).toEqual(['panel:add', 'panel:refresh', 'panel:help']);
  });

  it('pathological names and hosts: lines stop at the description budget and "+N more" stays accurate', () => {
    for (let n = 0; n < 30; n++) {
      makeWatch(`https://s${n}.${'x'.repeat(60)}.unpeg.io/`, { name: `${'*'.repeat(100)}`.slice(0, 98) + n, intervalSec: 3600 });
    }
    const msg = buildPanelMessage(deps, GUILD, NOW);
    expectMessageLimits(msg);
    const d = msg.embeds[0].description!;
    const shown = d.split('\n').filter((l) => l.startsWith('🟢 **')).length;
    expect(shown).toBeGreaterThan(5);
    expect(shown).toBeLessThanOrEqual(25);
    expect(d.endsWith(`+${30 - shown} more`)).toBe(true);
  });

  it('caps the number of selects so the message keeps ≤ 5 rows', () => {
    for (let n = 0; n < 90; n++) makeWatch(`https://s${n}.unpeg.io/`, { name: `S${n}` });
    const msg = buildPanelMessage(deps, GUILD, NOW);
    expectMessageLimits(msg);
    expect(msg.components).toHaveLength(4);
  });

  it('custom_ids stay ≤ 100 chars even for huge ids', () => {
    const id = 999_999_999_999_999;
    const all = [
      PanelIds.site(id), PanelIds.check(id), PanelIds.pause(id, true), PanelIds.settings(id), PanelIds.remove(id), PanelIds.removeConfirm(id),
      PanelIds.features(id), PanelIds.toggle(id, 'maskNumbers', true), PanelIds.rules(id), PanelIds.pages(id), PanelIds.subdomains(id),
      PanelIds.history(id), PanelIds.settingsModal(id), PanelIds.rulesModal(id), PanelIds.addModal, PanelIds.pick(2),
    ];
    for (const c of all) {
      expect(c.length).toBeLessThanOrEqual(100);
      expect(isPanelCustomId(c)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Clicks
// ---------------------------------------------------------------------------

describe('dashboard controls', () => {
  it('picking a site opens its card ephemerally (never edits the shared dashboard) and resets the menu', async () => {
    const w = makeWatch('https://unpeg.io/', { pingRoleId: ROLE });
    const f = await click('panel:pick:0', { values: [String(w.id)], ephemeral: false });
    const call = last(f.calls);
    expect(call.type).toBe('reply');
    expect(isEphemeral(call)).toBe(true);
    expectMessageLimits(call.payload);
    expect(call.payload.embeds[0].title).toBe('🟢 Unpeg');
    expect(textOf(call)).toContain(`ping: <@&${ROLE}>`);
    expect(call.payload.components.map((r: any) => r.components.map((c: any) => c.label))).toEqual([
      ['Check now', 'Pause', 'Settings', 'Remove'],
      ['Features', 'Rules', 'Pages', 'Subdomains', 'History'],
    ]);
    expect(buttonById(call.payload, PanelIds.remove(w.id)).style).toBe(ButtonStyle.Danger);
    expect(host.refreshed).toEqual([GUILD]);
  });

  it('refresh asks the host and acknowledges silently; help is ephemeral; stale picks are explained', async () => {
    let f = await click('panel:refresh', { ephemeral: false });
    expect(host.refreshed).toEqual([GUILD]);
    expect(f.calls).toEqual([{ type: 'deferUpdate', payload: null }]);

    f = await click('panel:help', { ephemeral: false });
    expect(isEphemeral(last(f.calls))).toBe(true);
    expect(textOf(last(f.calls))).toContain('/panel');

    f = await click('panel:pick:0', { values: ['999'], ephemeral: false });
    expect(textOf(last(f.calls))).toContain('no longer watched');
    expect(isEphemeral(last(f.calls))).toBe(true);

    deps.panel = null;
    f = await click('panel:refresh', { ephemeral: false });
    expect(textOf(last(f.calls))).toContain("can't be refreshed");
  });

  it('sites of other servers and junk ids are rejected', async () => {
    const foreign = store.createWatch({ guildId: OTHER_GUILD, channelId: 'c', name: 'F', url: 'https://f.io/', host: 'f.io', rootDomain: 'f.io', createdBy: 'u' });
    for (const id of [PanelIds.site(foreign.id), 'panel:site:abc', 'panel:site:', 'panel:bogus:1']) {
      const f = await click(id);
      expect(textOf(last(f.calls))).toMatch(/no longer (watched|valid)/);
      expect(isEphemeral(last(f.calls))).toBe(true);
    }
    const f = await click('panel:help', { guildId: null });
    expect(textOf(last(f.calls))).toContain('inside a server');
  });
});

describe('site card', () => {
  it('toggles a feature and updates the Features view in place', async () => {
    const w = makeWatch();
    let f = await click(PanelIds.features(w.id));
    let call = last(f.calls);
    expect(call.type).toBe('update');
    expectMessageLimits(call.payload);
    const toggles = componentsOf(call.payload).filter((c) => c.custom_id.startsWith('panel:toggle:'));
    expect(toggles.map((t) => t.label)).toEqual(['Redeploys', 'Text changes', 'New pages', 'Subdomains', 'Files', 'Uptime', 'Code intel', 'Ignore numbers']);
    expect(toggles.slice(0, 7).every((t) => t.style === ButtonStyle.Success)).toBe(true);
    expect(toggles[7].style).toBe(ButtonStyle.Secondary);
    expect(buttonById(call.payload, PanelIds.site(w.id)).label).toBe('Back');

    f = await click(PanelIds.toggle(w.id, 'text', false));
    call = last(f.calls);
    expect(call.type).toBe('update');
    expect(store.getWatch(w.id)!.features).toMatchObject({ text: false, deploy: true });
    expect(mon.calls.updated.at(-1)?.features.text).toBe(false);
    expect(buttonById(call.payload, PanelIds.toggle(w.id, 'text', true)).style).toBe(ButtonStyle.Secondary);
    expect(call.payload.content).toContain('**Text changes** off');

    // Ignore numbers is the watch-level maskNumbers flag.
    f = await click(PanelIds.toggle(w.id, 'maskNumbers', true));
    expect(store.getWatch(w.id)!.maskNumbers).toBe(true);
    expect(buttonById(last(f.calls).payload, PanelIds.toggle(w.id, 'maskNumbers', false)).style).toBe(ButtonStyle.Success);

    // A stale button carrying the current state changes nothing.
    const before = mon.calls.updated.length;
    await click(PanelIds.toggle(w.id, 'text', false));
    expect(mon.calls.updated).toHaveLength(before);

    f = await click(`panel:toggle:${w.id}:bogus:1`);
    expect(textOf(last(f.calls))).toContain('no longer valid');
  });

  it('pause / resume update the watch, the monitor and the card in place', async () => {
    const w = makeWatch();
    let f = await click(PanelIds.pause(w.id, true));
    expect(store.getWatch(w.id)!.paused).toBe(true);
    expect(mon.calls.updated.at(-1)).toMatchObject({ id: w.id, paused: true });
    let call = last(f.calls);
    expect(call.type).toBe('update');
    expect(call.payload.content).toContain('Paused **Unpeg**');
    expect(call.payload.embeds[0].title).toBe('⏸️ Unpeg');
    expect(buttonById(call.payload, PanelIds.pause(w.id, false))).toMatchObject({ label: 'Resume', style: ButtonStyle.Success });

    f = await click(PanelIds.pause(w.id, true));
    expect(last(f.calls).payload.content).toContain('already paused');
    expect(mon.calls.updated).toHaveLength(1);

    f = await click(PanelIds.pause(w.id, false));
    call = last(f.calls);
    expect(store.getWatch(w.id)!.paused).toBe(false);
    expect(call.payload.content).toContain('Resumed **Unpeg**');
  });

  it('check now defers ephemerally and reports the result', async () => {
    const w = makeWatch();
    const f = await click(PanelIds.check(w.id));
    expect(f.calls[0].type).toBe('defer');
    expect(isEphemeral(f.calls[0])).toBe(true);
    expect(mon.calls.checkNow).toEqual([w.id]);
    expect(last(f.calls).payload.content).toMatch(/^✅ No changes on \*\*Unpeg\*\* — took .+\.$/);
  });

  it('pages / subdomains / history views have a Back button to the card', async () => {
    const w = makeWatch();
    store.upsertPage(page(w.id, 'https://unpeg.io/docs', { title: 'Docs' }));
    store.addEvent(w.id, 'deploy', 'redeployed', 1_700_000_000_000);
    for (const [id, needle] of [
      [PanelIds.pages(w.id), '`/docs` · Docs'],
      [PanelIds.subdomains(w.id), 'None found yet'],
      [PanelIds.history(w.id), '🌐 redeployed'],
    ] as const) {
      const f = await click(id);
      const call = last(f.calls);
      expect(call.type).toBe('update');
      expect(textOf(call)).toContain(needle);
      expect(componentsOf(call.payload).map((c) => c.custom_id)).toEqual([PanelIds.site(w.id)]);
      expectMessageLimits(call.payload);
    }
    const back = await click(PanelIds.site(w.id));
    expect(last(back.calls).payload.embeds[0].title).toBe('🟢 Unpeg');
  });

  it('remove asks for confirmation, then deletes the watch and stops it', async () => {
    const w = makeWatch();
    let f = await click(PanelIds.remove(w.id));
    let call = last(f.calls);
    expect(call.type).toBe('update');
    expect(call.payload.embeds[0].title).toBe('🗑️ Remove Unpeg?');
    expect(componentsOf(call.payload).map((c) => [c.custom_id, c.style])).toEqual([
      [PanelIds.removeConfirm(w.id), ButtonStyle.Danger],
      [PanelIds.site(w.id), ButtonStyle.Secondary],
    ]);
    expect(store.getWatch(w.id)).toBeDefined();

    f = await click(PanelIds.removeConfirm(w.id));
    call = last(f.calls);
    expect(store.getWatch(w.id)).toBeUndefined();
    expect(mon.calls.removed).toEqual([w.id]);
    expect(call).toMatchObject({ type: 'update', payload: { content: '🗑️ Stopped watching **Unpeg** (<https://unpeg.io/>).', embeds: [], components: [] } });

    f = await click(PanelIds.removeConfirm(w.id));
    expect(textOf(last(f.calls))).toContain('no longer watched');
  });

  it('never updates a non-ephemeral message in place (replies instead)', async () => {
    const w = makeWatch();
    const f = await click(PanelIds.pages(w.id), { ephemeral: false });
    expect(last(f.calls).type).toBe('reply');
    expect(isEphemeral(last(f.calls))).toBe(true);
  });

  it('rejects non-admins for every change but lets them look', async () => {
    const w = makeWatch();
    const privileged = [
      PanelIds.add, PanelIds.check(w.id), PanelIds.pause(w.id, true), PanelIds.settings(w.id), PanelIds.rules(w.id), PanelIds.features(w.id),
      PanelIds.toggle(w.id, 'text', false), PanelIds.remove(w.id), PanelIds.removeConfirm(w.id),
    ];
    for (const id of privileged) {
      const f = await click(id, { manage: false });
      expect(textOf(last(f.calls)), id).toContain('Manage Server');
      expect(isEphemeral(last(f.calls))).toBe(true);
      expect(f.calls.some((c) => c.type === 'modal' || c.type === 'update')).toBe(false);
    }
    const m = await submit(PanelIds.settingsModal(w.id), { name: 'Hacked', interval: '5', sweep: '120' }, {}, { manage: false });
    expect(textOf(last(m.calls))).toContain('Manage Server');
    const a = await submit(PanelIds.addModal, { url: 'evil.io' }, {}, { manage: false });
    expect(textOf(last(a.calls))).toContain('Manage Server');
    expect(store.listWatches(GUILD)).toHaveLength(1);
    expect(store.getWatch(w.id)).toMatchObject({ name: 'Unpeg', paused: false });
    expect(store.getWatch(w.id)!.features.text).toBe(true);
    expect(mon.calls.updated).toHaveLength(0);
    expect(mon.calls.checkNow).toHaveLength(0);

    const view = await click(PanelIds.site(w.id), { manage: false });
    expect(last(view.calls).payload.embeds[0].title).toBe('🟢 Unpeg');
  });
});

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

describe('settings modal', () => {
  it('opens prefilled with the current values (channel & role selects)', async () => {
    const w = makeWatch('https://unpeg.io/', { pingRoleId: ROLE, sweepSec: 600 });
    const f = await click(PanelIds.settings(w.id));
    const modal = last(f.calls).payload;
    expect(last(f.calls).type).toBe('modal');
    expectModalLimits(modal);
    expect(modal.custom_id).toBe(PanelIds.settingsModal(w.id));
    expect(field(modal, 'name').value).toBe('Unpeg');
    expect(field(modal, 'interval').value).toBe('30');
    expect(field(modal, 'sweep').value).toBe('600');
    expect(field(modal, 'channel')).toMatchObject({ type: ComponentType.ChannelSelect, default_values: [{ id: ALERTS, type: 'channel' }] });
    expect(field(modal, 'role')).toMatchObject({ type: ComponentType.RoleSelect, min_values: 0, default_values: [{ id: ROLE, type: 'role' }] });
    expect(modal.components.find((l: any) => l.component.custom_id === 'interval').description).toContain('2–3600');
  });

  it.each([
    [{ interval: '1' }, 'The check interval must be between 2 and 3600 seconds'],
    [{ interval: 'soon' }, 'The check interval must be a whole number of seconds'],
    [{ sweep: '10' }, 'The full page sweep must be between 30 and 86400 seconds'],
    [{ name: '42' }, 'cannot be just a number'],
    [{ name: 'beta' }, 'already exists'],
  ])('rejects %o with a friendly error and changes nothing', async (over, msg) => {
    const w = makeWatch();
    makeWatch('https://beta.unpeg.io/', { name: 'Beta' });
    const f = await submit(PanelIds.settingsModal(w.id), { name: 'Unpeg', interval: '30', sweep: '120', ...over }, { channel: [CHANNEL], role: [] });
    expect(textOf(last(f.calls))).toContain(msg);
    expect(last(f.calls).type).toBe('reply');
    expect(isEphemeral(last(f.calls))).toBe(true);
    expect(store.getWatch(w.id)).toMatchObject({ name: 'Unpeg', intervalSec: 30, channelId: ALERTS });
    expect(mon.calls.updated).toHaveLength(0);
  });

  it('saves valid changes, notifies the monitor and updates the card in place', async () => {
    const w = makeWatch('https://unpeg.io/', { pingRoleId: ROLE });
    const f = await submit(PanelIds.settingsModal(w.id), { name: ' Unpeg  Main ', interval: '2s', sweep: '300' }, { channel: [CHANNEL], role: [] });
    expect(store.getWatch(w.id)).toMatchObject({ name: 'Unpeg Main', intervalSec: 2, sweepSec: 300, channelId: CHANNEL, pingRoleId: null });
    expect(mon.calls.updated).toHaveLength(1);
    const call = last(f.calls);
    expect(call.type).toBe('update');
    expect(call.payload.content).toContain('⚙️ Saved — name → **Unpeg Main** · interval 30s → 2s · full sweep 120s → 300s');
    expect(call.payload.content).toContain(`channel → <#${CHANNEL}>`);
    expect(call.payload.content).toContain('ping → none');
    expect(call.payload.embeds[0].title).toBe('🟢 Unpeg Main');

    const again = await submit(PanelIds.settingsModal(w.id), { name: 'Unpeg Main', interval: '2', sweep: '300' }, { channel: [CHANNEL], role: [] });
    expect(last(again.calls).payload.content).toBe('ℹ️ Nothing changed.');
    expect(mon.calls.updated).toHaveLength(1);

    await submit(PanelIds.settingsModal(w.id), { name: 'Unpeg Main', interval: '2', sweep: '300' }, { channel: [], role: [ROLE] });
    expect(store.getWatch(w.id)).toMatchObject({ channelId: CHANNEL, pingRoleId: ROLE });
  });

  it('replies (instead of updating) when the modal did not come from a message', async () => {
    const w = makeWatch();
    const f = await submit(PanelIds.settingsModal(w.id), { name: 'Unpeg', interval: '60', sweep: '120' }, {}, { fromMessage: false });
    expect(last(f.calls).type).toBe('reply');
    expect(isEphemeral(last(f.calls))).toBe(true);
    expect(store.getWatch(w.id)!.intervalSec).toBe(60);
  });
});

describe('rules modal', () => {
  it('opens prefilled one-per-line', async () => {
    const w = makeWatch('https://unpeg.io/', { ignorePatterns: ['Last updated.*', 'v\\d+'], excludePatterns: ['/blog/'], extraUrls: ['https://unpeg.io/secret'], scopePath: '/docs' });
    const f = await click(PanelIds.rules(w.id));
    const modal = last(f.calls).payload;
    expectModalLimits(modal);
    expect(field(modal, 'ignore')).toMatchObject({ value: 'Last updated.*\nv\\d+' });
    expect(field(modal, 'exclude').value).toBe('/blog/');
    expect(field(modal, 'extra').value).toBe('https://unpeg.io/secret');
    expect(field(modal, 'scope').value).toBe('/docs');
    expect(field(modal, 'max_pages').value).toBe('150');
  });

  it('validates patterns and URLs with friendly errors', async () => {
    const w = makeWatch();
    const base = { ignore: '', exclude: '', extra: '', scope: '', max_pages: '150' };
    const cases: Array<[Record<string, string>, string]> = [
      [{ ignore: 'ok\n(a+)+$' }, 'Ignore pattern `(a+)+$`: That pattern has nested repetition'],
      [{ ignore: '.*' }, 'matches whole lines'],
      [{ exclude: '.' }, 'Skip-URL pattern `.`: That pattern matches every URL'],
      [{ extra: '/fine\njavascript:alert(1)' }, 'is not a valid http(s) URL or path'],
      [{ scope: '/a b' }, 'path prefix'],
      [{ max_pages: '0' }, 'Max tracked pages must be a whole number between 1 and 1000'],
      [{ ignore: Array.from({ length: 26 }, (_, n) => `p${n}`).join('\n') }, 'At most 25 ignore patterns'],
    ];
    for (const [over, msg] of cases) {
      const f = await submit(PanelIds.rulesModal(w.id), { ...base, ...over });
      expect(textOf(last(f.calls)), JSON.stringify(over)).toContain(msg);
      expect(isEphemeral(last(f.calls))).toBe(true);
    }
    expect(store.getWatch(w.id)).toMatchObject({ ignorePatterns: [], excludePatterns: [], extraUrls: [], scopePath: null, maxPages: 150 });
    expect(mon.calls.updated).toHaveLength(0);
  });

  it('saves rules, resets page noise when ignore patterns change, and updates the card', async () => {
    const w = makeWatch();
    store.upsertPage(page(w.id, 'https://unpeg.io/', { dynamic: true, flapCount: 3 }));
    const f = await submit(PanelIds.rulesModal(w.id), {
      ignore: 'Last updated.*\n\nLast updated.*\n  \\d+ views  ',
      exclude: '/blog/\nunpeg\\.io/$',
      extra: '/docs/secret/\nunpeg.io/airdrop\nhttps://cdn.other.io/paper.pdf',
      scope: 'docs/',
      max_pages: '300',
    });
    const updated = store.getWatch(w.id)!;
    expect(updated).toMatchObject({
      ignorePatterns: ['Last updated.*', '\\d+ views'],
      excludePatterns: ['/blog/', 'unpeg\\.io/$'],
      extraUrls: ['https://unpeg.io/docs/secret', 'https://unpeg.io/airdrop', 'https://cdn.other.io/paper.pdf'],
      scopePath: '/docs',
      maxPages: 300,
    });
    expect(store.getPage(w.id, 'https://unpeg.io/')).toMatchObject({ dynamic: false, flapCount: 0, textHash: null });
    expect(mon.calls.updated).toHaveLength(1);
    const call = last(f.calls);
    expect(call.type).toBe('update');
    expect(call.payload.content).toContain('🚫 Rules saved — 2 ignore patterns · 2 skipped URL patterns · 3 extra pages · scope `/docs` · max 300 pages');
    expect(call.payload.content).toContain('`unpeg\\.io/$` also matches the start URL');
    expect(textOf(call)).toContain('2 ignore patterns');

    // Clearing only the extra pages leaves the ignore patterns (and their noise state) alone.
    store.upsertPage(page(w.id, 'https://unpeg.io/', { dynamic: true, flapCount: 3 }));
    await submit(PanelIds.rulesModal(w.id), { ignore: 'Last updated.*\n\\d+ views', exclude: '/blog/\nunpeg\\.io/$', extra: '', scope: '/docs', max_pages: '300' });
    expect(store.getWatch(w.id)!.extraUrls).toEqual([]);
    expect(store.getPage(w.id, 'https://unpeg.io/')!.dynamic).toBe(true);
  });

  it('keeps lists too long to prefill when their field is left empty', async () => {
    const long = Array.from({ length: 50 }, (_, n) => `https://unpeg.io/${'p'.repeat(90)}${n}`);
    const w = makeWatch('https://unpeg.io/', { extraUrls: long });
    const f = await click(PanelIds.rules(w.id));
    const modal = last(f.calls).payload;
    expectModalLimits(modal);
    expect(field(modal, 'extra').value).toBeUndefined();
    expect(field(modal, 'extra').placeholder).toContain('50 entries');
    await submit(PanelIds.rulesModal(w.id), { ignore: 'Footer', exclude: '', extra: '', scope: '', max_pages: '150' });
    expect(store.getWatch(w.id)).toMatchObject({ ignorePatterns: ['Footer'], extraUrls: long });
  });
});

describe('add site modal', () => {
  it('opens with URL, name, interval (default placeholder), channel and role selects', async () => {
    const f = await click(PanelIds.add, { ephemeral: false });
    const modal = last(f.calls).payload;
    expect(last(f.calls).type).toBe('modal');
    expectModalLimits(modal);
    expect(modal.components.map((l: any) => l.component.custom_id)).toEqual(['url', 'name', 'interval', 'channel', 'role']);
    expect(field(modal, 'url').required).toBe(true);
    expect(field(modal, 'interval').placeholder).toBe('2');
    expect(field(modal, 'channel').default_values).toEqual([{ id: CHANNEL, type: 'channel' }]);
  });

  it('happy path: validates, defers ephemerally, runs the first scan, replies with the summary and starts the watch', async () => {
    const f = await submit(PanelIds.addModal, { url: 'unpeg.io', name: 'Unpeg Main', interval: '5' }, { channel: [ALERTS], role: [ROLE] }, { ephemeral: false });
    const [w] = store.listWatches(GUILD);
    expect(w).toMatchObject({ url: 'https://unpeg.io/', name: 'Unpeg Main', intervalSec: 5, channelId: ALERTS, pingRoleId: ROLE, createdBy: USER, baselineDone: true });
    expect(f.calls[0].type).toBe('defer');
    expect(isEphemeral(f.calls[0])).toBe(true);
    expect(mon.calls.baseline).toEqual([w.id]);
    expect(mon.calls.added.map((x) => x.id)).toEqual([w.id]);
    const text = textOf(last(f.calls));
    expect(last(f.calls).type).toBe('edit');
    expect(text).toContain('✅ Watching Unpeg Main');
    expect(text).toContain(`https://unpeg.io/ in <#${ALERTS}> — every 5s`);
    expect(text).toContain(`Pinging <@&${ROLE}> on alerts`);
  });

  it('defaults: name from the domain, configured interval, the dashboard channel', async () => {
    await submit(PanelIds.addModal, { url: 'https://docs.example.com/guide', name: '', interval: '' }, { channel: [], role: [] });
    const [w] = store.listWatches(GUILD);
    expect(w).toMatchObject({ host: 'docs.example.com', intervalSec: 2, channelId: CHANNEL, pingRoleId: null });
  });

  it.each([
    [{ url: '' }, 'Enter the website URL'],
    [{ url: 'not a url' }, "doesn't look like a website URL"],
    [{ url: 'unpeg.io', interval: '1' }, 'between 2 and 3600 seconds'],
    [{ url: 'unpeg.io', name: '7' }, 'cannot be just a number'],
  ])('rejects %o before creating anything', async (text, msg) => {
    const f = await submit(PanelIds.addModal, { name: '', interval: '', ...text }, { channel: [], role: [] });
    expect(textOf(last(f.calls))).toContain(msg);
    expect(isEphemeral(last(f.calls))).toBe(true);
    expect(store.listWatches()).toHaveLength(0);
    expect(mon.calls.baseline).toHaveLength(0);
  });

  it('rejects duplicates', async () => {
    makeWatch();
    const f = await submit(PanelIds.addModal, { url: 'http://unpeg.io', name: '', interval: '' }, { channel: [], role: [] });
    expect(textOf(last(f.calls))).toContain('Already watching https://unpeg.io/');
    expect(store.listWatches()).toHaveLength(1);
  });

  it('unknown forms are rejected', async () => {
    const f = await submit('panel:m:nope', {});
    expect(textOf(last(f.calls))).toContain('no longer valid');
  });
});

describe('ignore-path button on new-page alerts', () => {
  it('adds a /folder/* skip rule, drops matching tracked pages and answers privately', async () => {
    const w = makeWatch('https://usepaid.app/');
    store.upsertPage(page(w.id, 'https://usepaid.app/profile/teslaaibot'));
    store.upsertPage(page(w.id, 'https://usepaid.app/docs'));
    const f = await click(`panel:exclude:${w.id}:/profile/*`, { ephemeral: false });
    const reply = last(f.calls);
    expect(reply.type).toBe('reply');
    expect(isEphemeral(reply)).toBe(true);
    expect(textOf(reply)).toContain('/profile/*');
    expect(textOf(reply)).toContain('1 tracked page dropped');
    expect(store.getWatch(w.id)?.excludePatterns).toEqual(['/profile/*']);
    expect(mon.calls.updated.at(-1)?.excludePatterns).toEqual(['/profile/*']);
    // Second click is a no-op.
    const again = await click(`panel:exclude:${w.id}:/profile/*`, { ephemeral: false });
    expect(textOf(last(again.calls))).toContain('already ignored');
    expect(store.getWatch(w.id)?.excludePatterns).toEqual(['/profile/*']);
  });

  it('requires Manage Server', async () => {
    const w = makeWatch('https://usepaid.app/');
    await click(`panel:exclude:${w.id}:/profile/*`, { manage: false, ephemeral: false });
    expect(store.getWatch(w.id)?.excludePatterns).toEqual([]);
  });
});
