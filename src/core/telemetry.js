const { EventEmitter } = require('events');
const { spawnHidden } = require('./util');

function readProcessBatch(pids) {
  if (process.platform !== 'win32' || !pids.length) return Promise.resolve([]);
  const list = pids.map(Number).filter(Number.isInteger).join(',');
  const script = `$a=@(${list}); Get-Process -Id $a -ErrorAction SilentlyContinue | Select-Object Id,CPU,WorkingSet64,StartTime | ConvertTo-Json -Compress`;
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const child = spawnHidden('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], { stdio:['ignore','pipe','ignore'] });
    let out='';
    const finish = result => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish([]);
    }, 5000);
    child.stdout.on('data', b => {
      out += b.toString();
      if (out.length > 16384) out = out.slice(-16384);
    });
    child.once('error', () => finish([]));
    child.once('close', code => {
      if (code !== 0 || !out.trim()) return finish([]);
      try {
        const parsed = JSON.parse(out);
        finish(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {
        finish([]);
      }
    });
  });
}

class Telemetry extends EventEmitter {
  constructor(store) { super(); this.store = store; this.provider = () => []; this.timer = null; this.previous = new Map(); }
  setProvider(provider) { this.provider = provider; }
  lastFor(id) {
    const entry = this.previous.get(id);
    return entry?.lastSample || null;
  }
  start() { this.stop(); this.sample().catch(() => {}); const interval = Math.max(1000, Number(this.store.state.settings.telemetryIntervalMs) || 2000); this.timer = setInterval(() => this.sample().catch(() => {}), interval); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async sample() {
    const servers = this.provider().filter(s => Number.isInteger(Number(s.runtimePid)));
    const rows = await readProcessBatch(servers.map(s => s.runtimePid));
    const now = Date.now();
    const byPid = new Map(rows.map(x => [Number(x.Id), x]));
    for (const s of servers) {
      const row = byPid.get(Number(s.runtimePid));
      if (!row) continue;
      const prev = this.previous.get(s.id);
      const cpuMs = Number(row.CPU || 0) * 1000;
      const elapsed = prev ? Math.max(1, now - prev.at) : 0;
      const deltaCpu = prev ? Math.max(0, cpuMs - prev.cpuMs) : 0;
      const cores = Math.max(1, require('os').cpus().length || 1);
      const cpuPercent = elapsed ? Math.min(100, (deltaCpu / elapsed) * 100 / cores) : 0;
      const started = row.StartTime ? Date.parse(row.StartTime) : null;
      const uptimeSec = started ? Math.max(0, (now - started) / 1000) : 0;
      const data = { id: s.id, pid: Number(s.runtimePid), cpuPercent: Number(cpuPercent.toFixed(1)), memoryMb: Number((Number(row.WorkingSet64 || 0) / 1048576).toFixed(1)), uptimeSec: Math.floor(uptimeSec), sampledAt: now };
      this.previous.set(s.id, { cpuMs, at: now, lastSample: data });
      this.emit('sample', data);
    }
    for (const id of [...this.previous.keys()]) if (!servers.some(s => s.id === id)) this.previous.delete(id);
  }
}

module.exports = { Telemetry };
