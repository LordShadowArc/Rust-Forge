const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { exists, isExpectedProcess, pidAlive } = require('./util');
const { checkTcpListening, checkUdpListening } = require('./ports');

const HEALTH_ORDER = { fail: 3, warn: 2, info: 1, pass: 0 };

function item(id, label, status, detail, hint = null, meta = {}) {
  return { id, label, status, detail, hint, ...meta };
}

function overallFor(checks) {
  const worst = checks.reduce((value, check) => Math.max(value, HEALTH_ORDER[check.status] || 0), 0);
  if (worst >= HEALTH_ORDER.fail) return 'failed';
  if (worst >= HEALTH_ORDER.warn) return 'degraded';
  return 'healthy';
}

function cleanLine(value) {
  return String(value || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim();
}

class RuntimeDiagnostics extends EventEmitter {
  constructor(store, serverManager, rcon, telemetry, options = {}) {
    super();
    this.store = store;
    this.serverManager = serverManager;
    this.rcon = rcon;
    this.telemetry = telemetry;
    this.platform = options.platform || process.platform;
    this.portProbe = options.portProbe || { tcp: checkTcpListening, udp: checkUdpListening };
    this.playit = options.playit || null;
    this.maxLogLines = Math.max(50, Number(options.maxLogLines) || 240);
  }

  async readRecentLog(server) {
    if (!server?.lastLogFile || !(await exists(server.lastLogFile))) return [];
    try {
      const text = await fs.promises.readFile(server.lastLogFile, 'utf8');
      return text.split(/\r?\n/).map(cleanLine).filter(Boolean).slice(-this.maxLogLines);
    } catch {
      return [];
    }
  }

  async runtimeChecks() {
    const checks = [];
    const rustExe = path.join(this.store.rustDir, 'RustDedicated.exe');
    const steamExe = path.join(this.store.steamcmdDir, 'steamcmd.exe');
    const managed = path.join(this.store.rustDir, 'RustDedicated_Data', 'Managed');
    const win64 = path.join(managed, 'Facepunch.Steamworks.Win64.dll');

    checks.push((await exists(rustExe))
      ? item('rust-runtime', 'Rust Dedicated', 'pass', 'RustDedicated.exe is installed and available.')
      : item('rust-runtime', 'Rust Dedicated', 'fail', 'RustDedicated.exe is missing.', 'Run One-Click Setup or Runtime Repair.'));

    checks.push((await exists(steamExe))
      ? item('steamcmd', 'SteamCMD', 'pass', 'SteamCMD is installed and available for runtime maintenance.')
      : item('steamcmd', 'SteamCMD', 'warn', 'SteamCMD is not installed yet.', 'One-Click Setup will install SteamCMD automatically.'));

    if (this.platform === 'win32') {
      checks.push((await exists(win64))
        ? item('steamworks-win64', 'Windows Steamworks', 'pass', 'Facepunch.Steamworks.Win64.dll is present.')
        : item('steamworks-win64', 'Windows Steamworks', 'fail', 'Facepunch.Steamworks.Win64.dll is missing.', 'Run Runtime Repair / validate the Rust Dedicated installation.'));

      const posixFiles = ['Facepunch.Steamworks.Posix.dll', 'Facepunch.Steamworks.Posix32.dll', 'Facepunch.Steamworks.Posix64.dll']
        .map(name => path.join(managed, name));
      const stray = [];
      for (const file of posixFiles) if (await exists(file)) stray.push(path.basename(file));
      checks.push(stray.length
        ? item('platform-assemblies', 'Platform Assembly Hygiene', 'warn', `Unexpected Posix Steamworks assemblies are present: ${stray.join(', ')}.`, 'Runtime sanitization removes these before launch.')
        : item('platform-assemblies', 'Platform Assembly Hygiene', 'pass', 'No Posix Steamworks assemblies are present in the Windows Managed folder.'));
    } else {
      checks.push(item('steamworks-platform', 'Platform Runtime', 'info', `Running diagnostics on ${this.platform}; Windows-only Steamworks checks were skipped.`));
    }

    return checks;
  }

  async serverChecks(server) {
    const checks = [];
    const identityPath = this.store.serverIdentityPath(server);
    const configPath = path.join(identityPath, 'cfg', 'server.cfg');
    const rustExe = path.join(this.store.rustDir, 'RustDedicated.exe');
    const status = this.serverManager.normalizeServer(server);
    const running = ['running', 'running-external', 'starting', 'stopping'].includes(status.runtimeStatus);
    const active = ['running', 'running-external'].includes(status.runtimeStatus);

    if (server.network?.mode === 'playit') {
      const ps = this.playit?.snapshot?.() || null;
      if (this.platform !== 'win32') checks.push(item('playit-platform', 'Playit Platform', 'warn', 'Managed Playit runtime is currently Windows-only in Rust Forge.', 'Use an external Playit installation on non-Windows platforms.'));
      else if (!ps || ['not-installed','stopped'].includes(ps.status)) checks.push(item('playit-agent', 'Playit Agent', 'warn', 'Playit mode is enabled but the managed agent is not running.', 'Start the managed agent from Settings → Network / Playit.'));
      else if (ps.status === 'awaiting-claim') checks.push(item('playit-agent', 'Playit Agent', 'warn', 'The Playit agent is running and awaiting one-time account/tunnel configuration.', 'Open Settings → Network / Playit and complete the claim, then create the UDP game tunnel in the Playit dashboard.'));
      else checks.push(item('playit-agent', 'Playit Agent', 'pass', `Playit agent ${ps.version || ''} is running.`));
      if (server.network.secureBind !== false) {
        checks.push(String(server.bindIp) === '127.0.0.1'
          ? item('playit-bind', 'Playit Secure Bind', 'pass', 'Game traffic is restricted to 127.0.0.1 for tunnel-only exposure.')
          : item('playit-bind', 'Playit Secure Bind', 'fail', 'Playit secure mode is enabled but the profile bind IP is not loopback.', 'Save the server config once; Forge will force 127.0.0.1.'));
      }
      checks.push(server.network.publicGameAddress
        ? item('public-address', 'Public Game Address', 'pass', `Public join address: ${server.network.publicGameAddress}.`)
        : item('public-address', 'Public Game Address', 'warn', 'Playit mode is enabled but no public game address is saved.', 'After creating the Playit UDP tunnel, paste its public address into Server Config.'));
      if (server.network.exposeQuery) checks.push(server.network.publicQueryAddress
        ? item('public-query', 'Public Query Address', 'pass', `Public query address: ${server.network.publicQueryAddress}.`)
        : item('public-query', 'Public Query Address', 'warn', 'Query exposure is enabled but no public query address is saved.', 'Configure a separate Playit UDP query tunnel or turn this option off.'));
    } else {
      checks.push(item('public-access', 'Public Access', 'info', 'Direct/LAN mode is enabled; Playit is not required for this profile.'));
    }

    checks.push((await exists(identityPath))
      ? item('identity', 'Server Identity', 'pass', `${server.identity} is present and isolated.`)
      : item('identity', 'Server Identity', 'fail', 'The server identity directory is missing.', 'Open CONFIG to rebuild the profile or recreate the server.'));

    checks.push((await exists(configPath))
      ? item('server-config', 'server.cfg', 'pass', 'The server-specific configuration file is present.')
      : item('server-config', 'server.cfg', 'warn', 'server.cfg has not been generated yet.', 'Start the server once to generate the managed configuration.'));

    const passwordSecure = /^[A-Za-z0-9]{8,64}$/.test(String(server.rconPassword || ''));
    checks.push(passwordSecure
      ? item('rcon-credential', 'RCON Credential', 'pass', `A valid ${server.rconPassword.length}-character RCON password is configured.`)
      : item('rcon-credential', 'RCON Credential', 'fail', 'The configured RCON password is too short or contains unsupported characters.', 'Forge will regenerate an alphanumeric password when the server starts.'));

    if (!running) {
      checks.push(item('process', 'Server Process', 'info', 'Server is stopped. Runtime process checks are idle until the instance is started.'));
    } else {
      const pid = Number(status.runtimePid);
      const alive = pid > 0 && await pidAlive(pid);
      if (!alive) {
        checks.push(item('process', 'Server Process', 'fail', `Tracked Rust process ${pid || 'unknown'} is not alive.`, 'Reconcile the server or start the instance again.'));
      } else {
        const expected = await isExpectedProcess(pid, rustExe);
        checks.push(expected
          ? item('process', 'Server Process', 'pass', `RustDedicated is running with PID ${pid}.`, null, { pid })
          : item('process', 'Server Process', 'fail', `PID ${pid} is alive but does not resolve to RustDedicated.exe.`, 'Forge will refuse unsafe process control until the identity is unambiguous.', { pid }));
      }
    }

    if (active) {
      const gameBound = await this.portProbe.udp(Number(server.ports.server), '127.0.0.1');
      const queryBound = await this.portProbe.udp(Number(server.ports.query), '127.0.0.1');
      const rconBound = await this.portProbe.tcp(Number(server.ports.rcon), '127.0.0.1');
      checks.push(gameBound
        ? item('game-port', 'Game Port', 'pass', `UDP ${server.ports.server} is listening.`)
        : item('game-port', 'Game Port', 'fail', `UDP ${server.ports.server} is not detected as listening.`, 'Check server.port, firewall rules and the Rust log.'));
      checks.push(queryBound
        ? item('query-port', 'Query Port', 'pass', `UDP ${server.ports.query} is listening.`)
        : item('query-port', 'Query Port', 'warn', `UDP ${server.ports.query} is not detected as listening.`, 'The server may still be finishing startup, or the query port may be blocked.'));
      checks.push(rconBound
        ? item('rcon-port', 'RCON Port', 'pass', `TCP ${server.ports.rcon} is listening.`)
        : item('rcon-port', 'RCON Port', 'warn', `TCP ${server.ports.rcon} is not detected as listening.`, 'RCON may still be starting or may be disabled by the server.'));
    } else {
      checks.push(item('network-sockets', 'Network Sockets', 'info', 'Socket checks will become active when the server reaches RUNNING state.'));
    }

    if (server.uMod === false) {
      checks.push(item('umod', 'uMod', 'info', 'uMod is disabled for this server profile.'));
    } else {
      const oxideIntegrity = typeof this.serverManager.umod?.runtimeIntegrity === 'function'
        ? await this.serverManager.umod.runtimeIntegrity()
        : { ready: await exists(path.join(this.store.rustDir, 'RustDedicated_Data', 'Managed', 'Oxide.Core.dll')), missing: [] };
      checks.push(oxideIntegrity.ready
        ? item('umod', 'uMod', 'pass', 'uMod/Oxide runtime files are present.')
        : item('umod', 'uMod', 'warn', `uMod is enabled for this profile but the Windows Oxide runtime is incomplete. Missing: ${oxideIntegrity.missing.join(', ') || 'unknown'}.`, 'Run Sync uMod; Forge will verify the canonical Windows package before declaring success.', { missingFiles: oxideIntegrity.missing }));
    }

    const lines = await this.readRecentLog(server);
    const normalizedLog = lines.map(line => String(line).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').toLowerCase());
    const logReady = normalizedLog.some(line => line.includes('server startup complete') || line.includes('[bootstrap] completed'));
    const startupPhase = String(server.startup?.phase || 'IDLE');
    if (startupPhase === 'READY' || startupPhase.startsWith('READY ·') || server.startup?.readyAt || logReady) {
      const warning = server.startup?.rconWarning;
      checks.push(item('readiness', 'Rust Readiness', warning ? 'warn' : 'pass', warning ? `Rust is running, but the startup path recorded an RCON warning: ${warning}` : 'Rust reported “Server startup complete”.', warning ? 'Repair the RCON port from Server Config or use the automatically reassigned local RCON port.' : null));
    } else if (status.runtimeStatus === 'starting') {
      checks.push(item('readiness', 'Rust Readiness', 'warn', `Rust is still starting (${startupPhase}, ${server.startup?.progress || 0}%).`, 'World generation can take several minutes on larger maps.'));
    } else if (active) {
      checks.push(item('readiness', 'Rust Readiness', 'warn', `The process is running but the final READY signal has not been observed (${startupPhase}).`, 'Check the live console for the final startup signal.'));
    } else {
      checks.push(item('readiness', 'Rust Readiness', 'info', 'The server is stopped; no startup signal is expected.'));
    }

    const joined = lines.join('\n');
    const hardErrors = [];
    if (/RCON password is very insecure|RCON is disabled/i.test(joined)) hardErrors.push('RCON is disabled because the configured password is insecure.');
    if (/Facepunch\.Steamworks\.Posix|Could not load file or assembly/i.test(joined)) hardErrors.push('A Steamworks assembly load error was detected.');
    if (/\b(FATAL|Unhandled Exception|NullReferenceException|FileNotFoundException)\b/i.test(joined)) hardErrors.push('A recent fatal/exception-class runtime error was detected in the Rust log.');
    if (/Steamworks.*(?:error|failed|not initialized|not loaded)|Facepunch\.Steamworks.*(?:error|failed)/i.test(joined)) hardErrors.push('A Steamworks initialization failure was detected in the recent log.');
    if (hardErrors.length) {
      checks.push(item('log-errors', 'Runtime Log', 'fail', hardErrors.join(' '), 'Open the live console and use Runtime Repair / Validate Runtime before restarting.'));
    } else {
      const eacClientKick = /Client integrity violation/i.test(joined);
      const eacServerError = /EAC.*(?:error|failed|disabled|not initialized)|EasyAntiCheat.*(?:error|failed|disabled|not initialized)/i.test(joined);
      const genericErrors = lines.filter(line => /\bERROR\b|\bERROR:|\[ERROR\]/i.test(line));
      if (eacServerError) checks.push(item('eac-signal', 'EAC Server Signal', 'fail', 'The server log contains an Easy Anti-Cheat initialization/error signal.', 'Validate the Rust Dedicated runtime before investigating the client.'));
      else if (eacClientKick) checks.push(item('eac-signal', 'EAC Server Signal', 'warn', 'The log contains a client integrity rejection. That indicates a client-side EAC issue was observed, not proof that the server runtime is broken.', 'Verify the Rust client and EAC service if the same player is repeatedly rejected.'));
      else checks.push(item('eac-signal', 'EAC Server Signal', 'pass', 'No recent EAC server error or client-integrity rejection was found in the selected server log.'));
      if (genericErrors.length) checks.push(item('log-warnings', 'Runtime Log', 'warn', `${genericErrors.length} recent ERROR-class log lines were detected.`, 'Inspect the console around the first error before treating the server as healthy.'));
      else checks.push(item('log-warnings', 'Runtime Log', 'pass', 'No recent ERROR/FATAL signatures were detected in the sampled log window.'));
    }

    const telemetry = this.telemetry?.lastFor?.(server.id) || null;
    if (telemetry) {
      checks.push(item('telemetry', 'Process Telemetry', 'pass', `CPU ${telemetry.cpuPercent}% · RAM ${telemetry.memoryMb} MB · uptime ${telemetry.uptimeSec}s.`, null, { telemetry }));
    } else if (active) {
      checks.push(item('telemetry', 'Process Telemetry', 'warn', 'No telemetry sample is available yet.', 'Wait one telemetry interval for the first sample.'));
    } else {
      checks.push(item('telemetry', 'Process Telemetry', 'info', 'Telemetry will appear when the server is running.'));
    }

    return checks;
  }

  async run({ serverId = null } = {}) {
    const checks = await this.runtimeChecks();
    const target = serverId ? this.store.getServer(serverId) : null;
    if (serverId && !target) throw new Error('Server profile not found.');
    if (target) checks.push(...await this.serverChecks(target));
    const result = {
      scope: target ? 'server' : 'runtime',
      serverId: target?.id || null,
      serverName: target?.name || null,
      generatedAt: Date.now(),
      overall: overallFor(checks),
      checks
    };
    this.emit('result', result);
    return result;
  }
}

module.exports = { RuntimeDiagnostics, overallFor };
