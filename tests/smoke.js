'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const Module = require('module');
const { spawn } = require('child_process');
const { SETTINGS_SCHEMA } = require('../src/core/settings-schema');

const root = path.join(__dirname, '..');
const sourceFiles = [];
function collectJs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJs(file);
    else if (entry.isFile() && file.endsWith('.js')) sourceFiles.push(file);
  }
}
collectJs(path.join(root, 'src'));

let passed = 0;
function pass(name) {
  passed += 1;
  console.log(`PASS  ${name}`);
}
function check(condition, name, detail = '') {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ''}`);
  pass(name);
}
async function expectRejects(promise, name) {
  await assert.rejects(promise);
  pass(name);
}
async function waitFor(predicate, timeoutMs = 4000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function main() {
  const pkg = require(path.join(root, 'package.json'));
  check(pkg.version === '1.0.0', 'public version is frozen at 1.0.0');
  check(pkg.main === 'src/main.js', 'Electron entrypoint is stable');
  check(pkg.build?.win?.icon?.endsWith('rust-forge.ico'), 'Windows icon is configured');
  check(pkg.build?.portable?.artifactName === 'Rust-Forge-${version}-portable-${arch}.exe', 'portable artifact name is release-safe');
  check(pkg.build?.nsis?.artifactName === 'Rust-Forge-${version}-Setup-${arch}.exe', 'installer artifact name is release-safe');
  check(pkg.build?.nsis?.oneClick === false, 'installer is non-one-click configurable');
  check((pkg.dependencies?.ws || '').length > 0, 'WebRCON dependency is declared');

  for (const file of sourceFiles) {
    const relative = path.relative(root, file);
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.on('close', code => resolve({ code, stderr }));
    });
    assert.equal(result.code, 0, `syntax check failed for ${relative}: ${result.stderr}`);
  }
  pass(`syntax checked every source file (${sourceFiles.length})`);

  // Relative dependency graph audit: every local require('./...') must resolve to a
  // shipped JS/module file. This catches packaging drift that syntax checks miss.
  const localRequirePattern = /require\((['"])(\.\.?\/[^'"]+)\1\)/g;
  for (const file of sourceFiles) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(localRequirePattern)) {
      const raw = match[2];
      const base = path.resolve(path.dirname(file), raw);
      const candidates = [base, `${base}.js`, path.join(base, 'index.js')];
      assert.ok(candidates.some(candidate => fs.existsSync(candidate)), `unresolved local require ${raw} in ${path.relative(root, file)}`);
    }
  }
  pass('local module dependency graph resolves');

  const renderer = fs.readFileSync(path.join(root, 'src/ui/renderer.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src/ui/styles.css'), 'utf8');
  const managerSource = fs.readFileSync(path.join(root, 'src/core/server-manager.js'), 'utf8');
  const utilSource = fs.readFileSync(path.join(root, 'src/core/util.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  const steamSource = fs.readFileSync(path.join(root, 'src/core/steamcmd.js'), 'utf8');
  const umodSource = fs.readFileSync(path.join(root, 'src/core/umod.js'), 'utf8');
  const schedulerSource = fs.readFileSync(path.join(root, 'src/core/scheduler.js'), 'utf8');
  const diagnosticsSource = fs.readFileSync(path.join(root, 'src/core/diagnostics.js'), 'utf8');
  const portsSource = fs.readFileSync(path.join(root, 'src/core/ports.js'), 'utf8');

  check(!renderer.includes('alert(') && !renderer.includes('confirm('), 'renderer contains no native blocking dialogs');
  check(renderer.includes('let modalGeneration = 0;'), 'modal controller has generation state');
  check(renderer.includes('host.onclick=handleModalClick;') && renderer.includes('stopImmediatePropagation()'), 'modal actions are handled by the dedicated modal host');
  check(renderer.includes('data-close="1"'), 'close buttons have explicit close markers');
  check(renderer.includes('data-confirm-delete="1"'), 'remove button has explicit confirm marker');
  check(renderer.includes('data-confirm-wipe="1"'), 'wipe button has explicit confirm marker');
  check(!renderer.includes('<label class="toggle-row">'), 'destructive modal does not use invalid nested label markup');
  check(renderer.includes('document.body.classList.remove(\'modal-open\')'), 'modal close clears body lock');
  check(renderer.includes("classList.add('modal-active')") && renderer.includes("classList.remove('modal-active')"), 'modal hit target is explicitly activated/deactivated');
  check(renderer.includes("setAttribute('aria-hidden','false')") && renderer.includes("setAttribute('aria-hidden','true')"), 'modal host accessibility state follows visibility');
  check(renderer.includes("setAttribute('inert','')") && renderer.includes("removeAttribute('inert')"), 'background shell is inert while a modal is active');
  check(renderer.includes("e.key==='Tab'") && renderer.includes('focusables'), 'modal keyboard focus remains trapped inside the active dialog');
  check(css.includes('#modalHost.modal-active{pointer-events:auto') && css.includes('#modalHost{position:fixed') && css.includes('pointer-events:none'), 'modal host uses explicit active hit-testing rather than permanent pointer passthrough');
  check(renderer.includes("if(e.target.closest('#modalHost'))return;"), 'global click dispatcher excludes modal events');
  check(renderer.includes('pluginServerSelect') && renderer.includes('controlServerSelect'), 'server target selectors are explicit');
  check(renderer.includes('showProgressNotification') && renderer.includes('progressNotification'), 'progress feedback is coalesced into one non-flooding notification');
  check(renderer.includes('view-diagnostics') && renderer.includes('runDiagnostics'), 'runtime diagnostics has a dedicated UI surface and executable action');
  check(renderer.includes('diagnosticServerSelect') && renderer.includes('health-list'), 'runtime diagnostics supports explicit server scoping and a health matrix');
  check(renderer.includes("toast('', 'Removing server'") && renderer.includes('{durationMs:2800}'), 'removal feedback is time-bounded and cannot trap the UI indefinitely');
  check(renderer.includes('appendConsoleLine') && renderer.includes('console-empty'), 'live console uses incremental DOM updates');
  pass('UI logic audit: modal/server/plugin boundaries are explicit');

  check(!managerSource.includes('taskkill /f /im RustDedicated.exe'), 'server lifecycle is PID scoped');
  check(managerSource.includes("const active = isActiveStatus(before.runtimeStatus);"), 'remove checks all active lifecycle states before deleting');
  check(managerSource.includes('this.deletingIdentities.add(identityKey)'), 'deleting identities are reserved during async cleanup');
  check(managerSource.includes('return this.withLifecycle(id, async () =>'), 'destructive server operations are lifecycle serialized');
  check(managerSource.includes('async ensureInstall(server, { updateExisting = false } = {})'), 'runtime install/update distinction prevents update-on-every-start');
  check(managerSource.includes('runtimePrepareQueue = Promise.resolve()') && managerSource.includes('queueRuntimePreparation(task)'), 'shared Rust runtime mutations are serialized across starts, plugin sync and updates');
  check(managerSource.includes("phase('RUNTIME CHECK', 8"), 'runtime diagnostics expose the formerly opaque 8% phase');
  check(managerSource.includes("text.includes('server startup complete')"), 'startup readiness has a real Rust signal');
  check(managerSource.includes('await this._start(id, { ensureRuntime: false })'), 'known-safe restart paths skip redundant runtime mutation');
  check(managerSource.includes('const needsUmodPrep = snapshot.uMod === false && before.uMod !== false;'), 'config transaction rolls runtime preparation into rollback scope');
  check(managerSource.includes('await this.recoverPendingDeletions();'), 'pending deletion cleanup is recovered after app restart');
  check(managerSource.includes('.rust-forge-delete.json'), 'staged deletes carry durable identity metadata');
  check(managerSource.includes("const activeBefore = this.list().filter(isActiveStatus).map(item => item.id);"), 'bootstrap never mutates the Rust runtime while servers are still running');
  check(managerSource.includes('async reconcile() {\n    for (const [id, pid] of [...this.external])'), 'reconcile checks detached processes without dead work');
  check(managerSource.includes("phase('VALIDATING WINDOWS RUNTIME', 18"), 'startup runtime validation remains visible before process launch');
  pass('server manager logic audit: lifecycle, runtime, rollback and cleanup');

  check(utilSource.includes('async function killPid(pid, timeoutMs = 10000)'), 'Windows process kill has a timeout');
  check(utilSource.includes('async function processExecutable(pid, timeoutMs = 5000)'), 'process identity probe has a timeout');
  check(utilSource.includes('if (output.length > 8192)'), 'WMI output is bounded');
  const telemetrySource = fs.readFileSync(path.join(root, 'src/core/telemetry.js'), 'utf8');
  check(telemetrySource.includes('setTimeout(() => {') && telemetrySource.includes('try { child.kill(); } catch {}'), 'telemetry subprocess timeout actively terminates the worker');
  check(telemetrySource.includes('lastFor(id)'), 'telemetry retains the latest sample for health diagnostics without coupling UI polling');
  pass('utility logic audit: bounded system subprocesses');

  check(mainSource.includes('const previousSettings = { ...store.state.settings };'), 'settings writes have rollback state');
  check(mainSource.includes('return servers.withLifecycle(server.id, () => umod.updatePlugins(server));'), 'manual plugin batch update is lifecycle serialized');
  check(mainSource.includes("app.requestSingleInstanceLock()"), 'application is single-instance');
  pass('main process audit: persistence and IPC lifecycle isolation');

  check(steamSource.includes('if (allowRetry && [7, 8].includes(Number(result.code)))'), 'SteamCMD 7/8 retry path exists');
  check(steamSource.includes('20 * 60 * 1000'), 'SteamCMD has a bounded worker timeout');
  check(umodSource.includes('const key = `${server.id}:${normalized.toLowerCase()}`;'), 'plugin installs deduplicate per server and plugin');
  check(umodSource.includes('Plugin dependency cycle detected'), 'plugin dependency cycles are rejected');
  check(umodSource.includes('Plugin checksum verification failed'), 'plugin integrity is verified when published checksum exists');
  check(umodSource.includes('replacePluginFile(temp, target, previousData)'), 'plugin replacement handles existing files safely');
  check(umodSource.includes('Plugin file was restored because its Forge lock record could not be committed'), 'plugin install rolls back when lock persistence fails');
  check(schedulerSource.includes('await Promise.allSettled(jobs);'), 'scheduler processes servers independently');
  check(diagnosticsSource.includes('class RuntimeDiagnostics') && diagnosticsSource.includes('async run({ serverId = null } = {})'), 'runtime diagnostics exposes a deterministic health-check service');
  check(diagnosticsSource.includes('Facepunch.Steamworks.Win64.dll') && diagnosticsSource.includes('Client integrity violation'), 'diagnostics distinguishes Windows runtime health from client-side EAC integrity signals');
  check(portsSource.includes('checkTcpListening') && portsSource.includes('checkUdpListening'), 'diagnostics can distinguish TCP RCON from UDP game/query sockets');
  pass('runtime services audit: SteamCMD, uMod and scheduler');

  // uMod package-layout regression: the installer must only report success after
  // the actual Windows Oxide core/common/rust assemblies exist.
  const umodProviderSource = fs.readFileSync(path.join(root, 'src/core/umod.js'), 'utf8');
  check(umodProviderSource.includes('https://umod.org/games/rust/download') && umodProviderSource.includes('releases/latest/download/Oxide.Rust.zip'), 'uMod uses the canonical Windows download plus GitHub fallback');
  check(umodProviderSource.includes('Windows Oxide package extraction produced no RustDedicated_Data/Managed/Oxide.Core.dll'), 'uMod install has a strict post-extraction marker check');
  check(umodProviderSource.includes('WINDOWS_OXIDE_RUNTIME_FILES') && umodProviderSource.includes('Oxide.Common.dll') && umodProviderSource.includes('Assembly-CSharp.dll'), 'uMod install verifies the patched Windows Oxide assembly contract');
  check(umodProviderSource.includes('async isInstalled()'), 'uMod provider exposes a real runtime-integrity predicate');

  // Load AppStore with a local Electron stub. This exercises real persistence
  // and migration code without requiring an Electron runtime.
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rust-forge-audit-'));
  let electronUserData = tempRoot;
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: name => name === 'userData' ? electronUserData : tempRoot } };
    return originalLoad.call(this, request, parent, isMain);
  };
  let AppStore;
  try {
    ({ AppStore } = require(path.join(root, 'src/core/app-store.js')));
  } finally {
    Module._load = originalLoad;
  }

  // Migration duplicate identity regression: a 32-char identity must still be
  // made unique without an infinite suffixing loop.
  electronUserData = path.join(tempRoot, 'migration');
  await fs.promises.mkdir(electronUserData, { recursive: true });
  const duplicateIdentity = 'abcdefghijklmnopqrstuvwxyz123456';
  const migrationFile = path.join(electronUserData, 'rust-forge', 'app.json');
  await fs.promises.mkdir(path.dirname(migrationFile), { recursive: true });
  await fs.promises.writeFile(migrationFile, JSON.stringify({
    servers: [
      { id: 'srv_a', identity: duplicateIdentity, name: 'A' },
      { id: 'srv_b', identity: duplicateIdentity, name: 'B' }
    ]
  }));
  const migratedStore = new AppStore();
  await migratedStore.init();
  const identities = migratedStore.state.servers.map(s => s.identity);
  check(identities.length === 2 && identities[0] !== identities[1] && identities.every(x => x.length <= 32), 'store migrates duplicate 32-char identities safely');

  // Save queue recovery regression: one failed write must not poison all later saves.
  electronUserData = path.join(tempRoot, 'store-recovery');
  const recoveryStore = new AppStore();
  await recoveryStore.init();
  const brokenTarget = path.join(tempRoot, 'broken-target');
  await fs.promises.mkdir(brokenTarget, { recursive: true });
  recoveryStore.file = brokenTarget;
  await expectRejects(recoveryStore.save(), 'store save failure is observable');
  recoveryStore.file = path.join(tempRoot, 'recovered', 'app.json');
  recoveryStore.state.settings.closeToTray = false;
  await recoveryStore.save();
  const savedRecovery = JSON.parse(await fs.promises.readFile(recoveryStore.file, 'utf8'));
  check(savedRecovery.settings.closeToTray === false, 'save queue recovers after a failed persistence attempt');

  const testServer = recoveryStore.createServerDefaults({ name: 'Audit Server', hostname: 'Audit Server', identity: 'audit-server', uMod: false }, null);
  const oldLength = recoveryStore.state.servers.length;
  recoveryStore.file = brokenTarget;
  await expectRejects(recoveryStore.addServer(testServer), 'transactional add surfaces persistence failure');
  check(recoveryStore.state.servers.length === oldLength, 'transactional add rolls back in-memory state');
  pass('persistence audit: migration, queue recovery and transactional rollback');

  // Restore a good userData root for the live manager integration tests.
  electronUserData = path.join(tempRoot, 'manager');
  const store = new AppStore();
  await store.init();
  const fakeSteam = {
    async updateRust() {
      const managed = path.join(store.rustDir, 'RustDedicated_Data', 'Managed');
      await fs.promises.mkdir(managed, { recursive: true });
      // The Windows branch of ServerManager.sanitizeWindowsRuntime requires the
      // same platform assembly that a real RustDedicated Windows depot provides.
      // Keep the fake runtime faithful so the smoke test exercises the actual
      // contract instead of failing because the mock itself is incomplete.
      await fs.promises.writeFile(path.join(managed, 'Facepunch.Steamworks.Win64.dll'), 'fake-win64-assembly');
      const exe = path.join(store.rustDir, 'RustDedicated.exe');
      // The production launcher must execute a real PE binary on Windows. The smoke
      // suite instead injects a portable process launcher below, so CI can exercise
      // the full ServerManager lifecycle without pretending a Node script is an EXE.
      await fs.promises.writeFile(exe, 'fake-rust-runtime-marker', 'utf8');
      const script = `const readline=require('readline');\nconsole.log('[Rust] Booting dedicated server');\nsetTimeout(()=>console.log('[Rust] Loading assets'),35);\nsetTimeout(()=>console.log('[Rust] Generating world'),70);\nsetTimeout(()=>console.log('[RustNav] Saving navmesh'),105);\nsetTimeout(()=>console.log('[Rust] Server startup complete'),140);\nconst rl=readline.createInterface({input:process.stdin});\nrl.on('line',line=>{if(String(line).trim().toLowerCase()==='quit'){console.log('[Rust] Quit');setTimeout(()=>process.exit(0),20)}else console.log('[RustCmd] '+line)});\nsetInterval(()=>{},1000);\n`;
      const fakeScript = path.join(store.rustDir, 'fake-rust-runtime.js');
      await fs.promises.writeFile(fakeScript, script, 'utf8');
      return { rustDir: store.rustDir, fakeScript };
    }
  };
  const fakeRcon = {
    disconnected: new Set(),
    async autoConnect() { return true; },
    async disconnect(id) { this.disconnected.add(id); },
    async command() { return { Message: 'ok' }; }
  };
  const fakeTelemetry = { setProvider() {}, start() {}, stop() {} };
  const fakeUmod = {
    installs: 0,
    async installOrUpdate() { this.installs += 1; throw new Error('Intentional uMod audit failure'); },
    async updatePlugins() { return []; }
  };

  const { ServerManager } = require(path.join(root, 'src/core/server-manager.js'));
  const launchServerProcess = (command, args, options = {}) => {
    if (path.basename(command).toLowerCase() === 'rustdedicated.exe') {
      return spawn(process.execPath, [path.join(store.rustDir, 'fake-rust-runtime.js')], options);
    }
    return spawn(command, args, options);
  };
  const manager = new ServerManager(store, fakeSteam, fakeUmod, fakeRcon, fakeTelemetry, launchServerProcess);
  await manager.init();
  const created = await manager.create({ name: 'Runtime Audit', hostname: 'Runtime Audit', identity: 'runtime-audit', uMod: false, serverPort: 29115 });
  pass('server manager can create a profile using the real store');
  check(created.rconPassword.length === 32 && /^[A-Za-z0-9]+$/.test(created.rconPassword), 'new server receives a Rust-safe 32-character RCON password');
  const createdArgs = manager.buildArgs(created, path.join(store.rustDir, 'audit.log'));
  check(createdArgs.includes('+rcon.password') && createdArgs[createdArgs.indexOf('+rcon.password') + 1] === created.rconPassword, 'RCON password is supplied on the Rust startup command line');
  check(createdArgs.includes('+rcon.web') && createdArgs[createdArgs.indexOf('+rcon.web') + 1] === '1', 'WebRCON is explicitly enabled at process startup');

  const publicProfile = await manager.create({
    name: 'Public Profile',
    hostname: 'Rust Forge Public',
    description: 'Public survival server',
    url: 'https://example.com',
    headerImage: 'https://example.com/header.jpg',
    logoImage: 'https://example.com/logo.png',
    tags: ['monthly','vanilla','EU'],
    network: { mode: 'playit', secureBind: true, exposeQuery: false, publicGameAddress: 'example.playit.gg:12345', publicQueryAddress: '' },
    uMod: false,
    serverPort: 29135
  });
  await manager.writeServerConfig(publicProfile);
  const publicCfg = await fs.promises.readFile(path.join(store.serverIdentityPath(publicProfile), 'cfg', 'server.cfg'), 'utf8');
  check(publicCfg.includes('server.hostname \"Rust Forge Public\"') && publicCfg.includes('server.description \"Public survival server\"'), 'server.cfg persists public server branding');
  check(publicCfg.includes('server.url \"https://example.com\"') && publicCfg.includes('server.headerimage \"https://example.com/header.jpg\"') && publicCfg.includes('server.logoimage \"https://example.com/logo.png\"'), 'server.cfg persists website, header image and logo image metadata');
  check(publicCfg.includes('server.tags \"monthly,vanilla,EU\"'), 'server.cfg persists validated server browser tags');
  check(publicCfg.includes('server.ip 127.0.0.1') && publicCfg.includes('rcon.ip 127.0.0.1'), 'Playit secure mode keeps game and RCON bindings on loopback');
  check(publicProfile.network.mode === 'playit' && publicProfile.network.secureBind === true, 'server profile stores explicit Playit network policy');

  const { PLAYIT_STABLE, PlayitManager } = require(path.join(root, 'src/core/playit.js'));
  check(PLAYIT_STABLE.version === '1.0.10' && /^https:\/\/github\.com\/playit-cloud\/playit-agent\/releases\//.test(PLAYIT_STABLE.url), 'managed Playit agent pins an official stable Windows release');
  check(/^[a-f0-9]{64}$/i.test(PLAYIT_STABLE.sha256), 'managed Playit agent uses a SHA-256 integrity pin');
  const fakePlayit = new PlayitManager(store);
  const playitStatus = await fakePlayit.status();
  check(['not-installed','stopped'].includes(playitStatus.status), 'Playit manager has a deterministic offline status without spawning anything');
  check((SETTINGS_SCHEMA.network||[]).some(x => x.key === 'playitAutoStart'), 'settings schema exposes autonomous Playit startup control');

  // Deadlock regression: ensureInstall must finish rather than waiting on a
  // nested copy of the same runtime queue.
  const ensureResult = await Promise.race([
    manager.ensureInstall(created, { updateExisting: false }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('ensureInstall deadlocked')), 2000))
  ]);
  check(ensureResult === true, 'runtime preparation completes without nested-queue deadlock');

  // Exercise the Windows Steamworks validation contract even when the smoke
  // suite itself is running on Linux/macOS CI. The fake runtime includes the
  // expected Win64 assembly above, so this is a real branch test rather than
  // a syntax-only assertion.
  await manager.sanitizeWindowsRuntime('win32');
  pass('Windows runtime doctor accepts a complete Win64 Rust runtime fixture');

  const { RuntimeDiagnostics } = require(path.join(root, 'src/core/diagnostics.js'));
  const diagnosticLog = path.join(store.rustDir, 'diagnostic-test.log');
  await fs.promises.writeFile(diagnosticLog, '[Rust] Server startup complete\n[RustNav] Saving navmesh\n', 'utf8');
  created.lastLogFile = diagnosticLog;
  await store.save();
  const diagnostics = new RuntimeDiagnostics(store, manager, fakeRcon, fakeTelemetry, {
    platform: process.platform,
    portProbe: { tcp: async () => true, udp: async () => true }
  });
  const runtimeHealth = await diagnostics.run();
  check(runtimeHealth.overall !== 'failed', 'runtime-only health check stays non-failing with an intact fake runtime');
  const serverHealth = await diagnostics.run({ serverId: created.id });
  check(serverHealth.checks.some(x => x.id === 'server-config'), 'server health check inspects the managed server.cfg boundary');
  check(serverHealth.checks.some(x => x.id === 'rcon-credential' && x.status === 'pass'), 'server health check validates the generated RCON credential');
  await fs.promises.writeFile(diagnosticLog, '[Rust] RCON password is very insecure, RCON is disabled.\n', 'utf8');
  const brokenHealth = await diagnostics.run({ serverId: created.id });
  check(brokenHealth.overall === 'failed' && brokenHealth.checks.some(x => x.id === 'log-errors' && x.status === 'fail'), 'health check escalates an actual RCON-disabled runtime signature');
  await fs.promises.writeFile(diagnosticLog, '[Rust][EAC] Kicking 76561198000000000 / Test (Client integrity violation)\n', 'utf8');
  const eacHealth = await diagnostics.run({ serverId: created.id });
  check(eacHealth.overall === 'degraded' && eacHealth.checks.some(x => x.id === 'eac-signal' && x.status === 'warn'), 'health check treats client EAC integrity kicks as a warning rather than a server-runtime failure');

  const startPromiseA = manager.start(created.id);
  const startPromiseB = manager.start(created.id);
  await Promise.all([startPromiseA, startPromiseB]);
  await waitFor(() => manager.list()[0]?.runtimeStatus === 'running' && manager.list()[0]?.startup?.phase === 'READY', 3000, 'Rust readiness signal');
  check(manager.list()[0].startup.progress === 100, 'startup reaches READY at 100% from real process output');
  manager.updateStartupFromLine(manager.store.getServer(created.id), '[Rust] Asset Warmup (8996/8996)');
  check(manager.list()[0].startup.phase === 'READY', 'startup READY state is monotonic after later Rust warmup chatter');
  check(manager.list()[0].runtimePid > 0, 'started server exposes its runtime PID');
  pass('live process integration: start serialization and readiness');

  const currentBeforeStop = manager.list()[0];
  await manager.stop(created.id, { reason: 'audit' });
  await waitFor(() => manager.list()[0]?.runtimeStatus === 'stopped', 3000, 'server stop');
  check(currentBeforeStop.runtimePid !== null, 'stop test began with a live PID');
  pass('live process integration: graceful stop and process cleanup');

  // IPC-envelope regression: transport metadata must never be interpreted as a server setting.
  const configWithTransportId = await manager.setConfig(created.id, { id: created.id, serverId: created.id, name: 'Runtime Audit Renamed' });
  check(configWithTransportId.name === 'Runtime Audit Renamed', 'server config accepts transport metadata without treating id as a setting');

  // Plugin readiness regression: the first plugin request auto-synchronizes the
  // shared uMod runtime when the marker is missing, instead of surfacing a
  // dead-end "Synchronize uMod first" error from the plugin center.
  const umodMarker = path.join(store.rustDir, 'RustDedicated_Data', 'Managed', 'Oxide.Core.dll');
  await fs.promises.unlink(umodMarker).catch(() => {});
  const originalSyncUmod = manager.syncUmod.bind(manager);
  let syncCount = 0;
  manager.syncUmod = async () => {
    syncCount += 1;
    await fs.promises.mkdir(path.dirname(umodMarker), { recursive: true });
    await fs.promises.writeFile(umodMarker, 'fake-oxide-core');
    return { version: 'audit-umod' };
  };
  created.uMod = true;
  const pluginReady = await manager.ensureUmodForPlugin(created);
  check(pluginReady.ready === true && pluginReady.synchronized === true && syncCount === 1 && fs.existsSync(umodMarker), 'plugin readiness auto-synchronizes missing uMod exactly once');
  manager.syncUmod = originalSyncUmod;
  created.uMod = false;
  await fs.promises.unlink(umodMarker).catch(() => {});

  // Transaction regression: enabling uMod is rolled back if runtime prep fails.
  await expectRejects(manager.setConfig(created.id, { uMod: true }), 'config transaction surfaces failed uMod preparation');
  check(store.getServer(created.id).uMod === false, 'config transaction rolls back failed uMod enable');

  // Scheduler-field regression for zero-valued hour/weekday.
  const updatedSchedule = await manager.setSchedules(created.id, {
    backup: { enabled: true, intervalHours: 1, retention: 2, safe: true, lastAt: null },
    wipe: { enabled: true, frequency: 'weekly', hour: 0, weekday: 0, blueprintWipe: false, forceBackup: true, lastAt: null }
  });
  check(updatedSchedule.schedules.wipe.hour === 0 && updatedSchedule.schedules.wipe.weekday === 0, 'schedule editor preserves valid zero-valued fields');

  // Remove safety: stage data, return promptly, and reserve identity while the
  // background deletion is still running.
  await fs.promises.writeFile(path.join(store.serverIdentityPath(created), 'audit.marker'), 'keep', 'utf8');
  const originalDeleteServerData = manager.deleteServerData.bind(manager);
  let cleanupStartedResolve;
  const cleanupStarted = new Promise(resolve => { cleanupStartedResolve = resolve; });
  manager.deleteServerData = async (target, server) => {
    cleanupStartedResolve();
    await new Promise(resolve => setTimeout(resolve, 250));
    return originalDeleteServerData(target, server);
  };
  const removePromise = manager.remove(created.id, { deleteData: true });
  await removePromise;
  check(!store.getServer(created.id), 'remove returns with the profile already gone');
  await cleanupStarted;
  const replacement = await manager.create({ name: 'Replacement', hostname: 'Replacement', identity: created.identity, uMod: false, serverPort: 29125 });
  check(replacement.identity !== created.identity, 'identity remains reserved while old data is being deleted');
  await new Promise(resolve => setTimeout(resolve, 350));
  const trashEntries = await fs.promises.readdir(store.trashDir);
  check(trashEntries.length === 0, 'staged delete data is fully cleaned after background completion');
  await manager.remove(replacement.id, { deleteData: true });
  pass('destructive operation integration: non-blocking removal and identity reservation');

  // Existing plugin replacement regression: a same-name update must not fail simply
  // because the destination file already exists (Windows rename semantics differ).
  const umodLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'adm-zip') return class FakeAdmZip {};
    return umodLoad.call(this, request, parent, isMain);
  };
  let UmodProvider;
  try {
    ({ UmodProvider } = require(path.join(root, 'src/core/umod.js')));
  } finally {
    Module._load = umodLoad;
  }
  const pluginTestRoot = path.join(tempRoot, 'plugin-replacement');
  await fs.promises.mkdir(pluginTestRoot, { recursive: true });
  const pluginTarget = path.join(pluginTestRoot, 'Example.cs');
  const pluginTemp = `${pluginTarget}.tmp`;
  await fs.promises.writeFile(pluginTarget, 'OLD');
  await fs.promises.writeFile(pluginTemp, 'NEW');
  const provider = new UmodProvider({ state: { settings: { downloadConcurrency: 2 } } });
  await provider.replacePluginFile(pluginTemp, pluginTarget, Buffer.from('OLD'));
  check((await fs.promises.readFile(pluginTarget, 'utf8')) === 'NEW', 'existing plugin files can be replaced safely');
  check(!(await fs.promises.access(pluginTemp).then(() => true).catch(() => false)), 'temporary plugin file is cleaned after replacement');

  // uMod dependency parser is loaded with only its archive dependency stubbed.
  const savedLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'adm-zip') return class FakeAdmZip {};
    return savedLoad.call(this, request, parent, isMain);
  };
  let parseDependencies;
  try {
    ({ parseDependencies } = require(path.join(root, 'src/core/umod.js')));
  } finally {
    Module._load = savedLoad;
  }
  const deps = parseDependencies('// Requires: NTeleportation, ZoneManager\n[Optional("ImageLibrary") ]\n');
  check(deps.required.includes('NTeleportation') && deps.required.includes('ZoneManager') && deps.optional.includes('ImageLibrary'), 'uMod dependency parser separates required and optional references');

  // Public version freeze: no accidental patch-version drift anywhere in shipped source/docs.
  const allTextFiles = [
    'package.json', 'README.md', 'CHANGELOG.md', '.github/workflows/release.yml'
  ];
  for (const relative of allTextFiles) {
    const body = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.ok(!new RegExp('v?1\\.0\\.' + '1').test(body), `public version drift found in ${relative}`);
  }
  pass('release audit: public release remains v1.0.0');

  // Ensure no orphaned audit process remains.
  for (const server of manager.list()) {
    await manager.stop(server.id, { reason: 'audit-finalize' }).catch(() => {});
  }
  console.log(`\nRust Forge 1.0.0 final logic audit passed — ${passed} checks.`);
}

main().catch(error => {
  console.error(`FAIL  ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
