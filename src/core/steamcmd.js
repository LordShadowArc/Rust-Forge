const path = require('path');
const { ensureDir, exists, spawnHidden, fsp, killPid } = require('./util');
const AdmZip = require('adm-zip');

const STEAMCMD_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';
const RUST_APP_ID = '258550';
const USER_AGENT = 'Rust-Forge/1.0.0';
const STEAMCMD_PROCESS_TIMEOUT_MS = 20 * 60 * 1000;
const NETWORK_TIMEOUT_MS = 120000;

async function fetchWithTimeout(url, options = {}, timeoutMs = NETWORK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Network request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    throw error;
  } finally { clearTimeout(timer); }
}

function summarizeOutput(output) {
  const text = String(output || '');
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const interesting = lines.filter(line => /error|failed|failure|no subscription|disk write|missing configuration|not found|timeout|timed out|success!|already up to date/i.test(line));
  return (interesting.length ? interesting : lines.slice(-10)).slice(-14).join(' | ');
}

function classifyFailure(output, code) {
  const text = String(output || '').toLowerCase();
  if (/no subscription/.test(text)) return 'SteamCMD could not access the Rust dedicated server anonymously. Forge will retry after refreshing Steam metadata.';
  if (/disk write|state is 0x202|failed to write app state|permission denied|access is denied/.test(text)) return 'SteamCMD could not write the Rust installation. Check free disk space, Windows Security/Ransomware protection, and folder permissions.';
  if (/missing configuration|app info|appinfo/.test(text)) return 'SteamCMD did not have fresh Rust app metadata yet. Forge refreshed metadata automatically, but Steam did not provide a usable app manifest.';
  if (/timed out|timeout|failed to connect|connection/.test(text)) return 'SteamCMD could not complete its connection to Steam. Check the network connection and try again.';
  return `SteamCMD stopped with exit code ${code}. ${summarizeOutput(output) || 'No additional diagnostic output was provided.'}`;
}

class SteamCmdProvider {
  constructor(store, emit = () => {}) {
    this.store = store;
    this.emit = emit;
    this.steamcmdExe = path.join(store.steamcmdDir, 'steamcmd.exe');
    this.busy = false;
    this.currentRun = null;
  }

  async downloadSteamCmd() {
    if (await exists(this.steamcmdExe)) return;
    await ensureDir(this.store.steamcmdDir);
    this.emit({ type: 'progress', stage: 'SteamCMD', message: 'Downloading SteamCMD…' });
    const res = await fetchWithTimeout(STEAMCMD_URL, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`SteamCMD download failed (${res.status}).`);
    const data = Buffer.from(await res.arrayBuffer());
    const zipPath = path.join(this.store.steamcmdDir, 'steamcmd.zip');
    await fsp.writeFile(zipPath, data);
    try { new AdmZip(zipPath).extractAllTo(this.store.steamcmdDir, true); }
    finally { await fsp.unlink(zipPath).catch(() => {}); }
    if (!(await exists(this.steamcmdExe))) throw new Error('SteamCMD downloaded but steamcmd.exe was not found after extraction.');
  }

  async run(args, { allowRetry = true } = {}) {
    if (this.currentRun) return this.currentRun;
    const operation = (async () => {
      this.busy = true;
      try { return await this._runOnce(args, allowRetry); }
      finally { this.busy = false; this.currentRun = null; }
    })();
    this.currentRun = operation;
    return operation;
  }

  async _runOnce(args, allowRetry) {
    await ensureDir(this.store.steamcmdDir);
    const output = [];
    const run = () => new Promise((resolve, reject) => {
      this.emit({ type: 'progress', stage: 'SteamCMD', message: 'Launching SteamCMD in the background…' });
      const child = spawnHidden(this.steamcmdExe, args, { cwd: this.store.steamcmdDir, stdio: ['ignore', 'pipe', 'pipe'] });
      this.emit({ type: 'log', source: 'SteamCMD', line: `Started SteamCMD (PID ${child.pid || 'unknown'}).` });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.emit({ type: 'progress', stage: 'SteamCMD', message: 'SteamCMD exceeded the safety timeout. Stopping the worker…' });
        killPid(child.pid).catch(() => {});
        reject(new Error('SteamCMD exceeded the 20 minute safety timeout and was stopped.'));
      }, STEAMCMD_PROCESS_TIMEOUT_MS);
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
      const onData = buffer => {
        const text = buffer.toString();
        output.push(text);
        this.emit({ type: 'log', source: 'SteamCMD', line: text });
        if (/Downloading|Update state \(|progress:/i.test(text)) this.emit({ type: 'progress', stage: 'Rust Runtime', message: text.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || 'SteamCMD is downloading Rust…' });
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', err => finish(reject, err));
      child.once('close', code => { this.emit({ type: 'log', source: 'SteamCMD', line: `SteamCMD exited with code ${code}.` }); finish(resolve, { code, output: output.join('') }); });
    });

    const result = await run();
    const text = result.output;
    const successMarker = /Success! App ['"]?258550['"]?\s+(fully installed|already up to date)/i.test(text) || /App '258550' fully installed/i.test(text) || /already up to date/i.test(text);
    if (result.code === 0 || successMarker) return { ...result, ok: true };

    if (allowRetry && [7, 8].includes(Number(result.code))) {
      this.emit({ type: 'progress', stage: 'SteamCMD', message: `SteamCMD returned exit code ${result.code}; refreshing app metadata and retrying once…` });
      const retryArgs = [
        '+@ShutdownOnFailedCommand', '1',
        '+@NoPromptForPassword', '1',
        '+app_info_update', '1',
        ...args
      ];
      return this._runOnce(retryArgs, false);
    }
    throw new Error(classifyFailure(text, result.code));
  }

  async updateRust({ branch = 'public', validate = true } = {}) {
    await this.downloadSteamCmd();
    await ensureDir(this.store.rustDir);
    this.emit({ type: 'progress', stage: 'Rust Runtime', message: 'Updating Rust Dedicated Server… SteamCMD is working in the background.' });
    const args = [
      '+@ShutdownOnFailedCommand', '1',
      '+@NoPromptForPassword', '1',
      '+sSteamCmdForcePlatformType', 'windows',
      '+force_install_dir', this.store.rustDir,
      '+login', 'anonymous',
      '+app_update', RUST_APP_ID
    ];
    if (branch && branch !== 'public') args.push('-beta', branch);
    if (validate) args.push('validate');
    args.push('+quit');
    await this.run(args);
    if (!(await exists(path.join(this.store.rustDir, 'RustDedicated.exe')))) throw new Error('SteamCMD finished without producing RustDedicated.exe. The runtime was not installed.');
    return { rustDir: this.store.rustDir };
  }

  async isInstalled() { return exists(path.join(this.store.rustDir, 'RustDedicated.exe')); }
}

module.exports = { SteamCmdProvider, RUST_APP_ID, STEAMCMD_URL, classifyFailure, summarizeOutput };
