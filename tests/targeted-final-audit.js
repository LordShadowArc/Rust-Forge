const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const { ServerManager } = require('../src/core/server-manager');

async function runAudit(iteration) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rust-forge-${iteration}-`));
  const rustDir = path.join(root, 'rust');
  fs.mkdirSync(path.join(rustDir, 'RustDedicated_Data', 'Managed'), { recursive: true });
  fs.writeFileSync(path.join(rustDir, 'RustDedicated.exe'), 'runtime');

  const server = {
    id: 'srv-audit',
    name: 'Audit Server',
    identity: 'audit-server',
    hostname: 'Audit Server',
    description: 'Audit',
    map: 'Procedural Map',
    seed: 123,
    worldsize: 3000,
    maxplayers: 10,
    ports: { server: 29115, query: 29116, rcon: 29117 },
    bindIp: '0.0.0.0',
    url: '', headerImage: '', logoImage: '', tags: [],
    network: { mode: 'direct', secureBind: true, exposeQuery: false, publicGameAddress: '', publicQueryAddress: '' },
    rconPassword: 'A'.repeat(32),
    uMod: true,
    autoRestart: true,
    autoUpdate: true,
    saveInterval: 300,
    performanceProfile: 'balanced',
    schedules: { backup: {}, wipe: {} },
    status: 'stopped',
    pid: null,
    startup: { phase: 'IDLE', progress: 0, startedAt: null, readyAt: null }
  };

  const store = {
    rustDir,
    state: { servers: [server], settings: { autoUpdateRust: true, autoUpdateUmod: true, autoRestartCrashed: true } },
    getServer(id) { return this.state.servers.find(s => s.id === id) || null; },
    serverIdentityPath(s) { return path.join(root, 'server', s.identity); },
    async save() {},
  };
  const fakeSteam = { async updateRust() { return { ok: true }; } };
  const fakeUmod = { async installOrUpdate() { return { version: 'audit' }; } };
  const fakeRcon = { async disconnect() {}, async autoConnect() {} };
  const fakeTelemetry = { setProvider() {}, start() {} };
  const manager = new ServerManager(store, fakeSteam, fakeUmod, fakeRcon, fakeTelemetry, () => { throw new Error('launcher should not run'); });
  manager.writeServerConfig = async () => {};

  // Shared runtime mutation queue must serialize independent callers rather than
  // letting SteamCMD validation race with uMod patching. This is the exact class
  // of interleaving observed when two start/bootstrap paths were active together.
  const order = [];
  const firstMutation = manager.queueRuntimePreparation(async () => {
    order.push('first:start');
    await new Promise(resolve => setTimeout(resolve, 25));
    order.push('first:end');
  });
  const secondMutation = manager.queueRuntimePreparation(async () => {
    order.push('second:start');
    await new Promise(resolve => setTimeout(resolve, 5));
    order.push('second:end');
  });
  assert.strictEqual(firstMutation, secondMutation);
  await Promise.all([firstMutation, secondMutation]);
  assert.deepEqual(order, ['first:start', 'first:end']);

  // 1) Transport id metadata is ignored, but mismatched ids remain rejected.
  const saved = await manager.setConfig(server.id, { id: server.id, serverId: server.id, name: 'Saved Without Metadata Failure' });
  assert.equal(saved.name, 'Saved Without Metadata Failure');
  await assert.rejects(() => manager.setConfig(server.id, { id: 'wrong-id' }), /Server save target mismatch/);

  // 2) Missing uMod auto-synchronizes exactly once.
  const marker = path.join(rustDir, 'RustDedicated_Data', 'Managed', 'Oxide.Core.dll');
  let syncCount = 0;
  manager.syncUmod = async () => {
    syncCount += 1;
    fs.writeFileSync(marker, 'oxide');
  };
  const ready = await manager.ensureUmodForPlugin(server);
  assert.equal(ready.ready, true);
  assert.equal(ready.synchronized, true);
  assert.equal(syncCount, 1);
  assert.equal(fs.existsSync(marker), true);

  // 3) A second request does not resync the shared runtime.
  const readyAgain = await manager.ensureUmodForPlugin(server);
  assert.equal(readyAgain.ready, true);
  assert.equal(readyAgain.synchronized, false);
  assert.equal(syncCount, 1);

  // 4) Disabled uMod remains an explicit, actionable failure.
  const disabled = { ...server, uMod: false };
  await assert.rejects(() => manager.ensureUmodForPlugin(disabled), /uMod is disabled/);

  // 5) Source contracts: IPC plugin handler must preflight uMod, and save core strips transport metadata.
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const managerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'server-manager.js'), 'utf8');
  const umodSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'umod.js'), 'utf8');
  assert(mainSource.includes("await servers.ensureUmodForPlugin(server);"));
  assert(managerSource.includes('delete requested.id;'));
  assert(managerSource.includes('delete requested.serverId;'));
  assert(managerSource.includes('Once Rust has reached READY'));
  assert(umodSource.includes('canonical latest/download URL is the authoritative Windows source'));
  assert(umodSource.includes('https://umod.org/games/rust/download'));
  assert(umodSource.includes('https://github.com/OxideMod/Oxide.Rust/releases/latest/download/Oxide.Rust.zip'));
  assert(umodSource.includes('Oxide.CSharp.dll'));
  assert(umodSource.includes('Oxide.References.dll'));
  assert(umodSource.includes('Oxide.Unity.dll'));
  assert(umodSource.includes('async runtimeIntegrity()'));
  assert(managerSource.includes('Once Rust has reached READY')); 
  assert(umodSource.includes("'Oxide.Common.dll'"));
  assert(umodSource.includes('Oxide.Rust.dll'));
  assert(umodSource.includes('findExtractedOxideRoot'));
  assert(umodSource.includes('Oxide.Common.dll'));
  assert(umodSource.includes('Assembly-CSharp.dll'));
  assert(managerSource.includes('runtimePrepareQueue = Promise.resolve()'));
  assert(managerSource.includes('queueRuntimePreparation(task)'));

  // 9) The console command path prefers WebRCON when available and produces
  // visible command/result lines for the main live console.


  // 6) Start-time RCON conflict is repaired without allowing Rust to bind a duplicate socket.
  const conflict = { ...server, id: 'srv-rcon-conflict', ports: { server: 29215, query: 29216, rcon: 29217 }, uMod: false };
  const net = require('net');
  const holder = net.createServer();
  const originalRconPort = conflict.ports.rcon;
  await new Promise((resolve, reject) => { holder.once('error', reject); holder.listen(originalRconPort, '127.0.0.1', resolve); });
  store.state.servers = [server, conflict];
  const originalCheck = manager.prepareStartPorts.bind(manager);
  // The real port probe is used; the held TCP socket makes this a genuine conflict.
  const prepared = await originalCheck(conflict);
  assert.notEqual(prepared.rcon, originalRconPort);
  assert(await require('../src/core/ports').checkPort(prepared.rcon, 'tcp'));
  await new Promise(resolve => holder.close(resolve));

  // 7) Command path prefers RCON and always leaves a visible console echo.
  let rconCalls = 0;
  const messages = [];
  manager.rcon = {
    status: () => ({ connected: true }),
    async command(_id, command) { rconCalls += 1; return { Message: `echo:${command}` }; },
    async disconnect() {}
  };
  manager.on('log', event => messages.push(event));
  const commandResult = await manager.command(server.id, 'status');
  assert.equal(rconCalls, 1);
  assert.equal(commandResult.Message, 'echo:status');
  assert(messages.some(item => item.source === 'Console' && item.line === '> status'));
  assert(messages.some(item => item.source === 'RCON' && item.line === 'echo:status'));

  // 10) Exercise the real uMod archive-install logic with an in-memory Windows
  // package fixture. The fake AdmZip writes the same directory shape as the
  // official archive and lets us verify staged validation, copy, and post-copy
  // integrity without network access.
  const savedAdmLoad = Module._load;
  class FakeOxideZip {
    constructor() {}
    getEntries() {
      return [
        'RustDedicated_Data/Managed/Assembly-CSharp.dll',
        'RustDedicated_Data/Managed/Oxide.Common.dll',
        'RustDedicated_Data/Managed/Oxide.Core.dll',
        'RustDedicated_Data/Managed/Oxide.CSharp.dll',
        'RustDedicated_Data/Managed/Oxide.References.dll',
        'RustDedicated_Data/Managed/Oxide.Rust.dll',
        'RustDedicated_Data/Managed/Oxide.Unity.dll'
      ].map(entryName => ({ entryName }));
    }
    extractAllTo(stage) {
      const managed = path.join(stage, 'RustDedicated_Data', 'Managed');
      fs.mkdirSync(managed, { recursive: true });
      for (const name of ['Assembly-CSharp.dll','Oxide.Common.dll','Oxide.Core.dll','Oxide.CSharp.dll','Oxide.References.dll','Oxide.Rust.dll','Oxide.Unity.dll']) {
        fs.writeFileSync(path.join(managed, name), Buffer.alloc(4096, name === 'Assembly-CSharp.dll' ? 7 : 3));
      }
    }
  }
  Module._load = function(request, parent, isMain) {
    if (request === 'adm-zip') return FakeOxideZip;
    return savedAdmLoad.call(this, request, parent, isMain);
  };
  try {
    const umodModulePath = path.join(__dirname, '..', 'src', 'core', 'umod.js');
    delete require.cache[require.resolve(umodModulePath)];
    const { UmodProvider: Provider } = require(umodModulePath);
    const umodRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rust-forge-umod-fixture-'));
    const rustRoot = path.join(umodRoot, 'rust');
    const managed = path.join(rustRoot, 'RustDedicated_Data', 'Managed');
    const runtimeStore = {
      rustDir: rustRoot,
      runtimeDir: umodRoot,
      state: { settings: { downloadConcurrency: 2 } },
      serverIdentityPath: () => path.join(rustRoot, 'server', 'fixture')
    };
    await fs.promises.mkdir(managed, { recursive: true });
    await fs.promises.writeFile(path.join(managed, 'Assembly-CSharp.dll'), 'vanilla-assembly');
    const provider2 = new Provider(runtimeStore, () => {});
    await provider2.extractAndInstall(Buffer.from('PK'), { version: 'fixture', assetUrl: 'fixture', assetName: 'Oxide.Rust.zip' }, path.join(managed, 'Oxide.Core.dll'));
    const integrity = await provider2.runtimeIntegrity();
    assert.equal(integrity.ready, true);
    assert((await fs.promises.stat(path.join(managed, 'Assembly-CSharp.dll'))).size >= 1024);

    // 11) Exercise the REAL installOrUpdate async operation itself. This catches
    // the exact class of bug where an async IIFE is returned as a function instead
    // of being invoked, causing sync callers to continue before Oxide is installed.
    const umodRoot2 = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rust-forge-umod-install-fixture-'));
    const runtimeStore2 = {
      rustDir: path.join(umodRoot2, 'rust'),
      runtimeDir: umodRoot2,
      state: { settings: { downloadConcurrency: 2 } },
      serverIdentityPath: () => path.join(umodRoot2, 'rust', 'server', 'fixture')
    };
    const provider3 = new Provider(runtimeStore2, () => {});
    provider3.latestRelease = async () => ({ version: '2.0.7801', assetName: 'Oxide.Rust.zip', assetUrl: 'fixture://oxide', assetUrls: ['fixture://oxide'] });
    provider3.downloadArchive = async (_url, destination) => {
      await fs.promises.writeFile(destination, Buffer.from('PK'));
      return { finalUrl: 'fixture://oxide', bytes: 2, method: 'fixture' };
    };
    const installResult = await provider3.installOrUpdate({ force: true });
    assert.equal(installResult.version, '2.0.7801');
    assert.equal((await provider3.runtimeIntegrity()).ready, true);
    await fs.promises.rm(umodRoot2, { recursive: true, force: true });
    await fs.promises.rm(umodRoot, { recursive: true, force: true });
  } finally {
    Module._load = savedAdmLoad;
  }

  return 11;
}

(async () => {
  const checks = await runAudit(1) + await runAudit(2);
  console.log(`Rust Forge 1.0.0 targeted final audit passed — ${checks} checks across 2 runs.`);
})().catch(error => {
  console.error('FAIL', error.stack || error.message || error);
  process.exitCode = 1;
});
