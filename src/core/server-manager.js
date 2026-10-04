const path = require('path');
const fs = require('fs');
const net = require('net');
const readline = require('readline');
const { EventEmitter } = require('events');
const {
  spawnHidden,
  ensureDir,
  isProcessAlive,
  fsp,
  killPid,
  pidAlive,
  isExpectedProcess,
  sleep,
  withTimeout,
  secret,
  rconSecret,
  clamp
} = require('./util');
const { nextFreePorts, nextFreeTcpPort, checkPort } = require('./ports');
const { applyPerformanceProfile } = require('./performance');

const ACTIVE_STATUSES = new Set(['running', 'running-external', 'starting', 'stopping']);
const VALID_PROFILES = new Set(['eco', 'balanced', 'performance', 'maximum']);
const VALID_SERVER_TAGS = new Set(['monthly','biweekly','weekly','vanilla','hardcore','softcore','pve','roleplay','creative','minigame','training','battlefield','broyale','builds','tut','premium','NA','SA','EU','WA','EA','OC','AF']);
const TAG_GROUPS = [new Set(['monthly','biweekly','weekly']), new Set(['vanilla','hardcore','softcore']), new Set(['NA','SA','EU','WA','EA','OC','AF'])];
const SERVER_CONFIG_KEYS = new Set([
  'name', 'hostname', 'description', 'map', 'seed', 'worldsize', 'maxplayers',
  'ports', 'bindIp', 'rconPassword', 'uMod', 'autoRestart', 'autoUpdate',
  'saveInterval', 'performanceProfile', 'performance', 'url', 'headerImage', 'logoImage', 'tags', 'network'
]);
function configQuote(value) {
  return `\"${String(value ?? '').replace(/\r?\n/g, ' ').replace(/\\/g, '\\\\').replace(/\"/g, '\\\"')}\"`;
}
const IDENTITY_RE = /^[a-z0-9_-]{1,32}$/;

function isActiveStatus(status) { return ACTIVE_STATUSES.has(status); }

class ServerManager extends EventEmitter {
  constructor(store, steamcmd, umod, rcon, telemetry, processLauncher = spawnHidden, playit = null) {
    super();
    this.store = store;
    this.steamcmd = steamcmd;
    this.umod = umod;
    this.rcon = rcon;
    this.telemetry = telemetry;
    this.processLauncher = processLauncher;
    this.playit = playit;

    this.children = new Map();
    this.external = new Map();
    this.starting = new Set();
    this.stopping = new Set();
    this.operations = new Map();
    this.lifecycleLocks = new Map();
    this.reservedPorts = new Set();
    this.deletingIdentities = new Set();
    this.runtimeQueue = Promise.resolve();
    // Serialize the entire shared Rust-runtime transaction. SteamCMD validate/update
    // can replace the Managed assemblies that uMod patches, so these operations must
    // never interleave with another server start/plugin sync/update.
    this.runtimePrepareQueue = Promise.resolve();
    this.runtimePreparationActive = null;
    this.logTails = new Map();
    this.intentionalStops = new Set();
    this.restartTimers = new Map();
    this.startupTimers = new Map();
    this.logDedupe = new Map();
    this.saveTimer = null;

  }

  async init() {
    const expected = path.join(this.store.rustDir, 'RustDedicated.exe');
    let dirty = false;
    for (const server of this.store.state.servers) {
      if (await isExpectedProcess(server.pid, expected)) {
        this.external.set(server.id, Number(server.pid));
        server.status = 'running';
        this.rcon?.autoConnect?.(server.id).catch(() => {});
      } else if (server.pid) {
        server.pid = null;
        server.status = 'stopped';
        server.startup = { phase: 'STOPPED', progress: 0, startedAt: null, readyAt: null };
        dirty = true;
      }
    }
    if (dirty) await this.store.save();
    await this.recoverPendingDeletions();
    this.emit('state', this.list());
    this.telemetry?.setProvider(() => this.list());
    this.telemetry?.start();
  }

  async recoverPendingDeletions() {
    const entries = await fsp.readdir(this.store.trashDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter(item => item.isDirectory())) {
      const staged = path.join(this.store.trashDir, entry.name);
      const markerPath = path.join(staged, '.rust-forge-delete.json');
      let marker = null;
      try { marker = JSON.parse(await fsp.readFile(markerPath, 'utf8')); } catch { continue; }
      const identityKey = String(marker.identity || '').toLowerCase();
      if (!identityKey) continue;
      this.deletingIdentities.add(identityKey);
      this.deleteServerData(staged, { name: marker.name || 'Removed server' })
        .then(() => this.deletingIdentities.delete(identityKey))
        .catch(error => this.emit('toast', {
          kind: 'error',
          title: 'Pending cleanup failed',
          message: `${marker.name || 'Removed server'} data is still preserved safely. ${error.message}`
        }));
    }
  }

  setRuntimeTelemetry() {
    this.telemetry?.setProvider(() => this.list());
  }

  withOperation(key, task) {
    if (this.operations.has(key)) return this.operations.get(key);
    const p = Promise.resolve().then(task).finally(() => {
      if (this.operations.get(key) === p) this.operations.delete(key);
    });
    this.operations.set(key, p);
    return p;
  }

  withLifecycle(id, task) {
    const previous = this.lifecycleLocks.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.lifecycleLocks.set(id, current);
    current.finally(() => {
      if (this.lifecycleLocks.get(id) === current) this.lifecycleLocks.delete(id);
    }).catch(() => {});
    return current;
  }

  queueRuntime(task) {
    const run = this.runtimeQueue.then(task, task);
    this.runtimeQueue = run.catch(() => {});
    return run;
  }

  queueRuntimePreparation(task) {
    // Startup/bootstrap/plugin repair may all ask for the shared runtime at the
    // same moment. Queueing alone would execute the same expensive preparation
    // twice. Coalesce overlapping callers onto one promise; later, non-overlapping
    // maintenance operations still run after the active transaction completes.
    if (this.runtimePreparationActive) return this.runtimePreparationActive;
    const run = this.runtimePrepareQueue.then(task, task);
    const tracked = run.finally(() => {
      if (this.runtimePreparationActive === tracked) this.runtimePreparationActive = null;
    });
    this.runtimePreparationActive = tracked;
    this.runtimePrepareQueue = tracked.catch(() => {});
    return tracked;
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.store.save().catch(() => {});
    }, 400);
  }

  normalizeServer(server) {
    const child = this.children.get(server.id);
    const externalPid = this.external.get(server.id);
    let runtimeStatus = 'stopped';
    if (this.stopping.has(server.id)) runtimeStatus = 'stopping';
    else if (this.starting.has(server.id)) runtimeStatus = 'starting';
    else if (child) runtimeStatus = 'running';
    else if (externalPid) runtimeStatus = 'running-external';

    return {
      ...server,
      runtimeStatus,
      runtimePid: child?.pid || externalPid || null,
      runtimeControl: child ? 'attached' : externalPid ? 'detached' : 'none'
    };
  }

  list() {
    return this.store.state.servers.map(server => this.normalizeServer(server));
  }

  async create(input = {}) {
    return this.withOperation('server:create', async () => {
      let reserved = await nextFreePorts(Number(input.serverPort) || 28015, 3);
      const conflicts = () => {
        const stored = this.store.state.servers.some(server =>
          Object.values(server.ports || {}).some(port => reserved.includes(Number(port)))
        );
        return stored || reserved.some(port => this.reservedPorts.has(port));
      };
      while (conflicts()) {
        reserved = await nextFreePorts(Math.max(...reserved) + 1, 3);
      }
      reserved.forEach(port => this.reservedPorts.add(port));

      try {
        const requestedIdentity = String(input.identity || '').trim().toLowerCase();
        const usedIdentities = new Set([
          ...this.store.state.servers.map(server => server.identity.toLowerCase()),
          ...this.deletingIdentities
        ]);
        let identity = requestedIdentity || null;
        if (identity && !IDENTITY_RE.test(identity)) identity = null;
        if (!identity) identity = `server-${Date.now().toString(36).slice(-8)}`;
        identity = identity.slice(0, 32);
        if (usedIdentities.has(identity)) {
          const base = identity;
          let n = 2;
          while (usedIdentities.has(identity)) {
            const tail = `-${n++}`;
            identity = `${base.slice(0, Math.max(1, 32 - tail.length))}${tail}`.slice(0, 32);
          }
        }

        const server = this.store.createServerDefaults({
          ...input,
          identity,
          serverPort: reserved[0],
          queryPort: reserved[1],
          rconPort: reserved[2]
        });
        const identityPath = this.store.serverIdentityPath(server);
        try {
          await ensureDir(identityPath);
          await ensureDir(path.join(identityPath, 'logs'));
          await this.addInitialFiles(server);
          await this.store.addServer(server);
          this.emit('state', this.list());
          return server;
        } catch (error) {
          await fsp.rm(identityPath, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
      } finally {
        reserved.forEach(port => this.reservedPorts.delete(port));
      }
    });
  }

  async addInitialFiles(server) {
    const identityPath = this.store.serverIdentityPath(server);
    await ensureDir(path.join(identityPath, 'cfg'));
    await ensureDir(path.join(identityPath, 'oxide', 'plugins'));
  }

  async remove(id, { deleteData = false } = {}) {
    return this.withLifecycle(id, async () => {
      const server = this.store.getServer(id);
      if (!server) throw new Error('Server profile not found.');

      const before = this.normalizeServer(server);
      const active = isActiveStatus(before.runtimeStatus);
      if (active) await this._stop(id, { reason: 'remove' });

      const target = this.store.serverIdentityPath(server);
      const identityKey = String(server.identity).toLowerCase();
      if (deleteData) this.deletingIdentities.add(identityKey);

      let staged = null;
      try {
        if (deleteData) staged = await this.stageForDeletion(target, server);

        await this.store.removeServer(id);
        this.children.delete(id);
        this.external.delete(id);
        this.starting.delete(id);
        this.stopping.delete(id);
        this.intentionalStops.delete(id);
        this.clearServerTimers(id);
        this.logTails.get(id)?.stop?.();
        this.logTails.delete(id);
        this.rcon?.disconnect(id);
        this.emit('state', this.list());

        if (deleteData && staged) {
          this.emit('progress', {
            stage: 'Cleanup',
            message: `${server.name} was removed. Data cleanup is continuing in the background…`
          });
          this.deleteServerData(staged, server)
            .then(() => this.deletingIdentities.delete(identityKey))
            .catch(error => {
              this.emit('toast', {
                kind: 'error',
                title: 'Data cleanup failed',
                message: `${error.message} The data was preserved and the identity remains reserved for safety.`
              });
            });
        } else if (deleteData) {
          this.deletingIdentities.delete(identityKey);
        }

        return this.list();
      } catch (error) {
        if (staged && staged !== target && fs.existsSync(staged) && !fs.existsSync(target)) {
          await fsp.rename(staged, target).catch(() => {});
        }
        this.deletingIdentities.delete(identityKey);
        throw error;
      }
    });
  }

  async stageForDeletion(target, server) {
    if (!fs.existsSync(target)) return null;
    await ensureDir(this.store.trashDir);
    const safe = server.id.replace(/[^a-z0-9_-]/gi, '-');
    const staged = path.join(this.store.trashDir, `${safe}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    let lastError = null;
    for (const delay of [0, 250, 750]) {
      if (delay) await sleep(delay);
      try {
        await fsp.rename(target, staged);
        try {
          await fsp.writeFile(path.join(staged, '.rust-forge-delete.json'), JSON.stringify({
            serverId: server.id,
            identity: server.identity,
            name: server.name,
            createdAt: Date.now()
          }, null, 2), 'utf8');
        } catch (error) {
          await fsp.rename(staged, target).catch(() => {});
          throw new Error(`Unable to record deletion metadata safely: ${error.message}`);
        }
        return staged;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Unable to stage server data for safe deletion: ${lastError?.message || 'rename failed'}`);
  }

  async deleteServerData(target, server) {
    await fsp.rm(target, { recursive: true, force: true });
    this.emit('progress', { stage: 'Cleanup', message: `${server.name} data removed.` });
  }

  clearServerTimers(id) {
    const restartTimer = this.restartTimers.get(id);
    if (restartTimer) clearTimeout(restartTimer);
    this.restartTimers.delete(id);
    const startupTimer = this.startupTimers.get(id);
    if (startupTimer) clearTimeout(startupTimer);
    this.startupTimers.delete(id);
  }

  async sanitizeWindowsRuntime(targetPlatform = process.platform) {
    if (targetPlatform !== 'win32') return;
    const managed = path.join(this.store.rustDir, 'RustDedicated_Data', 'Managed');
    if (!fs.existsSync(managed)) return;
    for (const name of [
      'Facepunch.Steamworks.Posix.dll',
      'Facepunch.Steamworks.Posix32.dll',
      'Facepunch.Steamworks.Posix64.dll',
      'Facepunch.Steamworks.Win32.dll'
    ]) {
      const file = path.join(managed, name);
      if (fs.existsSync(file)) await fsp.rm(file, { force: true }).catch(() => {});
    }
    const win64 = path.join(managed, 'Facepunch.Steamworks.Win64.dll');
    if (!fs.existsSync(win64)) {
      throw new Error('Windows Rust runtime is missing Facepunch.Steamworks.Win64.dll. Run Runtime Repair or Validate Runtime.');
    }
  }

  async ensureInstall(server, { updateExisting = false } = {}) {
    return this.queueRuntimePreparation(async () => {
      const exe = path.join(this.store.rustDir, 'RustDedicated.exe');
      const phase = (name, progress, message) => {
        this.setStartup(server, name, progress);
        this.emit('progress', { stage: 'Runtime', message });
      };

      phase('RUNTIME CHECK', 8, 'Checking Rust Dedicated runtime…');
      if (!fs.existsSync(exe)) {
        phase('INSTALLING STEAMCMD', 9, 'Rust Dedicated is not installed. Downloading and installing it in the background…');
        await withTimeout(this.queueRuntime(() => this.steamcmd.updateRust({ branch: 'public', validate: true })), 25 * 60 * 1000, 'Rust runtime installation');
        if (!fs.existsSync(exe)) throw new Error('RustDedicated.exe was not produced by SteamCMD.');
      }
      phase('RUST RUNTIME READY', 11, 'Rust Dedicated runtime is available.');
      if (updateExisting && fs.existsSync(exe) && this.store.state.settings.autoUpdateRust) {
        phase('CHECKING RUST UPDATE', 12, 'Checking the installed Rust Dedicated runtime for updates…');
        await withTimeout(this.queueRuntime(() => this.steamcmd.updateRust({ branch: 'public', validate: true })), 25 * 60 * 1000, 'Rust runtime update');
        if (!fs.existsSync(exe)) throw new Error('Rust runtime update completed without leaving RustDedicated.exe behind.');
        phase('RUST UPDATE READY', 13, 'Rust Dedicated runtime update check completed.');
      }

      // Rust/SteamCMD validation MUST finish before uMod installation. SteamCMD
      // validate can overwrite RustDedicated_Data/Managed and would otherwise erase
      // a freshly installed Oxide runtime immediately after installing it.
      phase('VALIDATING WINDOWS RUNTIME', 18, 'Validating the Windows Steamworks runtime…');
      if (process.platform === 'win32') {
        const win64 = path.join(this.store.rustDir, 'RustDedicated_Data', 'Managed', 'Facepunch.Steamworks.Win64.dll');
        if (!fs.existsSync(win64)) {
          phase('REPAIRING WINDOWS RUNTIME', 18, 'The Windows Steamworks assembly is missing. Repairing the runtime…');
          await withTimeout(this.queueRuntime(() => this.steamcmd.updateRust({ branch: 'public', validate: true })), 25 * 60 * 1000, 'Rust runtime repair');
        }
        await this.sanitizeWindowsRuntime();
      }

      // uMod is deliberately the FINAL runtime mutation before RustDedicated starts.
      // This removes the old install -> SteamCMD validate -> restore race entirely.
      if (server.uMod) {
        const marker = path.join(this.store.rustDir, 'RustDedicated_Data', 'Managed', 'Oxide.Core.dll');
        if (!fs.existsSync(marker)) {
          phase('INSTALLING UMOD', 19, 'uMod is missing. Installing the exact Windows build for this Rust runtime…');
          await withTimeout(this.queueRuntime(() => this.umod.installOrUpdate({ force: true })), 8 * 60 * 1000, 'uMod installation');
        } else if (updateExisting && this.store.state.settings.autoUpdateUmod) {
          phase('CHECKING UMOD', 19, 'Checking the installed uMod build…');
          await withTimeout(this.queueRuntime(() => this.umod.installOrUpdate({ force: false })), 8 * 60 * 1000, 'uMod update');
        }
      }

      phase('RUNTIME READY', 20, 'Runtime validation and uMod preparation completed.');
      return true;
    });
  }

  async ensureUmod() {
    // Never repair/validate Rust after uMod has been installed: SteamCMD validate
    // can replace patched assemblies and silently remove Oxide.
    await this.sanitizeWindowsRuntime();
    return this.queueRuntime(() => this.umod.installOrUpdate({ force: false }));
  }

  validateServerConfigPatch(patch) {
    for (const key of Object.keys(patch || {})) if (!SERVER_CONFIG_KEYS.has(key)) throw new Error(`Unsupported server setting: ${key}`);
    if (patch.name !== undefined && !String(patch.name).trim()) throw new Error('Display name cannot be empty.');
    if (patch.hostname !== undefined && !String(patch.hostname).trim()) throw new Error('Hostname cannot be empty.');
    if (patch.worldsize !== undefined && (Number(patch.worldsize) < 1000 || Number(patch.worldsize) > 6000)) throw new Error('World size must be between 1000 and 6000.');
    if (patch.maxplayers !== undefined && (Number(patch.maxplayers) < 1 || Number(patch.maxplayers) > 500)) throw new Error('Player count must be between 1 and 500.');
    if (patch.seed !== undefined && (!Number.isInteger(Number(patch.seed)) || Number(patch.seed) < 0 || Number(patch.seed) > 2147483647)) throw new Error('Seed must be an integer between 0 and 2147483647.');
    if (patch.saveInterval !== undefined && (Number(patch.saveInterval) < 30 || Number(patch.saveInterval) > 3600)) throw new Error('Save interval must be between 30 and 3600 seconds.');
    if (patch.bindIp !== undefined && net.isIP(String(patch.bindIp).trim()) === 0) throw new Error('Bind IP must be a valid IPv4 or IPv6 address.');
    for (const key of ['url','headerImage','logoImage']) {
      const value = String(patch[key] ?? '').trim();
      if (value && !/^https?:\/\//i.test(value)) throw new Error(`${key} must be an http(s) URL.`);
      if (value.length > 2000) throw new Error(`${key} is too long.`);
    }
    if (patch.tags !== undefined) {
      const tags = Array.isArray(patch.tags) ? patch.tags : String(patch.tags).split(',');
      if (tags.filter(x => String(x).trim()).length > 4) throw new Error('Rust exposes up to 4 server browser tags.');
      const seen = new Set();
      for (const raw of tags) {
        const tag = String(raw).trim();
        if (!tag) continue;
        if (!VALID_SERVER_TAGS.has(tag)) throw new Error(`Unsupported server browser tag: ${tag}`);
        const group = TAG_GROUPS.find(g => g.has(tag));
        if (group && [...seen].some(x => group.has(x))) throw new Error('Server browser tags contain two mutually exclusive values.');
        seen.add(tag);
      }
    }
    if (patch.network !== undefined) {
      if (!['direct','playit'].includes(patch.network.mode)) throw new Error('Network mode must be direct or playit.');
      if (patch.network.publicGameAddress !== undefined && String(patch.network.publicGameAddress).trim().length > 160) throw new Error('Public game address is too long.');
      if (patch.network.publicQueryAddress !== undefined && String(patch.network.publicQueryAddress).trim().length > 160) throw new Error('Public query address is too long.');
    }
    if (patch.performanceProfile !== undefined && !VALID_PROFILES.has(patch.performanceProfile)) throw new Error('Invalid performance profile.');
    if (patch.ports) {
      const p = patch.ports;
      for (const n of [p.server, p.query, p.rcon]) if (!Number.isInteger(Number(n)) || Number(n) < 1024 || Number(n) > 65530) throw new Error('All server ports must be valid ports between 1024 and 65530.');
    }
  }

  async writeServerConfig(server) {
    const cfgDir = path.join(this.store.serverIdentityPath(server), 'cfg');
    await ensureDir(cfgDir);
    const network = server.network || { mode: 'direct', secureBind: true, exposeQuery: false, publicGameAddress: '', publicQueryAddress: '' };
    const bindIp = network.mode === 'playit' && network.secureBind !== false ? '127.0.0.1' : server.bindIp;
    const lines = [
      `server.ip ${bindIp}`,
      `server.port ${Number(server.ports.server)}`,
      `server.queryport ${Number(server.ports.query)}`,
      `server.level ${configQuote(server.map)}`,
      `server.seed ${Number(server.seed)}`,
      `server.worldsize ${Number(server.worldsize)}`,
      `server.maxplayers ${Number(server.maxplayers)}`,
      `server.hostname ${configQuote(server.hostname)}`,
      `server.description ${configQuote(server.description)}`,
      server.url ? `server.url ${configQuote(server.url)}` : null,
      server.headerImage ? `server.headerimage ${configQuote(server.headerImage)}` : null,
      server.logoImage ? `server.logoimage ${configQuote(server.logoImage)}` : null,
      Array.isArray(server.tags) && server.tags.length ? `server.tags ${configQuote(server.tags.join(','))}` : null,
      `rcon.ip 127.0.0.1`,
      `rcon.port ${Number(server.ports.rcon)}`,
      `rcon.password ${server.rconPassword}`,
      'rcon.web 1',
      `server.saveinterval ${Number(server.saveInterval || 300)}`
    ].filter(Boolean);
    const file = path.join(cfgDir, 'server.cfg');
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temp, `${lines.join('\n')}\n`, 'utf8');
    await fsp.rename(temp, file);
  }

  buildArgs(server, logFile) {
    const args = [
      '-batchmode',
      '-nographics',
      '+server.identity',
      server.identity
    ];
    if (server.uMod !== false) {
      args.push('+oxide.directory', `server/${server.identity}/oxide`);
    }
    // RCON is deliberately supplied on the startup command line as well as in server.cfg.
    // This makes the credential available at the earliest Rust initialization phase, where
    // the server validates it before all cfg values are fully applied. Keep the generated
    // password alphanumeric-only to avoid parser edge cases.
    args.push(
      '+rcon.port', String(Number(server.ports.rcon)),
      '+rcon.password', String(server.rconPassword),
      '+rcon.web', '1'
    );
    args.push('-logfile', logFile);
    return args;
  }

  setStartup(server, phase, progress) {
    const requestedProgress = clamp(Number(progress) || 0, 0, 100);
    const currentProgress = clamp(Number(server.startup?.progress) || 0, 0, 100);
    const resetPhase = phase === 'PREPARING' || phase === 'STOPPED' || phase === 'STOPPING' || phase === 'FAILED';
    const effectiveProgress = resetPhase ? requestedProgress : Math.max(currentProgress, requestedProgress);
    const next = {
      ...(server.startup || {}),
      phase,
      progress: effectiveProgress
    };
    if (next.progress >= 100) next.readyAt = Date.now();
    if (server.startup?.phase === next.phase && Number(server.startup?.progress) === Number(next.progress)) return;
    server.startup = next;
    this.scheduleSave();
    this.emit('log', {
      id: server.id,
      source: 'Forge',
      line: `Startup milestone: ${phase} (${next.progress}%)`
    });
    this.emit('state', this.list());
  }

  scheduleStartupFallback(id) {
    const old = this.startupTimers.get(id);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.startupTimers.delete(id);
      const server = this.store.getServer(id);
      if (!server || !this.children.has(id) || !this.starting.has(id)) return;
      this.starting.delete(id);
      server.status = 'running';
      server.startup = {
        ...(server.startup || {}),
        phase: 'READY SIGNAL PENDING',
        progress: 95,
        readyAt: null
      };
      this.scheduleSave();
      this.emit('log', {
        id,
        source: 'Forge',
        line: 'Rust is still alive after the startup grace period. Treating the process as online while waiting for the final readiness signal.'
      });
      this.rcon?.autoConnect?.(id).catch(() => {});
      this.emit('state', this.list());
    }, 10 * 60 * 1000);
    this.startupTimers.set(id, timer);
  }

  async start(id) {
    return this.withOperation(`server:start:${id}`, () => this.withLifecycle(id, () => this._start(id, { ensureRuntime: true })));
  }

  async _start(id, { ensureRuntime = true } = {}) {
    const server = this.store.getServer(id);
    if (!server) throw new Error('Server profile not found.');
    if (this.children.has(id) || this.external.has(id) || this.starting.has(id)) return this.normalizeServer(server);

    this.starting.add(id);
    server.status = 'starting';
    server.startup = { phase: 'PREPARING', progress: 2, startedAt: Date.now(), readyAt: null };
    this.emit('lifecycle', { id, action: 'starting' });
    this.emit('progress', { stage: 'Server', message: `Preparing ${server.name}…` });
    this.emit('state', this.list());

    let child = null;
    try {
      await ensureDir(this.store.serverIdentityPath(server));
      await ensureDir(path.join(this.store.serverIdentityPath(server), 'logs'));
      if (server.network?.mode === 'playit' && this.playit && this.store.state.settings.playitAutoStart) {
        this.setStartup(server, 'PUBLIC ACCESS CHECK', 5);
        const playitState = await this.playit.ensureStarted();
        if (playitState.status === 'awaiting-claim') {
          this.emit('toast', { kind: 'info', title: 'Playit needs one-time claim', message: 'Open Settings → Network / Playit and complete the claim. The Rust server will continue to boot locally.' });
        }
      }
      if (ensureRuntime) {
        this.setStartup(server, 'RUNTIME CHECK', 8);
        await this.ensureInstall(server, { updateExisting: false });
      } else {
        this.setStartup(server, 'RUNTIME READY', 15);
      }
      this.setStartup(server, 'CONFIGURING', 15);

      if (typeof server.rconPassword !== 'string' || !/^[A-Za-z0-9]{8,64}$/.test(server.rconPassword)) {
        server.rconPassword = rconSecret(32);
        await this.store.save();
      }
      await this.prepareStartPorts(server);
      await this.writeServerConfig(server);

      const exe = path.join(this.store.rustDir, 'RustDedicated.exe');
      if (!fs.existsSync(exe)) throw new Error('RustDedicated.exe is missing after runtime preparation.');
      const logDir = path.join(this.store.serverIdentityPath(server), 'logs');
      const logFile = path.join(logDir, `rust-${Date.now()}.log`);
      await fsp.writeFile(logFile, '', 'utf8');

      child = this.processLauncher(exe, this.buildArgs(server, logFile), {
        cwd: this.store.rustDir,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.children.set(id, child);
      server.pid = child.pid;
      server.status = 'starting';
      server.lastExitCode = null;
      server.lastLogFile = logFile;
      await this.store.save();
      await applyPerformanceProfile(child.pid, server.performanceProfile);

      this.setStartup(server, 'PROCESS STARTED', 22);
      this.emit('log', { id, source: 'Forge', line: `RustDedicated started (PID ${child.pid}). Waiting for server readiness…` });
      this.scheduleStartupFallback(id);
      this.tailLog(id, logFile);

      const attach = (stream, source) => {
        const rl = readline.createInterface({ input: stream });
        rl.on('line', line => this.emitLogLine(id, source, line));
        return rl;
      };
      const stderrReader = attach(child.stderr, 'Rust');
      const stdoutReader = attach(child.stdout, 'Rust');
      let settled = false;
      const finish = async code => {
        if (settled) return;
        settled = true;
        stderrReader.close();
        stdoutReader.close();
        await this.markStopped(id, code);
      };
      child.once('error', async error => {
        this.emitLogLine(id, 'Rust', error.message);
        await finish(null);
      });
      child.once('close', async code => finish(code));
      this.rcon?.autoConnect?.(id).catch(() => {});
      this.emit('state', this.list());
      return this.normalizeServer(server);
    } catch (error) {
      this.intentionalStops.add(id);
      this.starting.delete(id);
      this.stopping.delete(id);
      this.clearServerTimers(id);
      if (child && isProcessAlive(child)) {
        try { child.stdin?.write('quit\n'); } catch {}
        const pid = child.pid;
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (await pidAlive(pid)) await killPid(pid);
        for (let i = 0; i < 12 && await pidAlive(pid); i++) await sleep(250);
      }
      this.children.delete(id);
      this.external.delete(id);
      this.intentionalStops.delete(id);
      server.status = 'stopped';
      server.pid = null;
      server.startup = { phase: 'FAILED', progress: 0, startedAt: server.startup?.startedAt || Date.now(), readyAt: null };
      await this.store.save().catch(() => {});
      await this.rcon?.disconnect(id).catch(() => {});
      this.emit('lifecycle', { id, action: 'failed', error: error.message });
      this.emit('state', this.list());
      throw error;
    }
  }

  updateStartupFromLine(server, line) {
    const text = String(line).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').toLowerCase();
    // Once Rust has reached READY, later startup chatter (asset warmup, bundle
    // messages, navmesh saves, etc.) must never downgrade the state back to a
    // loading phase. This was causing a healthy server to appear perpetually
    // stuck in LOADING ASSETS even after it was joinable.
    const currentPhase = String(server.startup?.phase || '');
    if (currentPhase === 'READY' || currentPhase.startsWith('READY ·')) return;
    const rconBindFailure = text.includes('facepunch.rcon') && text.includes('socketexception')
      || text.includes('rcon.listener.start') && text.includes('socketexception');
    if (rconBindFailure) {
      server.startup = { ...(server.startup || {}), rconWarning: `RCON could not bind TCP ${server.ports?.rcon}; the Rust game process may still continue.` };
      this.scheduleSave();
      this.emit('log', { id: server.id, source: 'Forge', line: `RCON bind warning detected on TCP ${server.ports?.rcon}; startup can continue without RCON.` });
      return;
    }
    if (text.includes('server startup complete') || text.includes('[bootstrap] completed')) {
      this.starting.delete(server.id);
      server.status = 'running';
      const warning = server.startup?.rconWarning;
      this.setStartup(server, warning ? 'READY · RCON OFFLINE' : 'READY', 100);
      if (warning) server.startup = { ...(server.startup || {}), readyAt: Date.now(), rconWarning: warning };
      const timer = this.startupTimers.get(server.id);
      if (timer) clearTimeout(timer);
      this.startupTimers.delete(server.id);
      this.rcon?.autoConnect?.(server.id).catch(() => {});
      return;
    }

    let phase = null;
    let progress = null;
    if (text.includes('loading map') || text.includes('generating world')) {
      phase = 'GENERATING WORLD'; progress = 50;
    } else if (text.includes('loading asset') || text.includes('bundle')) {
      phase = 'LOADING ASSETS'; progress = 35;
    } else if (text.includes('navmesh') || text.includes('creating terrain')) {
      phase = 'BUILDING NAVMESH'; progress = 72;
    } else if (text.includes('loading items') || text.includes('loading prefabs')) {
      phase = 'LOADING CONTENT'; progress = 85;
    } else if (text.includes('booting') || text.includes('starting server')) {
      phase = 'BOOTING'; progress = 25;
    }
    if (phase) this.setStartup(server, phase, progress);
  }

  emitLogLine(id, source, line) {
    const clean = String(line || '').replace(/\r/g, '').trimEnd();
    if (!clean) return;
    const key = `${id}:${source}:${clean}`;
    const now = Date.now();
    const last = this.logDedupe.get(key) || 0;
    if (now - last < 1200) return;
    this.logDedupe.set(key, now);
    if (this.logDedupe.size > 5000) this.logDedupe.delete(this.logDedupe.keys().next().value);
    this.emit('log', { id, source, line: clean });
    const server = this.store.getServer(id);
    if (server) this.updateStartupFromLine(server, clean);
  }

  tailLog(id, file) {
    const previous = this.logTails.get(id);
    previous?.stop?.();
    let position = 0;
    let timer = null;
    const poll = async () => {
      try {
        const stat = await fsp.stat(file);
        if (stat.size < position) position = 0;
        if (stat.size <= position) return;
        const handle = await fsp.open(file, 'r');
        try {
          const length = stat.size - position;
          const buffer = Buffer.allocUnsafe(length);
          await handle.read(buffer, 0, length, position);
          position = stat.size;
          for (const line of buffer.toString('utf8').split(/\r?\n/)) {
            this.emitLogLine(id, 'Rust', line);
          }
        } finally {
          await handle.close();
        }
      } catch {}
    };
    timer = setInterval(() => poll().catch(() => {}), 500);
    poll().catch(() => {});
    this.logTails.set(id, { stop: () => clearInterval(timer) });
  }

  async markStopped(id, code) {
    const hadRuntime = this.children.has(id) || this.external.has(id) || this.starting.has(id) || this.stopping.has(id);
    if (!hadRuntime) return;
    this.children.delete(id);
    this.external.delete(id);
    this.starting.delete(id);
    this.stopping.delete(id);
    const timer = this.startupTimers.get(id);
    if (timer) clearTimeout(timer);
    this.startupTimers.delete(id);
    this.logTails.get(id)?.stop?.();
    this.logTails.delete(id);

    const server = this.store.getServer(id);
    if (server) {
      server.pid = null;
      server.status = 'stopped';
      server.lastExitCode = code;
      server.startup = {
        phase: code === 0 || this.intentionalStops.has(id) ? 'STOPPED' : 'EXITED',
        progress: 0,
        startedAt: null,
        readyAt: null
      };
      await this.store.save().catch(() => {});
    }
    await this.rcon?.disconnect(id).catch(() => {});
    this.emit('lifecycle', { id, action: 'stopped', code });
    this.emit('state', this.list());

    const shouldRestart = server && code !== 0 && !this.intentionalStops.has(id)
      && server.autoRestart && this.store.state.settings.autoRestartCrashed;
    if (shouldRestart) this.scheduleRestart(id);
  }

  scheduleRestart(id) {
    if (this.restartTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.restartTimers.delete(id);
      this.start(id).catch(error => this.emit('lifecycle', {
        id, action: 'failed', error: `Automatic restart failed: ${error.message}`
      }));
    }, 5000);
    this.restartTimers.set(id, timer);
    this.emit('progress', {
      stage: 'Recovery',
      message: `${this.store.getServer(id)?.name || 'Server'} will restart automatically after an unexpected exit.`
    });
  }

  async stop(id, opts = {}) {
    return this.withLifecycle(id, () => this._stop(id, opts));
  }

  async _stop(id, { reason = 'manual' } = {}) {
    const server = this.store.getServer(id);
    if (!server) throw new Error('Server profile not found.');
    const child = this.children.get(id);
    const externalPid = this.external.get(id);
    if (!child && !externalPid) {
      await this.markStopped(id, null);
      return this.normalizeServer(server);
    }

    this.intentionalStops.add(id);
    this.stopping.add(id);
    this.starting.delete(id);
    server.status = 'stopping';
    this.emit('lifecycle', { id, action: 'stopping', reason });
    this.setStartup(server, 'STOPPING', 0);
    this.emit('state', this.list());

    if (externalPid && !child) {
      await killPid(externalPid);
      for (let i = 0; i < 20 && await pidAlive(externalPid); i++) await sleep(250);
      if (await pidAlive(externalPid)) {
        this.stopping.delete(id);
        this.intentionalStops.delete(id);
        throw new Error('Server process did not exit safely.');
      }
      await this.markStopped(id, null);
      this.intentionalStops.delete(id);
      return this.normalizeServer(server);
    }

    if (!isProcessAlive(child)) {
      await this.markStopped(id, null);
      this.intentionalStops.delete(id);
      return this.normalizeServer(server);
    }

    try { child.stdin.write('quit\n'); } catch {}
    const pid = child.pid;
    await new Promise(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(done, 15000);
      child.once('close', () => {
        clearTimeout(timer);
        done();
      });
    });

    if (await pidAlive(pid)) await killPid(pid);
    for (let i = 0; i < 20 && await pidAlive(pid); i++) await sleep(250);
    if (await pidAlive(pid)) {
      this.stopping.delete(id);
      this.intentionalStops.delete(id);
      throw new Error(`Unable to stop ${server.name} safely.`);
    }

    await this.markStopped(id, 0);
    this.intentionalStops.delete(id);
    return this.normalizeServer(server);
  }

  async restart(id) {
    return this.withLifecycle(id, async () => {
      await this._stop(id, { reason: 'restart' });
      return this._start(id);
    });
  }

  async command(id, command) {
    const child = this.children.get(id);
    const normalized = String(command || '').replace(/[\r\n]+/g, ' ').trim();
    if (!normalized) return null;
    this.emit('log', { id, source: 'Console', line: `> ${normalized}` });

    // Prefer WebRCON whenever it is connected; stdin is retained as a boot-time
    // fallback before RCON is available. A successful stdin write is not treated
    // as proof that Rust consumed the command, because Unity/Rust may not echo it.
    const rconStatus = this.rcon?.status?.(id);
    if (rconStatus?.connected) {
      const result = await this.rcon.command(id, normalized);
      const message = String(result?.Message || '').trim();
      if (message) this.emit('log', { id, source: 'RCON', line: message });
      return result;
    }
    if (!child || !isProcessAlive(child)) throw new Error('Server is not running and RCON is not connected.');
    try {
      child.stdin.write(`${normalized}\n`);
      this.emit('log', { id, source: 'Console', line: `Command sent to Rust stdin (RCON is not connected yet).` });
      return { sent: true, transport: 'stdin' };
    } catch (error) {
      throw new Error(`Could not send server command: ${error.message}`);
    }
  }

  async bootstrap() {
    return this.withOperation('runtime:bootstrap', async () => {
      let created = null;
      if (!this.store.state.servers.length) {
        created = await this.create({
          name: 'Rust Forge Server',
          hostname: 'Rust Forge Server',
          description: 'Managed by Rust Forge'
        });
      }
      const target = this.store.getServer(created?.id || this.store.state.selectedServerId)
        || this.store.state.servers[0];
      if (!target) throw new Error('No server profile is available for runtime setup.');

      const activeBefore = this.list().filter(isActiveStatus).map(item => item.id);
      for (const sid of activeBefore) await this.stop(sid, { reason: 'bootstrap-runtime' });
      try {
        this.setStartup(target, 'RUNTIME CHECK', 8);
        await this.ensureInstall(target, { updateExisting: true });
        if (created) await this.withLifecycle(created.id, () => this._start(created.id, { ensureRuntime: false }));
      } finally {
        for (const sid of activeBefore) {
          if (!this.store.getServer(sid)) continue;
          try { await this.withLifecycle(sid, () => this._start(sid, { ensureRuntime: false })); }
          catch (error) {
            this.emit('lifecycle', { id: sid, action: 'failed', error: `Automatic restart failed after bootstrap: ${error.message}` });
          }
        }
      }
      this.emit('lifecycle', { action: 'bootstrapped', id: created?.id || target.id });
      return this.list();
    });
  }

  async updateRuntime() {
    return this.withOperation('runtime:maintenance', () => this.queueRuntimePreparation(async () => {
      const running = this.list().filter(s => isActiveStatus(s.runtimeStatus)).map(s => s.id);
      for (const sid of running) await this.stop(sid, { reason: 'runtime-update' });
      try {
        await this.queueRuntime(() => this.steamcmd.updateRust({ branch: 'public', validate: true }));
        if (this.store.state.settings.autoUpdateUmod && this.store.state.servers.some(s => s.uMod)) {
          await this.queueRuntime(() => this.umod.installOrUpdate({ force: false }));
        }
      } finally {
        for (const sid of running) {
          try { await this.withLifecycle(sid, () => this._start(sid, { ensureRuntime: false })); }
          catch (error) {
            this.emit('lifecycle', { id: sid, action: 'failed', error: `Automatic restart failed after runtime update: ${error.message}` });
          }
        }
      }
      this.emit('lifecycle', { action: 'updated' });
      return this.list();
    }));
  }

  async updateServer() {
    return this.updateRuntime();
  }

  async prepareStartPorts(server) {
    const assignedByOtherProfile = (port, protocol) => this.store.state.servers.some(other => {
      if (other.id === server.id) return false;
      const candidate = protocol === 'tcp' ? other.ports?.rcon : (protocol === 'udp' ? [other.ports?.server, other.ports?.query] : []);
      return Array.isArray(candidate) ? candidate.map(Number).includes(Number(port)) : Number(candidate) === Number(port);
    });

    for (const [kind, protocol] of [['server', 'udp'], ['query', 'udp']]) {
      const port = Number(server.ports?.[kind]);
      if (assignedByOtherProfile(port, protocol) || !(await checkPort(port, protocol))) {
        throw new Error(`${kind === 'server' ? 'Game' : 'Query'} port ${port} is already in use. Choose another port in Server Config.`);
      }
    }

    const rconPort = Number(server.ports?.rcon);
    if (assignedByOtherProfile(rconPort, 'tcp') || !(await checkPort(rconPort, 'tcp'))) {
      const next = await nextFreeTcpPort(rconPort + 1, [server.ports.server, server.ports.query, ...this.store.state.servers.flatMap(s => Object.values(s.ports || {}))]);
      server.ports.rcon = next;
      await this.store.save();
      this.emit('log', { id: server.id, source: 'Forge', line: `RCON port ${rconPort} was unavailable; automatically reassigned to TCP ${next}.` });
      this.emit('toast', { kind: 'info', title: 'RCON port repaired', message: `${server.name}: TCP ${rconPort} was busy, so Forge selected ${next}.` });
      this.emit('state', this.list());
    }
    return server.ports;
  }

  async validatePorts(id, ports) {
    const values = [Number(ports?.server), Number(ports?.query), Number(ports?.rcon)];
    if (values.some(port => !Number.isInteger(port) || port < 1024 || port > 65530)) {
      throw new Error('All server ports must be valid ports between 1024 and 65530.');
    }
    if (new Set(values).size !== values.length) throw new Error('Game, Query and RCON ports must be different.');
    for (const other of this.store.state.servers) {
      if (other.id === id) continue;
      const used = Object.values(other.ports || {}).map(Number);
      if (values.some(port => used.includes(port))) throw new Error(`Port conflict: one of ${values.join(', ')} is already assigned to ${other.name}.`);
    }
    const currentServer = this.store.getServer(id);
    const current = [Number(currentServer?.ports?.server), Number(currentServer?.ports?.query), Number(currentServer?.ports?.rcon)];
    for (let index = 0; index < values.length; index += 1) {
      if (values[index] === current[index]) continue;
      const protocol = index < 2 ? 'udp' : 'tcp';
      if (!(await checkPort(values[index], protocol))) throw new Error(`Port ${values[index]} is already in use by another application.`);
    }
  }

  async reconcile() {
    for (const [id, pid] of [...this.external]) {
      if (!(await pidAlive(pid))) await this.markStopped(id, null);
    }
  }

  async syncUmod() {
    return this.withOperation('runtime:maintenance', () => this.queueRuntimePreparation(async () => {
      const running = this.list().filter(s => isActiveStatus(s.runtimeStatus)).map(s => s.id);
      for (const sid of running) await this.stop(sid, { reason: 'umod-sync' });
      try {
        const result = await this.queueRuntime(() => this.umod.installOrUpdate({ force: true }));
        const integrity = await this.umod.runtimeIntegrity();
        if (!integrity.ready) throw new Error(`uMod synchronization completed without a complete Windows Oxide runtime. Missing: ${integrity.missing.join(', ')}.`);
        return result;
      } finally {
        for (const sid of running) {
          try { await this.withLifecycle(sid, () => this._start(sid, { ensureRuntime: false })); }
          catch (error) { this.emit('lifecycle', { id: sid, action: 'failed', error: `Automatic restart failed after uMod sync: ${error.message}` }); }
        }
      }
    }));
  }

  async ensureUmodForPlugin(server) {
    if (!server) throw new Error('Server profile not found.');
    if (server.uMod === false) {
      throw new Error(`uMod is disabled for ${server.name}. Enable uMod in the server configuration before installing plugins.`);
    }

    const runtime = path.join(this.store.rustDir, 'RustDedicated.exe');
    if (!(await fs.promises.access(runtime).then(() => true).catch(() => false))) {
      await this.ensureInstall(server, { updateExisting: false });
    }

    const integrityBefore = typeof this.umod?.runtimeIntegrity === 'function'
      ? await this.umod.runtimeIntegrity()
      : { ready: await fs.promises.access(path.join(this.store.rustDir, 'RustDedicated_Data', 'Managed', 'Oxide.Core.dll')).then(() => true).catch(() => false), missing: [] };
    if (integrityBefore.ready) return { ready: true, synchronized: false };

    this.emit('progress', { stage: 'uMod', message: `Synchronizing uMod before installing a plugin for ${server.name}…` });
    await this.syncUmod();
    const integrity = typeof this.umod?.runtimeIntegrity === 'function'
      ? await this.umod.runtimeIntegrity()
      : { ready: await fs.promises.access(path.join(this.store.rustDir, 'RustDedicated_Data', 'Managed', 'Oxide.Core.dll')).then(() => true).catch(() => false), missing: [] };
    if (!integrity.ready) {
      const missing = integrity.missing?.length ? ` Missing: ${integrity.missing.join(', ')}.` : '';
      throw new Error(`uMod synchronization finished but the Windows Oxide runtime is still incomplete.${missing} Open Runtime Health for the exact repair source.`);
    }
    return { ready: true, synchronized: true };
  }

  async setConfig(id, patch) {
    return this.withLifecycle(id, async () => {
      const before = this.store.getServer(id);
      if (!before) throw new Error('Server profile not found.');
      const requestedInput = (patch && typeof patch === 'object') ? patch : {};
      // IPC transport envelopes occasionally carry the profile id alongside
      // the editable fields. Treat those fields as metadata, not settings, so
      // a harmless transport detail can never poison an otherwise valid save.
      if (requestedInput.id !== undefined && String(requestedInput.id) !== String(id)) {
        throw new Error('Server save target mismatch.');
      }
      if (requestedInput.serverId !== undefined && String(requestedInput.serverId) !== String(id)) {
        throw new Error('Server save target mismatch.');
      }
      const requested = { ...requestedInput };
      delete requested.id;
      delete requested.serverId;
      this.validateServerConfigPatch(requested);
      if (requested.ports) await this.validatePorts(id, requested.ports);

      const wasRunning = isActiveStatus(this.normalizeServer(before).runtimeStatus);
      const snapshot = typeof structuredClone === 'function' ? structuredClone(before) : JSON.parse(JSON.stringify(before));
      const candidate = {
        ...before,
        ...requested,
        ports: requested.ports ? { ...before.ports, ...requested.ports } : { ...before.ports },
        bindIp: requested.bindIp !== undefined ? String(requested.bindIp).trim() : before.bindIp,
        rconPassword: requested.rconPassword !== undefined ? String(requested.rconPassword) : before.rconPassword,
        network: { ...(before.network || { mode: 'direct', secureBind: true, exposeQuery: false, publicGameAddress: '', publicQueryAddress: '' }), ...(requested.network || {}) },
        tags: requested.tags !== undefined ? (Array.isArray(requested.tags) ? requested.tags.map(x => String(x).trim()).filter(Boolean) : String(requested.tags).split(',').map(x => x.trim()).filter(Boolean)) : (before.tags || [])
      };
      if (candidate.network?.mode === 'playit' && candidate.network?.secureBind !== false) candidate.bindIp = '127.0.0.1';
      if (!/^[A-Za-z0-9]{8,64}$/.test(candidate.rconPassword)) candidate.rconPassword = rconSecret(32);
      const candidateConfig = {};
      for (const key of SERVER_CONFIG_KEYS) {
        if (candidate[key] !== undefined) candidateConfig[key] = candidate[key];
      }
      this.validateServerConfigPatch(candidateConfig);

      let stopped = false;
      const rollback = async () => {
        Object.assign(before, snapshot);
        await ensureDir(this.store.serverIdentityPath(before)).catch(() => {});
        await this.writeServerConfig(before).catch(() => {});
        await this.store.save().catch(() => {});
        this.emit('state', this.list());
        if (wasRunning && !isActiveStatus(this.normalizeServer(before).runtimeStatus)) {
          await this._start(id, { ensureRuntime: false }).catch(() => {});
        }
      };

      try {
        if (wasRunning) {
          await this._stop(id, { reason: 'config-change' });
          stopped = true;
        }

        await ensureDir(this.store.serverIdentityPath(candidate));
        await this.writeServerConfig(candidate);
        Object.assign(before, candidate, { updatedAt: Date.now() });
        await this.store.save();

        // Enabling uMod is a runtime mutation, so it belongs to the same
        // transaction as the profile change. A failed framework preparation
        // must never leave the profile committed but unusable.
        const needsUmodPrep = snapshot.uMod === false && before.uMod !== false;
        if (needsUmodPrep) await this.ensureInstall(before);
        if (stopped) await this._start(id, { ensureRuntime: false });
      } catch (error) {
        await rollback();
        throw error;
      }

      this.emit('state', this.list());
      return this.normalizeServer(before);
    });
  }

  async setSchedules(id, schedules) {
    return this.withLifecycle(id, async () => {
      const server = this.store.getServer(id);
      if (!server) throw new Error('Server profile not found.');
      const current = server.schedules || {};
      const backup = schedules?.backup || {};
      const wipe = schedules?.wipe || {};
      const snapshot = typeof structuredClone === 'function' ? structuredClone(server.schedules) : JSON.parse(JSON.stringify(server.schedules));
      server.schedules = {
        backup: {
          ...current.backup,
          enabled: backup.enabled !== undefined ? Boolean(backup.enabled) : Boolean(current.backup?.enabled),
          intervalHours: Number.isFinite(Number(backup.intervalHours)) ? clamp(Number(backup.intervalHours), 1, 720) : Number(current.backup?.intervalHours) || 24,
          retention: Number.isFinite(Number(backup.retention)) ? clamp(Number(backup.retention), 1, 90) : Number(current.backup?.retention) || 7,
          safe: backup.safe !== undefined ? Boolean(backup.safe) : current.backup?.safe !== false,
          lastAt: Number.isFinite(Number(backup.lastAt)) ? Number(backup.lastAt) : current.backup?.lastAt || null
        },
        wipe: {
          ...current.wipe,
          enabled: wipe.enabled !== undefined ? Boolean(wipe.enabled) : Boolean(current.wipe?.enabled),
          frequency: ['weekly', 'biweekly', 'monthly'].includes(wipe.frequency) ? wipe.frequency : current.wipe?.frequency || 'monthly',
          hour: Number.isFinite(Number(wipe.hour)) ? clamp(Number(wipe.hour), 0, 23) : (Number.isFinite(Number(current.wipe?.hour)) ? clamp(Number(current.wipe.hour), 0, 23) : 19),
          weekday: Number.isFinite(Number(wipe.weekday)) ? clamp(Number(wipe.weekday), 0, 6) : (Number.isFinite(Number(current.wipe?.weekday)) ? clamp(Number(current.wipe.weekday), 0, 6) : 4),
          blueprintWipe: wipe.blueprintWipe !== undefined ? Boolean(wipe.blueprintWipe) : Boolean(current.wipe?.blueprintWipe),
          forceBackup: wipe.forceBackup !== undefined ? Boolean(wipe.forceBackup) : current.wipe?.forceBackup !== false,
          lastAt: Number.isFinite(Number(wipe.lastAt)) ? Number(wipe.lastAt) : current.wipe?.lastAt || null
        }
      };
      try { await this.store.save(); }
      catch (error) {
        server.schedules = snapshot;
        throw error;
      }
      this.emit('state', this.list());
      return this.normalizeServer(server);
    });
  }

  async setPerformanceProfile(id, profile, { apply = true } = {}) {
    return this.withLifecycle(id, async () => {
      const server = this.store.getServer(id);
      if (!server) throw new Error('Server profile not found.');
      if (!VALID_PROFILES.has(profile)) throw new Error('Invalid performance profile.');
      const previous = server.performanceProfile;
      server.performanceProfile = profile;
      try { await this.store.save(); }
      catch (error) { server.performanceProfile = previous; throw error; }
      const runtime = this.normalizeServer(server);
      let result = { applied: false, profile };
      if (apply && runtime.runtimePid) result = await applyPerformanceProfile(runtime.runtimePid, profile);
      this.emit('state', this.list());
      return { ...runtime, performanceProfile: profile, performanceApplied: Boolean(result?.applied) };
    });
  }

  async select(id) {
    if (!this.store.getServer(id)) throw new Error('Server profile not found.');
    const previous = this.store.state.selectedServerId;
    this.store.state.selectedServerId = this.store.state.settings.rememberLastServer ? id : null;
    try { await this.store.save(); }
    catch (error) { this.store.state.selectedServerId = previous; throw error; }
    this.emit('state', this.list());
    return this.store.getServer(id);
  }

  async applyPerformance(id) {
    const server = this.store.getServer(id);
    if (!server) throw new Error('Server profile not found.');
    const runtime = this.normalizeServer(server);
    if (!runtime.runtimePid) throw new Error('Server is not running.');
    return applyPerformanceProfile(runtime.runtimePid, server.performanceProfile);
  }
}

module.exports = { ServerManager, ACTIVE_STATUSES, isActiveStatus };
