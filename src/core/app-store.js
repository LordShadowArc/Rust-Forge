const path = require('path');
const { app } = require('electron');
const { ensureDir, readJson, writeJson, id, secret, rconSecret, safeName, clamp } = require('./util');

const SCHEMA_VERSION = 9;

const SERVER_DEFAULT_SCHEDULES = () => ({
  backup: {
    enabled: false,
    intervalHours: 24,
    retention: 7,
    safe: true,
    lastAt: null
  },
  wipe: {
    enabled: false,
    frequency: 'monthly',
    weekday: 4,
    hour: 19,
    blueprintWipe: false,
    forceBackup: true,
    lastAt: null
  }
});

const DEFAULT_SETTINGS = {
  startMinimized: false,
  closeToTray: true,
  rememberLastServer: true,
  autoUpdateRust: true,
  autoUpdateUmod: true,
  autoRestartCrashed: true,
  autoPluginDependencies: true,
  autoPluginUpdates: false,
  pluginUpdateCheckHours: 6,
  telemetryIntervalMs: 2000,
  consoleBuffer: 3000,
  statusPollMs: 1500,
  downloadConcurrency: 2,
  rconReconnectMs: 3000,
  schedulerPollMs: 15000,
  playitAutoStart: true
};

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}
function int(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(clamp(n, min, max)) : fallback;
}

const VALID_SERVER_TAGS = new Set(['monthly','biweekly','weekly','vanilla','hardcore','softcore','pve','roleplay','creative','minigame','training','battlefield','broyale','builds','tut','premium','NA','SA','EU','WA','EA','OC','AF']);
const TAG_GROUPS = [
  new Set(['monthly','biweekly','weekly']),
  new Set(['vanilla','hardcore','softcore']),
  new Set(['NA','SA','EU','WA','EA','OC','AF'])
];
function normalizeTags(value) {
  const input = Array.isArray(value) ? value : String(value ?? '').split(',');
  const out = [];
  for (const raw of input) {
    const tag = String(raw).trim();
    if (!tag || !VALID_SERVER_TAGS.has(tag) || out.includes(tag)) continue;
    const group = TAG_GROUPS.find(g => g.has(tag));
    if (group && out.some(existing => group.has(existing))) continue;
    out.push(tag);
    if (out.length >= 4) break;
  }
  return out;
}
function normalizeNetwork(value) {
  const src = value || {};
  return {
    mode: src.mode === 'playit' ? 'playit' : 'direct',
    secureBind: bool(src.secureBind, true),
    exposeQuery: bool(src.exposeQuery, false),
    publicGameAddress: String(src.publicGameAddress || '').trim().slice(0, 160),
    publicQueryAddress: String(src.publicQueryAddress || '').trim().slice(0, 160)
  };
}

class AppStore {
  constructor() {
    this.root = path.join(app.getPath('userData'), 'rust-forge');
    this.runtimeDir = path.join(this.root, 'runtime');
    this.steamcmdDir = path.join(this.runtimeDir, 'steamcmd');
    this.rustDir = path.join(this.runtimeDir, 'rust');
    this.serversDir = path.join(this.root, 'servers');
    this.backupsDir = path.join(this.root, 'backups');
    this.trashDir = path.join(this.root, 'trash');
    this.file = path.join(this.root, 'app.json');
    this.defaults = {
      schemaVersion: SCHEMA_VERSION,
      selectedServerId: null,
      settings: { ...DEFAULT_SETTINGS },
      servers: []
    };
    this.state = null;
    this.saveQueue = Promise.resolve();
  }

  async init() {
    await Promise.all([
      ensureDir(this.root),
      ensureDir(this.runtimeDir),
      ensureDir(this.steamcmdDir),
      ensureDir(this.rustDir),
      ensureDir(this.serversDir),
      ensureDir(this.backupsDir),
      ensureDir(this.trashDir)
    ]);

    const loaded = await readJson(this.file, {});
    const rawServers = Array.isArray(loaded?.servers) ? loaded.servers : [];
    this.state = {
      schemaVersion: SCHEMA_VERSION,
      selectedServerId: typeof loaded?.selectedServerId === 'string' ? loaded.selectedServerId : null,
      settings: this.normalizeSettings(loaded?.settings),
      servers: rawServers.map(server => this.migrateServer(server))
    };

    // Identity directories are the actual Rust data boundary. Never allow two
    // profiles loaded from an old/corrupt app.json to share the same identity.
    const used = new Set();
    for (const server of this.state.servers) {
      const baseIdentity = safeName(server.identity, 'server').toLowerCase();
      let identity = baseIdentity.slice(0, 32);
      let suffix = 2;
      while (used.has(identity)) {
        const tail = `-${suffix++}`;
        identity = `${baseIdentity.slice(0, Math.max(1, 32 - tail.length))}${tail}`.slice(0, 32);
      }
      if (identity !== server.identity) server.identity = identity;
      used.add(identity);
    }

    if (!this.state.servers.some(server => server.id === this.state.selectedServerId)) {
      this.state.selectedServerId = this.state.settings.rememberLastServer
        ? this.state.servers[0]?.id || null
        : null;
    }

    await this.save();
    return this.state;
  }

  normalizeSettings(input) {
    const src = input || {};
    return {
      ...DEFAULT_SETTINGS,
      startMinimized: bool(src.startMinimized, DEFAULT_SETTINGS.startMinimized),
      closeToTray: bool(src.closeToTray, DEFAULT_SETTINGS.closeToTray),
      rememberLastServer: bool(src.rememberLastServer, DEFAULT_SETTINGS.rememberLastServer),
      autoUpdateRust: bool(src.autoUpdateRust, DEFAULT_SETTINGS.autoUpdateRust),
      autoUpdateUmod: bool(src.autoUpdateUmod, DEFAULT_SETTINGS.autoUpdateUmod),
      autoRestartCrashed: bool(src.autoRestartCrashed, DEFAULT_SETTINGS.autoRestartCrashed),
      autoPluginDependencies: bool(src.autoPluginDependencies, DEFAULT_SETTINGS.autoPluginDependencies),
      autoPluginUpdates: bool(src.autoPluginUpdates, DEFAULT_SETTINGS.autoPluginUpdates),
      pluginUpdateCheckHours: int(src.pluginUpdateCheckHours, 6, 1, 24),
      telemetryIntervalMs: int(src.telemetryIntervalMs, 2000, 1000, 10000),
      consoleBuffer: int(src.consoleBuffer, 3000, 500, 15000),
      statusPollMs: int(src.statusPollMs, 1500, 750, 5000),
      downloadConcurrency: int(src.downloadConcurrency, 2, 1, 4),
      rconReconnectMs: int(src.rconReconnectMs, 3000, 1000, 10000),
      schedulerPollMs: int(src.schedulerPollMs, 15000, 5000, 60000),
      playitAutoStart: bool(src.playitAutoStart, DEFAULT_SETTINGS.playitAutoStart)
    };
  }

  migrateServer(server) {
    const schedules = SERVER_DEFAULT_SCHEDULES();
    const base = this.createServerDefaults({}, server);
    const startup = server?.startup || {};
    const migratedIdentity = safeName(server?.identity || base.identity, 'server').toLowerCase();
    return {
      ...base,
      ...server,
      identity: migratedIdentity,
      worldsize: int(server?.worldsize, base.worldsize, 1000, 6000),
      maxplayers: int(server?.maxplayers, base.maxplayers, 1, 500),
      seed: int(server?.seed, base.seed, 0, 2147483647),
      ports: {
        server: int(server?.ports?.server, base.ports.server, 1024, 65530),
        query: int(server?.ports?.query, base.ports.query, 1024, 65530),
        rcon: int(server?.ports?.rcon, base.ports.rcon, 1024, 65530)
      },
      saveInterval: int(server?.saveInterval, base.saveInterval, 30, 3600),
      bindIp: server?.network?.mode === 'playit' && server?.network?.secureBind !== false ? '127.0.0.1' : (typeof server?.bindIp === 'string' && server.bindIp.trim() ? server.bindIp.trim() : base.bindIp),
      url: String(server?.url ?? base.url).trim(),
      headerImage: String(server?.headerImage ?? base.headerImage).trim(),
      logoImage: String(server?.logoImage ?? base.logoImage).trim(),
      tags: normalizeTags(server?.tags ?? base.tags),
      network: normalizeNetwork(server?.network ?? base.network),
      rconPassword: typeof server?.rconPassword === 'string' && /^[A-Za-z0-9]{8,64}$/.test(server.rconPassword) ? server.rconPassword : rconSecret(32),
      performanceProfile: ['eco', 'balanced', 'performance', 'maximum'].includes(server?.performanceProfile) ? server.performanceProfile : 'balanced',
      schedules: {
        backup: {
          ...schedules.backup,
          ...(server?.schedules?.backup || {}),
          intervalHours: int(server?.schedules?.backup?.intervalHours, schedules.backup.intervalHours, 1, 720),
          retention: int(server?.schedules?.backup?.retention, schedules.backup.retention, 1, 90),
          enabled: bool(server?.schedules?.backup?.enabled, schedules.backup.enabled),
          safe: bool(server?.schedules?.backup?.safe, schedules.backup.safe),
          lastAt: Number.isFinite(Number(server?.schedules?.backup?.lastAt)) ? Number(server.schedules.backup.lastAt) : null
        },
        wipe: {
          ...schedules.wipe,
          ...(server?.schedules?.wipe || {}),
          enabled: bool(server?.schedules?.wipe?.enabled, schedules.wipe.enabled),
          frequency: ['weekly','biweekly','monthly'].includes(server?.schedules?.wipe?.frequency) ? server.schedules.wipe.frequency : schedules.wipe.frequency,
          hour: int(server?.schedules?.wipe?.hour, schedules.wipe.hour, 0, 23),
          weekday: int(server?.schedules?.wipe?.weekday, schedules.wipe.weekday, 0, 6),
          blueprintWipe: bool(server?.schedules?.wipe?.blueprintWipe, schedules.wipe.blueprintWipe),
          forceBackup: bool(server?.schedules?.wipe?.forceBackup, schedules.wipe.forceBackup),
          lastAt: Number.isFinite(Number(server?.schedules?.wipe?.lastAt)) ? Number(server.schedules.wipe.lastAt) : null
        }
      },
      startup: {
        phase: String(startup.phase || 'IDLE'),
        progress: int(startup.progress, 0, 0, 100),
        startedAt: Number.isFinite(Number(startup.startedAt)) ? Number(startup.startedAt) : null,
        readyAt: Number.isFinite(Number(startup.readyAt)) ? Number(startup.readyAt) : null
      },
      pid: Number.isInteger(Number(server?.pid)) ? Number(server.pid) : null,
      status: typeof server?.status === 'string' ? server.status : 'stopped',
      createdAt: Number.isFinite(Number(server?.createdAt)) ? Number(server.createdAt) : Date.now(),
      updatedAt: Date.now()
    };
  }

  async save() {
    const snapshot = typeof structuredClone === 'function'
      ? structuredClone(this.state)
      : JSON.parse(JSON.stringify(this.state));
    this.saveQueue = this.saveQueue.catch(() => {}).then(() => writeJson(this.file, snapshot));
    return this.saveQueue;
  }

  getServer(idValue) {
    return this.state.servers.find(server => server.id === idValue) || null;
  }

  async addServer(server) {
    const previousSelected = this.state.selectedServerId;
    this.state.servers.push(server);
    this.state.selectedServerId = server.id;
    try { await this.save(); }
    catch (error) {
      this.state.servers.pop();
      this.state.selectedServerId = previousSelected;
      throw error;
    }
    return server;
  }

  async removeServer(idValue) {
    const previousServers = this.state.servers;
    const previousSelected = this.state.selectedServerId;
    this.state.servers = previousServers.filter(server => server.id !== idValue);
    if (this.state.selectedServerId === idValue) {
      this.state.selectedServerId = this.state.servers[0]?.id || null;
    }
    try { await this.save(); }
    catch (error) {
      this.state.servers = previousServers;
      this.state.selectedServerId = previousSelected;
      throw error;
    }
  }

  async updateServer(idValue, patch) {
    const server = this.getServer(idValue);
    if (!server) throw new Error('Server profile not found.');
    const snapshot = typeof structuredClone === 'function' ? structuredClone(server) : JSON.parse(JSON.stringify(server));
    Object.assign(server, patch, { updatedAt: Date.now() });
    try { await this.save(); }
    catch (error) {
      Object.assign(server, snapshot);
      throw error;
    }
    return server;
  }

  createServerDefaults(input = {}, existing = null) {
    const sid = existing?.id || id('srv');
    const rawIdentity = input.identity || existing?.identity || sid.replace(/[^a-z0-9]/gi, '').slice(-18).toLowerCase();
    const identity = safeName(rawIdentity, 'server').toLowerCase();
    const schedules = SERVER_DEFAULT_SCHEDULES();
    const ports = existing?.ports || {};
    return {
      id: sid,
      name: String(input.name ?? existing?.name ?? 'Rust Forge Server').trim() || 'Rust Forge Server',
      identity,
      hostname: String(input.hostname ?? existing?.hostname ?? 'Rust Forge Server').trim() || 'Rust Forge Server',
      description: String(input.description ?? existing?.description ?? 'Managed by Rust Forge').trim(),
      map: String(input.map ?? existing?.map ?? 'Procedural Map').trim() || 'Procedural Map',
      seed: int(input.seed ?? existing?.seed, existing?.seed ?? Math.floor(Math.random() * 2147483647), 0, 2147483647),
      worldsize: int(input.worldsize ?? existing?.worldsize, existing?.worldsize ?? 3000, 1000, 6000),
      maxplayers: int(input.maxplayers ?? existing?.maxplayers, existing?.maxplayers ?? 10, 1, 500),
      ports: {
        server: int(input.serverPort ?? ports.server, 28015, 1024, 65530),
        query: int(input.queryPort ?? ports.query, 28016, 1024, 65530),
        rcon: int(input.rconPort ?? ports.rcon, 28017, 1024, 65530)
      },
      bindIp: String(input.bindIp ?? existing?.bindIp ?? '0.0.0.0').trim() || '0.0.0.0',
      url: String(input.url ?? existing?.url ?? '').trim(),
      headerImage: String(input.headerImage ?? existing?.headerImage ?? '').trim(),
      logoImage: String(input.logoImage ?? existing?.logoImage ?? '').trim(),
      tags: normalizeTags(input.tags ?? existing?.tags ?? []),
      network: normalizeNetwork(input.network ?? existing?.network),
      rconPassword: (() => {
        const candidate = String(input.rconPassword ?? existing?.rconPassword ?? '');
        return /^[A-Za-z0-9]{8,64}$/.test(candidate) ? candidate : rconSecret(32);
      })(),
      uMod: input.uMod !== undefined ? Boolean(input.uMod) : existing?.uMod !== false,
      autoRestart: input.autoRestart !== undefined ? Boolean(input.autoRestart) : Boolean(existing?.autoRestart),
      autoUpdate: input.autoUpdate !== undefined ? Boolean(input.autoUpdate) : existing?.autoUpdate !== false,
      saveInterval: int(input.saveInterval ?? existing?.saveInterval, existing?.saveInterval ?? 300, 30, 3600),
      performanceProfile: ['eco', 'balanced', 'performance', 'maximum'].includes(input.performanceProfile)
        ? input.performanceProfile
        : existing?.performanceProfile || 'balanced',
      performance: { priority: input.priority || existing?.performance?.priority || null },
      schedules: {
        backup: { ...schedules.backup, ...(existing?.schedules?.backup || {}), ...(input.schedules?.backup || {}) },
        wipe: { ...schedules.wipe, ...(existing?.schedules?.wipe || {}), ...(input.schedules?.wipe || {}) }
      },
      status: existing?.status || 'stopped',
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      pid: existing?.pid || null,
      lastExitCode: existing?.lastExitCode ?? null,
      lastLogFile: existing?.lastLogFile || null,
      startup: existing?.startup || { phase: 'IDLE', progress: 0, startedAt: null, readyAt: null }
    };
  }

  serverPath(server) { return path.join(this.serversDir, server.id); }
  serverIdentityPath(server) { return path.join(this.rustDir, 'server', server.identity); }
  serverLockPath(server) { return path.join(this.serverIdentityPath(server), 'oxide', 'forge-lock.json'); }
  serverBackupDir(server) { return path.join(this.backupsDir, server.id); }
}

module.exports = { AppStore, SERVER_DEFAULT_SCHEDULES, SCHEMA_VERSION };
