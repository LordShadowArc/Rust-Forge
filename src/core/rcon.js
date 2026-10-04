const { EventEmitter } = require('events');
const WebSocket = require('ws');

function rconHost(server) {
  const host = String(server.bindIp || '').trim() || '127.0.0.1';
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}
function formatHost(host) { return host.includes(':') ? `[${host}]` : host; }

class RustRconClient extends EventEmitter {
  constructor(server, reconnectMs = 3000) {
    super();
    this.server = server;
    this.baseReconnectMs = Math.max(1000, Number(reconnectMs) || 3000);
    this.reconnectMs = this.baseReconnectMs;
    this.maxReconnectMs = 15000;
    this.ws = null;
    this.pending = new Map();
    this.seq = 1000;
    this.closedByUser = false;
    this.reconnectTimer = null;
    this.connectPromise = null;
    this.connectWaiters = new Set();
    this.generation = 0;
    this.notifyNextFailure = false;
  }

  url() {
    const host = rconHost(this.server);
    const password = encodeURIComponent(String(this.server.rconPassword || ''));
    return `ws://${formatHost(host)}:${Number(this.server.ports.rcon)}/${password}`;
  }

  connect({ silent = true, timeoutMs = 7000 } = {}) {
    this.closedByUser = false;
    if (!silent) this.notifyNextFailure = true;
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve({ connected: true });
    if (this.connectPromise) return this.connectPromise;

    const generation = ++this.generation;
    const ws = new WebSocket(this.url());
    this.ws = ws;

    this.connectPromise = this.waitForOpen(timeoutMs);
    const promise = this.connectPromise;

    ws.once('open', () => {
      if (generation !== this.generation || this.ws !== ws) return;
      this.reconnectMs = this.baseReconnectMs;
      this.notifyNextFailure = false;
      this.emit('status', { connected: true, retrying: false });
      this.resolveWaiters({ connected: true });
      this.send('serverinfo').catch(() => {});
      this.send('playerlist').catch(() => {});
    });

    ws.on('message', raw => {
      if (generation !== this.generation || this.ws !== ws) return;
      this.onMessage(raw.toString());
    });

    ws.once('error', error => {
      if (generation !== this.generation || this.ws !== ws) return;
      const notify = this.notifyNextFailure;
      this.notifyNextFailure = false;
      this.emit('error', { error: error.message, silent: !notify });
    });

    ws.once('close', () => {
      if (generation !== this.generation) return;
      for (const pending of this.pending.values()) pending.reject(new Error('RCON connection closed.'));
      this.pending.clear();
      if (this.ws === ws) this.ws = null;
      this.connectPromise = null;
      this.emit('status', { connected: false, retrying: !this.closedByUser });
      this.rejectWaiters(new Error('RCON connection closed.'));
      if (!this.closedByUser) this.scheduleReconnect();
    });

    promise.finally(() => {
      if (this.connectPromise === promise) this.connectPromise = null;
    }).catch(() => {});
    return promise;
  }

  waitForOpen(timeoutMs = 7000) {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve({ connected: true });
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.connectWaiters.delete(waiter);
        if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
          try { this.ws.terminate(); } catch { }
        }
        reject(new Error(`RCON connection timed out at ${formatHost(rconHost(this.server))}:${this.server.ports.rcon}.`));
      }, Math.max(1000, timeoutMs));
      this.connectWaiters.add(waiter);
    });
  }

  resolveWaiters(value) {
    const waiters = [...this.connectWaiters];
    this.connectWaiters.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  }

  rejectWaiters(error) {
    const waiters = [...this.connectWaiters];
    this.connectWaiters.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.closedByUser || this.connectPromise) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.maxReconnectMs, Math.ceil(this.reconnectMs * 1.7));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect({ silent: true, timeoutMs: 5000 }).catch(() => {});
    }, delay);
  }

  onMessage(raw) {
    let message;
    try { message = JSON.parse(raw); }
    catch { this.emit('message', { raw }); return; }
    this.emit('message', message);
    const identifier = Number(message.Identifier);
    if (this.pending.has(identifier)) {
      const pending = this.pending.get(identifier);
      this.pending.delete(identifier);
      pending.resolve(message);
    }
  }

  send(command, timeoutMs = 8000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('RCON is not connected.'));
    const identifier = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(identifier);
        reject(new Error(`RCON command timed out: ${command}`));
      }, Math.max(1000, timeoutMs));
      this.pending.set(identifier, {
        resolve: message => { clearTimeout(timer); resolve(message); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      try {
        this.ws.send(JSON.stringify({ Identifier: identifier, Message: String(command), Name: 'Rust Forge' }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(identifier);
        reject(error);
      }
    });
  }

  close() {
    this.closedByUser = true;
    this.generation += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const pending of this.pending.values()) pending.reject(new Error('RCON closed.'));
    this.pending.clear();
    this.rejectWaiters(new Error('RCON closed.'));
    this.connectPromise = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(); } catch {}
    }
  }
}

class RconManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.clients = new Map();
  }

  ensure(server) {
    let client = this.clients.get(server.id);
    if (!client) {
      client = new RustRconClient(server, Number(this.store.state.settings.rconReconnectMs) || 3000);
      client.on('status', status => this.emit('status', { id: server.id, ...status }));
      client.on('message', message => this.emit('message', { id: server.id, message }));
      client.on('error', payload => this.emit('error', { id: server.id, error: payload.error, silent: payload.silent !== false }));
      this.clients.set(server.id, client);
    } else {
      client.server = server;
      client.baseReconnectMs = Math.max(1000, Number(this.store.state.settings.rconReconnectMs) || 3000);
    }
    return client;
  }

  async autoConnect(id) {
    const server = this.store.getServer(id);
    if (!server) return false;
    this.ensure(server).connect({ silent: true, timeoutMs: 5000 }).catch(() => {});
    return true;
  }

  async connect(id) {
    const server = this.store.getServer(id);
    if (!server) throw new Error('Server profile not found.');
    await this.ensure(server).connect({ silent: false, timeoutMs: 7000 });
    return { id, connected: true };
  }

  async disconnect(id) {
    const client = this.clients.get(id);
    client?.close();
    this.clients.delete(id);
    return true;
  }

  async command(id, command) {
    const server = this.store.getServer(id);
    if (!server) throw new Error('Server profile not found.');
    const client = this.ensure(server);
    if (!client.ws || client.ws.readyState !== WebSocket.OPEN) {
      throw new Error('RCON is not connected. Connect to the server first.');
    }
    return client.send(command);
  }

  status(id) {
    const client = this.clients.get(id);
    return {
      connected: Boolean(client?.ws && client.ws.readyState === WebSocket.OPEN),
      retrying: Boolean(client?.reconnectTimer || client?.connectPromise)
    };
  }

  closeAll() {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}

module.exports = { RconManager, RustRconClient, rconHost };
