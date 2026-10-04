const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { EventEmitter } = require('events');
const { spawnHidden, ensureDir, killPid, pidAlive } = require('./util');

const PLAYIT_STABLE = {
  version: '1.0.10',
  platform: 'windows-x86_64',
  url: 'https://github.com/playit-cloud/playit-agent/releases/download/v1.0.10/playit-windows-x86_64.exe',
  sha256: '97ad38fcbd1c4fafcb84a99c0b1b1ba216f76ef5372ae2f6ef142652a1239ad4'
};

function download(url, file, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many Playit download redirects.'));
    const request = https.get(url, { headers: { 'User-Agent': 'Rust-Forge/1.0.0' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve(download(new URL(response.headers.location, url).toString(), file, redirectCount + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Playit download failed with HTTP ${response.statusCode}.`));
      }
      const out = fs.createWriteStream(file, { flags: 'w' });
      const hash = crypto.createHash('sha256');
      response.on('data', chunk => hash.update(chunk));
      response.on('error', error => { out.destroy(); reject(error); });
      out.on('error', reject);
      out.on('finish', () => resolve(hash.digest('hex')));
      response.pipe(out);
    });
    request.setTimeout(30000, () => request.destroy(new Error('Playit download timed out.')));
    request.on('error', reject);
  });
}

class PlayitManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.dir = path.join(store.runtimeDir, 'playit');
    this.exe = path.join(this.dir, 'playit.exe');
    this.child = null;
    this.claimUrl = null;
    this.lastLine = '';
    this.startedAt = null;
    this.lifecycleState = 'stopped';
    this.installPromise = null;
    this.startPromise = null;
  }

  snapshot() {
    const running = Boolean(this.child && this.child.exitCode === null && !this.child.killed);
    return {
      status: running ? this.lifecycleState : (fs.existsSync(this.exe) ? 'stopped' : 'not-installed'),
      version: PLAYIT_STABLE.version,
      managedPath: this.exe,
      claimUrl: this.claimUrl,
      lastLine: this.lastLine,
      startedAt: this.startedAt
    };
  }

  emitState() { this.emit('state', this.snapshot()); }

  async status() {
    const snapshot = this.snapshot();
    this.emit('state', snapshot);
    return snapshot;
  }

  async ensureInstalled() {
    if (this.installPromise) return this.installPromise;
    this.installPromise = (async () => {
      await ensureDir(this.dir);
      if (process.platform !== 'win32') throw new Error('Managed Playit agent download is currently available only on Windows.');
      if (fs.existsSync(this.exe)) {
        try {
          const existing = (await new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(this.exe);
            stream.on('data', chunk => hash.update(chunk));
            stream.on('error', reject);
            stream.on('end', () => resolve(hash.digest('hex')));
          })).toLowerCase();
          if (existing === PLAYIT_STABLE.sha256.toLowerCase()) return this.exe;
          await fs.promises.unlink(this.exe).catch(() => {});
        } catch {
          await fs.promises.unlink(this.exe).catch(() => {});
        }
      }
      const tmp = `${this.exe}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        const digest = await download(PLAYIT_STABLE.url, tmp);
        if (digest.toLowerCase() !== PLAYIT_STABLE.sha256.toLowerCase()) throw new Error('Playit download checksum verification failed; the executable was discarded.');
        await fs.promises.chmod(tmp, 0o755).catch(() => {});
        await fs.promises.rename(tmp, this.exe);
      } catch (error) {
        await fs.promises.unlink(tmp).catch(() => {});
        throw error;
      }
      this.emit('log', { line: `Playit ${PLAYIT_STABLE.version} downloaded and checksum verified.` });
      this.emitState();
      return this.exe;
    })();
    try { return await this.installPromise; }
    finally { this.installPromise = null; }
  }

  parseLine(line) {
    this.lastLine = String(line).trim().slice(-500);
    const match = this.lastLine.match(/https:\/\/playit\.gg\/(?:claim|agents\/claim)\/[A-Za-z0-9/_-]+/i);
    if (match) {
      this.claimUrl = match[0];
      this.lifecycleState = 'awaiting-claim';
      this.emit('claim', this.claimUrl);
    } else if (/claim.*required|authenticate|link.*account|no.*secret/i.test(this.lastLine)) {
      this.lifecycleState = 'awaiting-claim';
    } else if (/tunnel.*ready|connected|agent.*ready|running/i.test(this.lastLine)) {
      this.lifecycleState = 'running';
    }
    this.emit('log', { line: this.lastLine });
    this.emitState();
  }

  async ensureStarted() {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.snapshot();
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      if (this.child && this.child.exitCode === null && !this.child.killed) return this.snapshot();
      const exe = await this.ensureInstalled();
      this.claimUrl = null;
      this.lifecycleState = 'starting';
      const child = spawnHidden(exe, [], {
        cwd: this.dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      });
      this.child = child;
      this.startedAt = Date.now();
      const attach = stream => {
        if (!stream) return;
        stream.on('data', chunk => String(chunk).split(/\r?\n/).forEach(line => { if (line.trim()) this.parseLine(line); }));
      };
      attach(child.stdout);
      attach(child.stderr);
      child.once('error', error => {
        if (this.child === child) this.child = null;
        this.lifecycleState = 'error';
        this.emit('log', { line: `Playit agent error: ${error.message}` });
        this.emitState();
      });
      child.once('close', code => {
        if (this.child === child) this.child = null;
        this.lifecycleState = 'stopped';
        this.emit('log', { line: `Playit agent exited with code ${code}.` });
        this.emitState();
      });
      this.emitState();
      return this.snapshot();
    })();
    try { return await this.startPromise; }
    finally { this.startPromise = null; }
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (!child) return this.snapshot();
    const pid = child.pid;
    this.lifecycleState = 'stopping';
    try { child.kill(); } catch {}
    if (pid) {
      for (let i = 0; i < 20; i++) {
        if (!(await pidAlive(pid))) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (await pidAlive(pid)) await killPid(pid);
    }
    this.lifecycleState = 'stopped';
    this.emitState();
    return this.snapshot();
  }

  async openDashboard(shell) {
    await shell.openExternal('https://playit.gg/');
    return true;
  }

  async openClaim(shell) {
    if (!this.claimUrl) throw new Error('No pending Playit claim URL is available.');
    await shell.openExternal(this.claimUrl);
    return true;
  }
}

module.exports = { PlayitManager, PLAYIT_STABLE };
