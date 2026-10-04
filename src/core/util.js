const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fsp = fs.promises;

async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); return dir; }
async function exists(file) { try { await fsp.access(file); return true; } catch { return false; } }
async function readJson(file, fallback) { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; } }
async function replaceFile(tmp, file) {
  try {
    await fsp.rename(tmp, file);
  } catch (error) {
    if (process.platform === 'win32' && ['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) {
      await fsp.unlink(file).catch(() => {});
      await fsp.rename(tmp, file);
      return;
    }
    throw error;
  }
}
async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  try { await replaceFile(tmp, file); } catch (error) { await fsp.unlink(tmp).catch(() => {}); throw error; }
}
function id(prefix = 'id') { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`; }
function secret(bytes = 18) { return crypto.randomBytes(bytes).toString('base64url'); }
function rconSecret(length = 32) {
  const size = Math.max(8, Math.min(64, Number(length) || 32));
  return crypto.randomBytes(Math.ceil(size / 2)).toString('hex').slice(0, size);
}
function safeName(value, fallback = 'server') {
  const cleaned = String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 32) || fallback;
}
function quote(value) { return `"${String(value).replace(/"/g, '\\"')}"`; }
function spawnHidden(command, args, options = {}) { return spawn(command, args, { windowsHide: true, shell: false, ...options }); }
function isProcessAlive(child) { return Boolean(child && child.exitCode === null && !child.killed); }
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function sha1(buffer) { return crypto.createHash('sha1').update(buffer).digest('hex'); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function withTimeout(promise, timeoutMs, label = 'Operation') {
  const ms = Math.max(1000, Number(timeoutMs) || 1000);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} seconds.`)), ms); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function atomicWrite(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  try { await replaceFile(tmp, file); } catch (error) { await fsp.unlink(tmp).catch(() => {}); throw error; }
}

async function killPid(pid, timeoutMs = 10000) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  if (process.platform !== 'win32') {
    try { process.kill(value, 'SIGTERM'); return true; } catch { return false; }
  }
  return new Promise(resolve => {
    const child = spawnHidden('taskkill.exe', ['/PID', String(value), '/T', '/F'], { stdio: ['ignore', 'ignore', 'ignore'] });
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(false);
    }, Math.max(1000, Number(timeoutMs) || 10000));
    child.once('error', () => finish(false));
    child.once('close', code => finish(code === 0));
  });
}


async function processExecutable(pid, timeoutMs = 5000) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return null;
  if (process.platform !== 'win32') return null;
  return new Promise(resolve => {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${value}" | Select-Object -ExpandProperty ExecutablePath) -join ''`;
    const child = spawnHidden('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(null);
    }, Math.max(1000, Number(timeoutMs) || 5000));
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 8192) output = output.slice(-8192);
    });
    child.once('error', () => finish(null));
    child.once('close', code => finish(code === 0 ? output.trim() || null : null));
  });
}

async function isExpectedProcess(pid, expectedExecutable) {
  if (!(await pidAlive(pid))) return false;
  if (process.platform !== 'win32') return true;
  const actual = await processExecutable(pid);
  if (!actual) return false;
  return path.resolve(actual).toLowerCase() === path.resolve(expectedExecutable).toLowerCase();
}

async function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try { process.kill(value, 0); return true; } catch { return false; }
}

module.exports = { ensureDir, exists, readJson, writeJson, id, secret, rconSecret, safeName, quote, spawnHidden, isProcessAlive, clamp, sha1, sleep, withTimeout, atomicWrite, replaceFile, killPid, pidAlive, processExecutable, isExpectedProcess, fsp };
