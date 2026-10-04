const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const { AppStore } = require('./core/app-store');
const { SteamCmdProvider } = require('./core/steamcmd');
const { UmodProvider } = require('./core/umod');
const { ServerManager, isActiveStatus } = require('./core/server-manager');
const { RconManager } = require('./core/rcon');
const { Telemetry } = require('./core/telemetry');
const { BackupManager } = require('./core/backup');
const { Scheduler } = require('./core/scheduler');
const { RuntimeDiagnostics } = require('./core/diagnostics');
const { SETTINGS_SCHEMA } = require('./core/settings-schema');
const { PlayitManager } = require('./core/playit');
const { UpdateManager } = require('./core/updater');

app.setAppUserModelId('com.rustforge.app');
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  let mainWindow = null;
  let tray = null;
  let isQuitting = false;
  let quitInProgress = false;
  let statusTimer = null;

  const store = new AppStore();
  let servers;
  let rcon;
  let telemetry;
  let backups;
  let scheduler;
  let umod;
  let diagnostics;
  let playit;
  let updates;

  function broadcast(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  }

  function focusMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function serverIsRunning(server) {
    return isActiveStatus(server?.runtimeStatus) && server?.runtimeStatus !== 'stopping';
  }

  function serverLabelState(server) {
    if (server.runtimeStatus === 'running' || server.runtimeStatus === 'running-external') return '● Running';
    if (server.runtimeStatus === 'starting') return '◌ Starting';
    if (server.runtimeStatus === 'stopping') return '◌ Stopping';
    return '○ Ready';
  }

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1480,
      height: 930,
      minWidth: 1180,
      minHeight: 720,
      frame: false,
      show: false,
      backgroundColor: '#090a0c',
      icon: path.join(__dirname, '..', 'assets', 'rust-forge.ico'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: path.join(__dirname, 'preload.js')
      }
    });

    mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    mainWindow.once('ready-to-show', () => {
      if (!store.state.settings.startMinimized) mainWindow.show();
    });
    mainWindow.on('close', event => {
      if (!isQuitting && store.state.settings.closeToTray) {
        event.preventDefault();
        mainWindow.hide();
      }
    });
  }

  function updateTray() {
    if (!tray || !servers) return;
    const serverList = servers.list();
    const items = [
      { label: 'Open Rust Forge', click: focusMainWindow },
      { type: 'separator' }
    ];

    for (const server of serverList) {
      const selected = store.state.selectedServerId === server.id;
      items.push({
        label: `${selected ? '✓ ' : ''}${server.name} · ${serverLabelState(server)}`,
        submenu: [
          {
            label: serverIsRunning(server) ? 'Stop server' : 'Start server',
            enabled: server.runtimeStatus !== 'stopping',
            click: async () => {
              try {
                if (serverIsRunning(server)) await servers.stop(server.id, { reason: 'tray' });
                else await servers.start(server.id);
              } catch (error) {
                broadcast('toast', { kind: 'error', title: 'Tray operation failed', message: error.message });
              }
            }
          },
          {
            label: 'Open control dashboard',
            click: async () => {
              try { await servers.select(server.id); } catch {}
              focusMainWindow();
              broadcast('view', 'control');
            }
          },
          {
            label: 'Select server',
            click: async () => {
              try { await servers.select(server.id); } catch {}
              focusMainWindow();
              broadcast('state', servers.list());
            }
          }
        ]
      });
    }

    items.push(
      { type: 'separator' },
      {
        label: 'Stop all servers',
        enabled: serverList.some(serverIsRunning),
        click: async () => {
          for (const server of servers.list()) {
            if (serverIsRunning(server)) await servers.stop(server.id, { reason: 'tray-all' }).catch(() => {});
          }
        }
      },
      { type: 'separator' },
      { label: 'Exit Rust Forge', click: () => gracefulQuit() }
    );

    tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  function createTray() {
    if (tray) return;
    const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'rust-forge.ico'));
    tray = new Tray(icon);
    tray.setToolTip('Rust Forge');
    tray.on('double-click', focusMainWindow);
    updateTray();
  }

  async function gracefulQuit() {
    if (quitInProgress) return;
    quitInProgress = true;
    isQuitting = true;
    if (statusTimer) clearInterval(statusTimer);
    scheduler?.stop();
    telemetry?.stop();
    rcon?.closeAll();

    if (servers) {
      const active = servers.list().filter(serverIsRunning);
      for (const server of active) await servers.stop(server.id, { reason: 'exit' }).catch(() => {});
    }
    await playit?.stop().catch(() => {});
    app.quit();
  }

  async function setup() {
    await app.whenReady();
    await store.init();

    const emit = event => broadcast(event.type, event);
    const steam = new SteamCmdProvider(store, emit);
    rcon = new RconManager(store);
    telemetry = new Telemetry(store);
    umod = new UmodProvider(store, emit);
    playit = new PlayitManager(store);
    updates = new UpdateManager({ emit: payload => {
      if (payload?.type) broadcast(payload.type, payload.state);
    }});
    servers = new ServerManager(store, steam, umod, rcon, telemetry, undefined, playit);
    backups = new BackupManager(store, emit, servers);
    scheduler = new Scheduler(store, servers, backups, rcon, umod);
    diagnostics = new RuntimeDiagnostics(store, servers, rcon, telemetry, { playit });

    await servers.init();
    servers.setRuntimeTelemetry();

    servers.on('log', payload => broadcast('log', payload));
    servers.on('state', payload => { broadcast('state', payload); updateTray(); });
    servers.on('lifecycle', payload => { broadcast('lifecycle', payload); updateTray(); });
    servers.on('progress', payload => broadcast('progress', payload));
    servers.on('toast', payload => broadcast('toast', payload));
    telemetry.on('sample', payload => broadcast('telemetry', payload));
    rcon.on('status', payload => broadcast('rcon:status', payload));
    rcon.on('message', payload => broadcast('rcon:message', payload));
    rcon.on('error', payload => {
      if (!payload?.silent) broadcast('toast', { kind: 'error', title: 'RCON connection failed', message: payload.error });
    });
    scheduler.on('automation-error', payload => broadcast('toast', { kind: 'error', title: payload.title, message: payload.message }));
    scheduler.on('notification', payload => broadcast('toast', payload));
    playit.on('state', payload => broadcast('playit:state', payload));
    playit.on('claim', url => { broadcast('playit:claim', { url }); broadcast('toast', { kind: 'info', title: 'Playit claim ready', message: 'Open Settings → Network / Playit to finish the one-time claim.' }); });
    playit.on('log', payload => broadcast('playit:log', payload));

    createWindow();
    createTray();
    scheduler.start();
    setTimeout(() => updates.check().catch(() => {}), 3500);
    setInterval(() => updates.check().catch(() => {}), 6 * 60 * 60 * 1000);

    const refreshStatusTimer = () => {
      if (statusTimer) clearInterval(statusTimer);
      const interval = Math.max(750, Number(store.state.settings.statusPollMs) || 1500);
      statusTimer = setInterval(() => servers.reconcile().catch(() => {}), interval);
    };
    refreshStatusTimer();

    ipcMain.handle('app:get-state', () => ({ state: store.state, servers: servers.list(), schema: SETTINGS_SCHEMA, playit: playit.snapshot(), appVersion: app.getVersion(), updates: updates?.last || null }));
    ipcMain.handle('app:settings', () => ({ settings: store.state.settings, schema: SETTINGS_SCHEMA }));
    ipcMain.handle('app:save-settings', async (_event, patch) => {
      const previousSettings = { ...store.state.settings };
      const previousSelected = store.state.selectedServerId;
      store.state.settings = store.normalizeSettings({ ...store.state.settings, ...(patch || {}) });
      if (!store.state.settings.rememberLastServer) store.state.selectedServerId = null;
      try {
        await store.save();
      } catch (error) {
        store.state.settings = previousSettings;
        store.state.selectedServerId = previousSelected;
        throw error;
      }
      updateTray();
      broadcast('state', servers.list());
      scheduler.stop();
      scheduler.start();
      telemetry.start();
      refreshStatusTimer();
      return store.state.settings;
    });
    ipcMain.handle('app:open-data', async () => shell.openPath(store.root));
    ipcMain.handle('app:open-external', async (_event, url) => {
      if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
      return true;
    });
    ipcMain.handle('playit:status', () => playit.status());
    ipcMain.handle('playit:start', () => playit.ensureStarted());
    ipcMain.handle('playit:stop', () => playit.stop());
    ipcMain.handle('playit:open-dashboard', () => playit.openDashboard(shell));
    ipcMain.handle('playit:open-claim', () => playit.openClaim(shell));
    ipcMain.handle('updates:get', () => updates?.last || null);
    ipcMain.handle('updates:check', () => updates.check());
    ipcMain.handle('updates:download', (_event, kind) => updates.download(kind));
    ipcMain.handle('updates:open', async (_event, url) => {
      if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
      return true;
    });

    ipcMain.handle('server:create', async (_event, input) => {
      const server = await servers.create(input);
      return servers.list().find(item => item.id === server.id);
    });
    ipcMain.handle('server:remove', async (_event, payload) => {
      await servers.remove(payload.id, { deleteData: Boolean(payload.deleteData) });
      return servers.list();
    });
    ipcMain.handle('server:start', (_event, id) => servers.start(id));
    ipcMain.handle('server:stop', (_event, id) => servers.stop(id));
    ipcMain.handle('server:restart', (_event, id) => servers.restart(id));
    ipcMain.handle('server:update', (_event, id) => servers.updateServer(id));
    ipcMain.handle('server:select', (_event, id) => servers.select(id));
    ipcMain.handle('server:save', (_event, payload) => servers.setConfig(payload.id, payload.patch));
    ipcMain.handle('server:command', (_event, payload) => servers.command(payload.id, payload.command));
    ipcMain.handle('server:apply-performance', (_event, payload) => servers.setPerformanceProfile(payload.id, payload.profile, { apply: true }));

    ipcMain.handle('runtime:bootstrap', () => servers.bootstrap());
    ipcMain.handle('runtime:umod', () => servers.syncUmod());
    ipcMain.handle('diagnostics:run', async (_event, serverId) => diagnostics.run({ serverId: serverId || null }));
    ipcMain.handle('rcon:connect', (_event, id) => rcon.connect(id));
    ipcMain.handle('rcon:disconnect', (_event, id) => rcon.disconnect(id));
    ipcMain.handle('rcon:command', (_event, payload) => rcon.command(payload.id, payload.command));
    ipcMain.handle('rcon:status', (_event, id) => rcon.status(id));

    ipcMain.handle('backup:create', async (_event, payload) => {
      const server = store.getServer(payload.id);
      if (!server) throw new Error('Server profile not found.');
      return backups.create(server, { reason: payload.reason || 'manual', quiesce: payload.quiesce !== false });
    });
    ipcMain.handle('server:wipe', async (_event, payload) => {
      const server = store.getServer(payload.id);
      if (!server) throw new Error('Server profile not found.');
      return backups.wipe(server, { blueprintWipe: Boolean(payload.blueprintWipe), forceBackup: payload.forceBackup !== false });
    });
    ipcMain.handle('scheduler:get', (_event, id) => {
      const server = store.getServer(id);
      if (!server) throw new Error('Server profile not found.');
      return {
        backup: server.schedules?.backup,
        wipe: server.schedules?.wipe,
        nextBackup: scheduler.nextBackup(server),
        nextWipe: scheduler.nextWipe(server)
      };
    });
    ipcMain.handle('scheduler:save', (_event, payload) => servers.setSchedules(payload.id, payload.schedules));

    ipcMain.handle('plugins:search', (_event, payload) => umod.searchPlugins(payload.query, payload.page || 1));
    ipcMain.handle('plugins:install', async (_event, payload) => {
      const server = store.getServer(payload.serverId);
      if (!server) throw new Error('Server profile not found.');
      // Plugin installation is autonomous: the first plugin request prepares
      // the shared uMod runtime safely before touching the target server's
      // isolated plugin directory. Runtime synchronization owns its own
      // maintenance lock and may stop/restart active instances exactly once.
      await servers.ensureUmodForPlugin(server);
      return servers.withLifecycle(server.id, () => umod.installPlugin(server, payload.slug));
    });
    ipcMain.handle('plugins:installed', (_event, serverId) => {
      const server = store.getServer(serverId);
      if (!server) throw new Error('Server profile not found.');
      return umod.listInstalledPlugins(server);
    });
    ipcMain.handle('plugins:remove', (_event, payload) => {
      const server = store.getServer(payload.serverId);
      if (!server) throw new Error('Server profile not found.');
      return servers.withLifecycle(server.id, () => umod.removePlugin(server, payload.filename));
    });
    ipcMain.handle('plugins:update-all', (_event, serverId) => {
      const server = store.getServer(serverId);
      if (!server) throw new Error('Server profile not found.');
      return servers.withLifecycle(server.id, () => umod.updatePlugins(server));
    });

    ipcMain.on('window:minimize', () => mainWindow?.minimize());
    ipcMain.on('window:close', () => {
      if (store.state.settings.closeToTray) mainWindow?.hide();
      else gracefulQuit();
    });

    process.on('uncaughtException', error => broadcast('toast', { kind: 'error', title: 'Unexpected error', message: error.message }));
    process.on('unhandledRejection', error => broadcast('toast', { kind: 'error', title: 'Operation error', message: error?.message || String(error) }));
  }

  app.on('second-instance', () => focusMainWindow());
  app.on('activate', () => focusMainWindow());
  app.on('before-quit', event => {
    if (isQuitting || quitInProgress) return;
    event.preventDefault();
    gracefulQuit();
  });
  app.on('window-all-closed', () => {});

  setup().catch(async error => {
    await app.whenReady().catch(() => {});
    isQuitting = true;
    broadcast('toast', { kind: 'error', title: 'Rust Forge failed to initialize', message: error.message });
    app.quit();
  });
}
