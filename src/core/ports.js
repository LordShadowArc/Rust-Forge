const net = require('net');
const dgram = require('dgram');

function checkTcpPort(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const socket = net.createServer();
    const done = free => { try { socket.close(); } catch {} resolve(free); };
    socket.once('error', () => done(false));
    socket.once('listening', () => done(true));
    socket.listen(Number(port), host);
  });
}

function checkUdpPort(port, host = '0.0.0.0') {
  return new Promise(resolve => {
    const socket = dgram.createSocket('udp4');
    const done = free => { try { socket.close(); } catch {} resolve(free); };
    socket.once('error', () => done(false));
    socket.bind(Number(port), host, () => done(true));
  });
}

async function checkPort(port, protocol = 'udp') { return protocol === 'tcp' ? checkTcpPort(port) : checkUdpPort(port); }

function checkTcpListening(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port: Number(port) });
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(Boolean(value));
    };
    const timer = setTimeout(() => done(false), Math.max(250, Number(timeoutMs) || 1200));
    socket.once('connect', () => { clearTimeout(timer); done(true); });
    socket.once('error', () => { clearTimeout(timer); done(false); });
    socket.once('close', () => { clearTimeout(timer); });
  });
}

function checkUdpListening(port, host = '127.0.0.1') {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const { spawnHidden } = require('./util');
  return new Promise(resolve => {
    const normalizedHost = String(host || '127.0.0.1');
    const script = `(Get-NetUDPEndpoint -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty LocalPort)`;
    const child = spawnHidden('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(Boolean(value)); };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(false); }, 1800);
    child.stdout.on('data', chunk => { out += chunk.toString(); if (out.length > 2048) out = out.slice(-2048); });
    child.once('error', () => finish(false));
    child.once('close', code => finish(code === 0 && out.trim() === String(Number(port))));
  });
}

async function nextFreeTcpPort(start = 28017, reserved = []) {
  const blocked = new Set((reserved || []).map(Number));
  let candidate = Math.max(1024, Number(start) || 28017);
  while (candidate < 65530) {
    if (!blocked.has(candidate) && await checkPort(candidate, 'tcp')) return candidate;
    candidate++;
  }
  throw new Error('No free TCP port was available for RCON.');
}

async function nextFreePorts(start = 28015, count = 3) {
  const out = [];
  let candidate = Math.max(1024, Number(start) || 28015);
  while (out.length < count && candidate < 65530) {
    const protocol = out.length < 2 ? 'udp' : 'tcp';
    if (await checkPort(candidate, protocol) && !out.includes(candidate)) out.push(candidate);
    candidate++;
  }
  if (out.length !== count) throw new Error('Not enough free network ports were available.');
  return out;
}
module.exports = { checkTcpPort, checkUdpPort, checkPort, checkTcpListening, checkUdpListening, nextFreeTcpPort, nextFreePorts };
