const path = require('path');
const { Worker } = require('worker_threads');
const { ensureDir, exists, fsp } = require('./util');

const ACTIVE = new Set(['running', 'running-external', 'starting', 'stopping']);

class BackupManager {
  constructor(store, emit = () => {}, serverManager = null) {
    this.store = store;
    this.emit = emit;
    this.serverManager = serverManager;
    this.jobs = new Map();
  }

  backupRoot(server) { return this.store.serverBackupDir(server); }

  enqueue(server, task) {
    const previous = this.jobs.get(server.id) || Promise.resolve();
    const current = previous.catch(() => {}).then(task).finally(() => {
      if (this.jobs.get(server.id) === current) this.jobs.delete(server.id);
    });
    this.jobs.set(server.id, current);
    return current;
  }

  withLifecycle(server, task) {
    if (!this.serverManager?.withLifecycle) return task();
    return this.serverManager.withLifecycle(server.id, task);
  }

  async create(server, { reason = 'manual', quiesce = true } = {}) {
    return this.enqueue(server, () => this.withLifecycle(server, () => this._create(server, { reason, quiesce })));
  }

  async _create(server, { reason, quiesce }) {
    const wasRunning = ACTIVE.has(this.serverManager?.normalizeServer(server).runtimeStatus);
    if (quiesce && wasRunning && this.serverManager) await this.serverManager._stop(server.id, { reason: `backup:${reason}` });

    const destDir = this.backupRoot(server);
    await ensureDir(destDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const output = path.join(destDir, `${server.identity}-${stamp}.zip`);
    this.emit({ type: 'progress', stage: 'Backup', message: `Creating ${server.name} backup (${reason})…` });

    try {
      await new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'backup-worker.js'), {
          workerData: {
            source: this.store.serverIdentityPath(server),
            output,
            identity: server.identity,
            name: server.name
          }
        });
        let done = false;
        const finish = (fn, value) => {
          if (done) return;
          done = true;
          fn(value);
        };
        worker.on('message', msg => {
          if (msg?.type === 'progress') this.emit({ type: 'progress', stage: 'Backup', message: msg.message });
          if (msg?.type === 'done') finish(resolve, msg);
          if (msg?.type === 'error') finish(reject, new Error(msg.error));
        });
        worker.on('error', error => finish(reject, error));
        worker.on('exit', code => {
          if (code !== 0) finish(reject, new Error(`Backup worker exited with code ${code}.`));
        });
      });
      await this.prune(server, Number(server.schedules?.backup?.retention) || 7);
      return { output, reason };
    } finally {
      if (quiesce && wasRunning && this.serverManager) {
        if (!ACTIVE.has(this.serverManager.normalizeServer(server).runtimeStatus)) {
          await this.serverManager._start(server.id, { ensureRuntime: false }).catch(error => this.emit({
            type: 'toast', kind: 'error', title: 'Backup restart failed', message: error.message
          }));
        }
      }
    }
  }

  async prune(server, retention) {
    const dir = this.backupRoot(server);
    if (!(await exists(dir))) return;
    const files = (await fsp.readdir(dir))
      .filter(name => name.toLowerCase().endsWith('.zip'))
      .sort()
      .reverse();
    for (const file of files.slice(Math.max(0, retention))) {
      await fsp.unlink(path.join(dir, file)).catch(() => {});
    }
  }

  async wipe(server, { blueprintWipe = false, forceBackup = true } = {}) {
    return this.enqueue(server, () => this.withLifecycle(server, () => this._wipe(server, { blueprintWipe, forceBackup })));
  }

  async _wipe(server, { blueprintWipe, forceBackup }) {
    const wasRunning = ACTIVE.has(this.serverManager?.normalizeServer(server).runtimeStatus);

    // A backup must remain fully quiesced until the world files are wiped.
    // create(..., { quiesce:false }) is used because this method already owns
    // the lifecycle lock and has explicitly stopped the server.
    if (wasRunning && this.serverManager) await this.serverManager._stop(server.id, { reason: 'pre-wipe' });
    if (forceBackup) await this._create(server, { reason: 'pre-wipe', quiesce: false });

    const dir = this.store.serverIdentityPath(server);
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const remove = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (/\.sav$|\.map$/i.test(entry.name)) remove.push(entry.name);
      if (blueprintWipe && entry.name === 'player.blueprints') remove.push(entry.name);
    }

    for (const name of remove) await fsp.rm(path.join(dir, name), { force: true });
    this.emit({
      type: 'progress',
      stage: 'Wipe',
      message: `Wipe complete for ${server.name}. Removed ${remove.length} world file(s).`
    });

    if (wasRunning && this.serverManager) await this.serverManager._start(server.id, { ensureRuntime: false });
    return { removed: remove };
  }
}

module.exports = { BackupManager };
