const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rustForge', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  createServer: input => ipcRenderer.invoke('server:create', input),
  removeServer: (id, opts) => ipcRenderer.invoke('server:remove', { id, ...(opts || {}) }),
  startServer: id => ipcRenderer.invoke('server:start', id),
  stopServer: id => ipcRenderer.invoke('server:stop', id),
  restartServer: id => ipcRenderer.invoke('server:restart', id),
  updateServer: id => ipcRenderer.invoke('server:update', id),
  selectServer: id => ipcRenderer.invoke('server:select', id),
  saveServer: (id, patch) => ipcRenderer.invoke('server:save', { id, patch }),
  serverCommand: (id, command) => ipcRenderer.invoke('server:command', { id, command }),
  applyPerformance: (id, profile) => ipcRenderer.invoke('server:apply-performance', { id, profile }),
  bootstrap: () => ipcRenderer.invoke('runtime:bootstrap'),
  installUmod: () => ipcRenderer.invoke('runtime:umod'),
  runDiagnostics: serverId => ipcRenderer.invoke('diagnostics:run', serverId || null),
  searchPlugins: (query, page) => ipcRenderer.invoke('plugins:search', { query, page }),
  installPlugin: (serverId, slug) => ipcRenderer.invoke('plugins:install', { serverId, slug }),
  installedPlugins: serverId => ipcRenderer.invoke('plugins:installed', serverId),
  removePlugin: (serverId, filename) => ipcRenderer.invoke('plugins:remove', { serverId, filename }),
  updatePlugins: serverId => ipcRenderer.invoke('plugins:update-all', serverId),
  rconConnect: id => ipcRenderer.invoke('rcon:connect', id),
  rconDisconnect: id => ipcRenderer.invoke('rcon:disconnect', id),
  rconCommand: (id, command) => ipcRenderer.invoke('rcon:command', { id, command }),
  rconStatus: id => ipcRenderer.invoke('rcon:status', id),
  createBackup: (id, reason, quiesce) => ipcRenderer.invoke('backup:create', { id, reason, quiesce }),
  wipeServer: (id, blueprintWipe, forceBackup) => ipcRenderer.invoke('server:wipe', { id, blueprintWipe, forceBackup }),
  schedulerGet: id => ipcRenderer.invoke('scheduler:get', id),
  schedulerSave: (id, schedules) => ipcRenderer.invoke('scheduler:save', { id, schedules }),
  settings: () => ipcRenderer.invoke('app:settings'),
  saveSettings: patch => ipcRenderer.invoke('app:save-settings', patch),
  openDataFolder: () => ipcRenderer.invoke('app:open-data'),
  openExternal: url => ipcRenderer.invoke('app:open-external', url),
  playitStatus: () => ipcRenderer.invoke('playit:status'),
  playitStart: () => ipcRenderer.invoke('playit:start'),
  playitStop: () => ipcRenderer.invoke('playit:stop'),
  playitOpenDashboard: () => ipcRenderer.invoke('playit:open-dashboard'),
  playitOpenClaim: () => ipcRenderer.invoke('playit:open-claim'),
  updates: () => ipcRenderer.invoke('updates:get'),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdateAsset: kind => ipcRenderer.invoke('updates:download', kind),
  openUpdateUrl: url => ipcRenderer.invoke('updates:open', url),
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  on: (channel, callback) => {
    const allowed = new Set(['state','log','lifecycle','progress','toast','telemetry','rcon:status','rcon:message','view','playit:state','playit:claim','playit:log','updates:state','updates:download']);
    if (!allowed.has(channel)) return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
