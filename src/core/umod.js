const path = require('path');
const AdmZip = require('adm-zip');
const { exists, ensureDir, fsp, sha1, atomicWrite } = require('./util');

const GITHUB_RELEASES = 'https://api.github.com/repos/OxideMod/Oxide.Rust/releases/latest';
const UMOD_STABLE_DOWNLOAD = 'https://umod.org/games/rust/download';
const UMOD_WINDOWS_DIRECT_DOWNLOAD = 'https://github.com/OxideMod/Oxide.Rust/releases/latest/download/Oxide.Rust.zip';
const UMOD_WINDOWS_DIRECT_ALIASES = [
  UMOD_STABLE_DOWNLOAD,
  UMOD_WINDOWS_DIRECT_DOWNLOAD
];

// Known current compatibility for the Rust build currently served by Facepunch
// (Rust protocol/build 2634.289.1, Oct 2 2026). Keep this as a fallback only;
// the release API remains authoritative when reachable.
const KNOWN_COMPATIBLE_RELEASES = [
  { rustBuild: '2634.289.1', version: '2.0.7801', url: 'https://github.com/OxideMod/Oxide.Rust/releases/download/2.0.7801/Oxide.Rust.zip' }
];
const UMOD_SEARCH = 'https://umod.org/plugins/search.json';
const UMOD_INFO = slug => `https://umod.org/plugins/${encodeURIComponent(slug)}.json`;
const USER_AGENT = 'Rust-Forge/1.0.0';
const NETWORK_TIMEOUT_MS = 120000;
// These files are the actual Windows Oxide runtime contract for Rust.
// Assembly-CSharp.dll is included because Oxide patches the Rust game assembly;
// having only the Oxide.* helper DLLs is not enough to make uMod load.
const WINDOWS_OXIDE_RUNTIME_FILES = [
  'Assembly-CSharp.dll',
  'Oxide.Common.dll',
  'Oxide.Core.dll',
  'Oxide.CSharp.dll',
  'Oxide.References.dll',
  'Oxide.Rust.dll',
  'Oxide.Unity.dll'
];

async function fetchWithTimeout(url, options = {}, timeoutMs = NETWORK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Network request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function jsonFetch(url, options = {}) {
  const response = await fetchWithTimeout(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function extractZipToStage(zipPath, stage) {
  await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
  await ensureDir(stage);
  try {
    const archive = new AdmZip(zipPath);
    archive.extractAllTo(stage, true);
    return 'adm-zip';
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    // Windows has a native, well-tested ZIP extractor. Use it as a fallback
    // when a third-party ZIP parser cannot reproduce the package layout.
    const { spawnHidden } = require('./util');
    const script = [
      '$ErrorActionPreference = "Stop"',
      `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(stage)} -Force`
    ].join('; ');
    await new Promise((resolve, reject) => {
      const child = spawnHidden('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `Expand-Archive exited with code ${code}`)));
    });
    return 'powershell';
  }
}

async function locateManagedDirectory(stage) {
  const stack = [stage];
  while (stack.length) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name.toLowerCase() === 'managed') {
        const dataDir = path.basename(path.dirname(full));
        const core = path.join(full, 'Oxide.Core.dll');
        if (dataDir.toLowerCase() === 'rustdedicated_data' && await exists(core)) return full;
      }
      stack.push(full);
    }
  }
  return null;
}

class TaskQueue {
  constructor(getConcurrency) {
    this.getConcurrency = getConcurrency;
    this.active = 0;
    this.pending = [];
  }

  push(task) {
    return new Promise((resolve, reject) => {
      this.pending.push({ task, resolve, reject });
      this.pump();
    });
  }

  pump() {
    const limit = Math.max(1, Math.min(4, Number(this.getConcurrency()) || 2));
    while (this.active < limit && this.pending.length) {
      const job = this.pending.shift();
      this.active += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }
}

function parseDependencies(source) {
  const required = new Set();
  const optional = new Set();
  const text = String(source || '');
  let match;

  const requiresComment = /^\s*\/\/\s*Requires:\s*([^\r\n]+)/gim;
  while ((match = requiresComment.exec(text))) {
    String(match[1]).split(/[,;]/).map(value => value.trim()).filter(Boolean).forEach(value => required.add(value));
  }

  const requiresAttribute = /\[\s*Requires(?:\s*\(\s*["']([^"']+)["']\s*\))?\s*\]/gi;
  while ((match = requiresAttribute.exec(text))) {
    if (match[1]) required.add(match[1]);
    else {
      const nearby = text.slice(requiresAttribute.lastIndex, requiresAttribute.lastIndex + 300);
      const field = nearby.match(/(?:private|public|protected)\s+(?:IPlugin|Plugin)\s+([A-Za-z0-9_]+)/);
      if (field) required.add(field[1]);
    }
  }

  const optionalAttribute = /\[\s*Optional(?:\s*\(\s*["']([^"']+)["']\s*\))?\s*\]/gi;
  while ((match = optionalAttribute.exec(text))) {
    if (match[1]) optional.add(match[1]);
    else {
      const nearby = text.slice(optionalAttribute.lastIndex, optionalAttribute.lastIndex + 300);
      const field = nearby.match(/(?:private|public|protected)\s+(?:IPlugin|Plugin)\s+([A-Za-z0-9_]+)/);
      if (field) optional.add(field[1]);
    }
  }

  // Legacy PluginReference declarations are optional dependencies.
  const legacyReference = /\[\s*PluginReference(?:\s*\([^\)]*\))?\s*\]\s*(?:private|public|protected)\s+(?:IPlugin|Plugin)\s+([A-Za-z0-9_]+)/gi;
  while ((match = legacyReference.exec(text))) optional.add(match[1]);

  return {
    required: [...required].filter(value => !optional.has(value)),
    optional: [...optional]
  };
}

class UmodProvider {
  constructor(store, emit = () => {}) {
    this.store = store;
    this.emit = emit;
    this.busy = false;
    this.currentInstall = null;
    this.pluginJobs = new Map();
    this.serverQueues = new Map();
    this.queue = new TaskQueue(() => this.store.state.settings.downloadConcurrency);
  }

  setRuntimeGate(_gate) { /* Runtime serialization is owned by ServerManager. */ }

  enqueueServer(serverId, task) {
    const previous = this.serverQueues.get(serverId) || Promise.resolve();
    const current = previous.catch(() => {}).then(task).finally(() => {
      if (this.serverQueues.get(serverId) === current) this.serverQueues.delete(serverId);
    });
    this.serverQueues.set(serverId, current);
    return current;
  }

  async readRustBuild() {
    const logsDir = path.join(this.store.rustDir, 'server');
    const stack = [logsDir];
    while (stack.length) {
      const current = stack.pop();
      let entries = [];
      try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { stack.push(full); continue; }
        if (!entry.isFile() || !/\.log$/i.test(entry.name)) continue;
        const text = await fsp.readFile(full, 'utf8').catch(() => '');
        const match = text.match(/Protocol:\s*([0-9.]+)/i);
        if (match) return match[1];
      }
    }
    return null;
  }

  async downloadArchive(url, destination) {
    let lastError = null;
    try {
      const response = await fetchWithTimeout(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/zip, application/octet-stream, */*' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 1024 || bytes.slice(0, 2).toString() !== 'PK') {
        throw new Error(`Response was not a ZIP archive (final URL: ${response.url || url}).`);
      }
      await fsp.writeFile(destination, bytes);
      return { finalUrl: response.url || url, bytes: bytes.length, method: 'node-fetch' };
    } catch (error) {
      lastError = error;
    }

    // Windows ships curl.exe. Use it as a transport fallback for releases that
    // involve redirects to release-assets.githubusercontent.com; this avoids
    // treating a transient Node fetch/redirect problem as a bad Oxide package.
    if (process.platform === 'win32') {
      const { spawnHidden } = require('./util');
      await new Promise((resolve, reject) => {
        const child = spawnHidden('curl.exe', [
          '-L', '--fail', '--silent', '--show-error',
          '-A', USER_AGENT,
          '-o', destination,
          url
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr?.on('data', chunk => { stderr += String(chunk); });
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `curl exited with code ${code}`)));
      }).catch(error => { lastError = lastError || error; });
      if (await exists(destination)) {
        const bytes = await fsp.readFile(destination);
        if (bytes.length >= 1024 && bytes.slice(0, 2).toString() === 'PK') {
          return { finalUrl: url, bytes: bytes.length, method: 'curl.exe' };
        }
      }
    }
    throw lastError || new Error(`Unable to download ${url}`);
  }

  async latestRelease() {
    // Installation must not depend on the GitHub API being available. The
    // canonical latest/download URL is the authoritative Windows source; the
    // API is metadata enrichment only. This avoids a needless API-rate-limit or
    // transient-GitHub failure becoming a hard uMod installation failure.
    let release = null;
    try { release = await jsonFetch(GITHUB_RELEASES); } catch {}
    const knownBuild = await this.readRustBuild();
    const known = KNOWN_COMPATIBLE_RELEASES.find(item => item.rustBuild === knownBuild) || null;
    const assets = Array.isArray(release?.assets)
      ? release.assets.filter(asset => /\.zip$/i.test(asset.name || ''))
      : [];
    const exactWindows = assets.find(item => /^Oxide\.Rust\.zip$/i.test(item.name || ''));
    const windowsCandidates = assets
      .filter(item => !/linux|posix|mac|osx|arm64/i.test(item.name || ''))
      .sort((a, b) => {
        const score = name => /^oxide\.rust(?:-windows|-win64)?\.zip$/i.test(name || '') ? 0 : 1;
        return score(a.name) - score(b.name);
      });
    const version = release?.tag_name || 'latest';
    const tagDownload = version !== 'latest'
      ? `https://github.com/OxideMod/Oxide.Rust/releases/download/${encodeURIComponent(version)}/Oxide.Rust.zip`
      : null;
    // Prefer the exact asset from the exact release tag. The /latest/download
    // redirect is useful as a fallback, but the tagged asset is deterministic and
    // prevents GitHub/uMod redirect changes from selecting the wrong platform.
    // The uMod site is the canonical Windows entry point; it intentionally
    // redirects to the current supported Windows build. Keep it first, then
    // fall back to the exact GitHub release asset/tag if the redirect is down.
    const urls = [
      known?.url,
      exactWindows?.browser_download_url,
      tagDownload,
      UMOD_STABLE_DOWNLOAD,
      UMOD_WINDOWS_DIRECT_DOWNLOAD,
      ...windowsCandidates.map(item => item.browser_download_url)
    ].filter(Boolean);
    const selectedVersion = known?.version || version;
    return {
      version: selectedVersion,
      assetUrl: known?.url || exactWindows?.browser_download_url || tagDownload || UMOD_WINDOWS_DIRECT_DOWNLOAD,
      assetName: exactWindows?.name || 'Oxide.Rust.zip',
      assetUrls: [...new Set(urls)],
      publishedAt: release?.published_at || null,
      rustBuild: knownBuild || null
    };
  }

  async findExtractedOxideRoot(root) {
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (entry.isFile() && entry.name.toLowerCase() === 'oxide.core.dll') {
          const managed = path.dirname(full);
          const dataDir = path.dirname(managed);
          if (path.basename(dataDir).toLowerCase() !== 'rustdedicated_data') continue;
          return path.dirname(dataDir);
        }
      }
    }
    return null;
  }

  async extractAndInstall(zip, release, marker) {
    const stage = path.join(this.store.runtimeDir, `umod-stage-${Date.now()}-${process.pid}`);
    const temp = path.join(this.store.runtimeDir, `umod-${Date.now()}-${process.pid}.zip`);
    await fsp.writeFile(temp, zip);
    try {
      const archive = new AdmZip(temp);
      const entries = archive.getEntries().map(entry => String(entry.entryName || '').replace(/\\/g, '/'));
      const oxideEntry = entries.find(name => /(?:^|\/)RustDedicated_Data\/Managed\/Oxide\.Core\.dll$/i.test(name));
      if (!oxideEntry) {
        throw new Error(`Windows Oxide archive does not contain RustDedicated_Data/Managed/Oxide.Core.dll (${release.assetName || 'unknown asset'}).`);
      }

      this.emit({ type: 'log', source: 'uMod', line: `Windows Oxide archive matched: ${oxideEntry}` });
      let extractionEngine = 'adm-zip';
      try {
        extractionEngine = await extractZipToStage(temp, stage);
      } catch (error) {
        throw new Error(`Windows Oxide ZIP extraction failed: ${error.message}`);
      }

      // Resolve the actual RustDedicated_Data/Managed directory from the staged
      // package rather than assuming a particular archive root or folder depth.
      // This tolerates both the canonical root layout and nested release bundles.
      let sourceManaged = await locateManagedDirectory(stage);
      if (!sourceManaged && process.platform === 'win32' && extractionEngine === 'adm-zip') {
        this.emit({ type: 'log', source: 'uMod', line: 'AdmZip did not expose a valid Windows Oxide Managed tree; retrying extraction with Windows Expand-Archive…' });
        extractionEngine = await extractZipToStage(temp, stage);
        sourceManaged = await locateManagedDirectory(stage);
      }
      if (!sourceManaged) throw new Error(`Windows Oxide package extraction produced no RustDedicated_Data/Managed/Oxide.Core.dll (engine=${extractionEngine}).`);

      // Validate the staged package BEFORE touching the live Rust installation.
      // A bad/partial archive must never leave the server with a half-patched
      // Managed directory.
      const missingSource = [];
      for (const name of WINDOWS_OXIDE_RUNTIME_FILES) {
        if (!(await exists(path.join(sourceManaged, name)))) missingSource.push(name);
      }
      if (missingSource.length) {
        throw new Error(`Windows Oxide archive is incomplete. Missing from staged Managed tree: ${missingSource.join(', ')}. Source=${sourceManaged}`);
      }

      const sourceDataDir = path.dirname(sourceManaged);
      const sourceRoot = path.dirname(sourceDataDir);
      const targetDataDir = path.join(this.store.rustDir, 'RustDedicated_Data');
      const targetManaged = path.join(targetDataDir, 'Managed');
      const existingAssembly = path.join(targetManaged, 'Assembly-CSharp.dll');
      const beforeAssemblyHash = await exists(existingAssembly) ? sha1(await fsp.readFile(existingAssembly)) : null;

      // Copy the COMPLETE Windows Oxide package root, not just Managed/. The
      // package also contains the oxide/ runtime tree and auxiliary directories.
      // Per-server +oxide.directory still isolates plugin/config/data at runtime.
      await ensureDir(this.store.rustDir);
      const packageEntries = await fsp.readdir(sourceRoot, { withFileTypes: true });
      for (const entry of packageEntries) {
        const src = path.join(sourceRoot, entry.name);
        const dst = path.join(this.store.rustDir, entry.name);
        await fsp.cp(src, dst, { recursive: true, force: true });
      }

      this.emit({ type: 'log', source: 'uMod', line: `Windows Oxide package extracted with ${extractionEngine}; package root=${sourceRoot}; Managed=${sourceManaged}.` });

      const missing = [];
      const invalid = [];
      for (const name of WINDOWS_OXIDE_RUNTIME_FILES) {
        const file = path.join(targetManaged, name);
        if (!(await exists(file))) missing.push(name);
        else {
          const stat = await fsp.stat(file).catch(() => null);
          if (!stat || !stat.isFile() || stat.size < 1024) invalid.push(name);
        }
      }
      if (missing.length || invalid.length) {
        const detail = [
          missing.length ? `missing: ${missing.join(', ')}` : '',
          invalid.length ? `invalid/empty: ${invalid.join(', ')}` : ''
        ].filter(Boolean).join('; ');
        throw new Error(`uMod package was extracted but the Rust install is still incomplete (${detail}). Target=${targetManaged}`);
      }

      const oxideVersionFiles = ['Oxide.Core.dll', 'Oxide.CSharp.dll', 'Oxide.References.dll', 'Oxide.Rust.dll', 'Oxide.Unity.dll'];
      const oxideSizes = [];
      for (const name of oxideVersionFiles) {
        const stat = await fsp.stat(path.join(targetManaged, name));
        oxideSizes.push(`${name}=${stat.size}B`);
      }
      this.emit({ type: 'log', source: 'uMod', line: `Windows Oxide runtime verified at ${targetManaged}: ${oxideSizes.join(', ')}.` });

      const afterAssemblyHash = await sha1(await fsp.readFile(existingAssembly));
      if (beforeAssemblyHash && beforeAssemblyHash === afterAssemblyHash) {
        throw new Error('Windows Oxide package did not replace Assembly-CSharp.dll. The runtime would remain vanilla; installation was rejected.');
      }

      this.emit({ type: 'log', source: 'uMod', line: `Installed Windows Oxide ${release.version} from ${release.assetUrl || release.assetName || 'unknown source'} into ${targetManaged}. Patched Assembly-CSharp.dll verified.` });
      await atomicWrite(this.markerPath(), JSON.stringify({
        version: release.version,
        publishedAt: release.publishedAt,
        installedAt: Date.now(),
        asset: release.assetName || null,
        source: release.assetUrl || null
      }));
      return true;
    } finally {
      await fsp.unlink(temp).catch(() => {});
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }

  async runtimeIntegrity() {
    const managed = path.join(this.store.rustDir, 'RustDedicated_Data', 'Managed');
    const required = [...WINDOWS_OXIDE_RUNTIME_FILES];
    const missing = [];
    for (const name of required) {
      if (!(await exists(path.join(managed, name)))) missing.push(name);
    }
    return { ready: missing.length === 0, managed, required, missing };
  }

  async isInstalled() {
    const integrity = await this.runtimeIntegrity();
    return integrity.ready;
  }

  markerPath() { return path.join(this.store.runtimeDir, 'umod-version.json'); }

  async installOrUpdate({ force = false } = {}) {
    if (this.busy && this.currentInstall) return this.currentInstall;
    const downloadPath = path.join(this.store.runtimeDir, `umod-download-${Date.now()}-${process.pid}.zip`);
    const operation = (async () => {
      this.busy = true;
      try {
        await ensureDir(this.store.rustDir);
        const release = await this.latestRelease();
        const marker = path.join(this.store.rustDir, 'RustDedicated_Data', 'Managed', 'Oxide.Core.dll');
        const previous = await this.readMarker();
        if (!force && previous?.version === release.version && await this.isInstalled()) {
          return { ...release, skipped: true };
        }

        const candidates = Array.isArray(release.assetUrls) ? release.assetUrls : [release.assetUrl];
        const failures = [];
        for (const assetUrl of candidates) {
          try {
            this.emit({ type: 'progress', stage: 'uMod', message: `Downloading the canonical Windows uMod package (${release.version})…` });
            const downloadInfo = await this.downloadArchive(assetUrl, downloadPath);
            const zip = await fsp.readFile(downloadPath);
            const candidateRelease = { ...release, assetUrl: downloadInfo.finalUrl };
            this.emit({ type: 'progress', stage: 'uMod', message: `Validating Windows Oxide package from ${new URL(assetUrl).hostname}…` });
            this.emit({ type: 'log', source: 'uMod', line: `Downloaded Windows Oxide candidate via ${downloadInfo.method}: ${downloadInfo.finalUrl} (${downloadInfo.bytes} bytes).` });
            const matched = await this.extractAndInstall(zip, candidateRelease, marker);
            if (matched) return candidateRelease;
          } catch (error) {
            failures.push(`${assetUrl}: ${error.message}`);
          }
        }
        throw new Error(`Unable to install a valid Windows uMod package. ${failures.join(' | ')}`);
      } finally {
        await fsp.unlink(downloadPath).catch(() => {});
        this.busy = false;
        this.currentInstall = null;
      }
    })();
    this.currentInstall = operation;
    return operation;
  }

  async readMarker() {
    try { return JSON.parse(await fsp.readFile(this.markerPath(), 'utf8')); }
    catch { return null; }
  }

  async searchPlugins(query = '', page = 1) {
    const params = new URLSearchParams({
      query: String(query),
      page: String(page),
      sort: 'latest_release_at',
      sortdir: 'desc',
      filter: ''
    });
    params.append('categories[]', 'rust');
    return jsonFetch(`${UMOD_SEARCH}?${params.toString()}`);
  }

  async pluginInfo(slug) {
    return jsonFetch(UMOD_INFO(slug));
  }

  pluginDir(server) {
    return path.join(this.store.serverIdentityPath(server), 'oxide', 'plugins');
  }

  lockPath(server) { return this.store.serverLockPath(server); }

  pluginFilename(info, slug) {
    const direct = info.latest_release_download_url || info.download_url;
    try {
      const url = new URL(direct);
      const name = path.basename(url.pathname);
      if (/\.cs$/i.test(name) && /^[a-zA-Z0-9_.-]+$/.test(name)) return name;
    } catch {}

    const fallback = String(info.name || slug).trim().replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!fallback) throw new Error('The plugin did not provide a valid source filename.');
    return fallback.toLowerCase().endsWith('.cs') ? fallback : `${fallback}.cs`;
  }

  async readLock(server) {
    try {
      const lock = JSON.parse(await fsp.readFile(this.lockPath(server), 'utf8'));
      if (!lock || typeof lock !== 'object') throw new Error('invalid lock');
      return { version: Number(lock.version) || 1, plugins: lock.plugins && typeof lock.plugins === 'object' ? lock.plugins : {} };
    } catch {
      return { version: 1, plugins: {} };
    }
  }

  async writeLock(server, lock) {
    await ensureDir(path.dirname(this.lockPath(server)));
    await atomicWrite(this.lockPath(server), JSON.stringify(lock, null, 2));
  }

  async replacePluginFile(temp, target, previousData = null) {
    try {
      await fsp.rename(temp, target);
      return;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
    }
    try {
      await fsp.copyFile(temp, target);
      await fsp.unlink(temp).catch(() => {});
    } catch (error) {
      if (previousData) await fsp.writeFile(target, previousData).catch(() => {});
      throw error;
    }
  }

  async installedMap(server) {
    const files = await this.listInstalledPlugins(server);
    return { files, lock: await this.readLock(server) };
  }

  async resolveDependency(dependency) {
    const direct = String(dependency).trim();
    const directLower = direct.toLowerCase();
    const candidates = [direct, directLower.replace(/\s+/g, '-')];
    for (const candidate of candidates) {
      try { return await this.pluginInfo(candidate); } catch {}
    }
    const data = await this.searchPlugins(direct, 1);
    const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.results) ? data.results : []);
    const exact = rows.find(row => String(row.slug || '').toLowerCase() === directLower)
      || rows.find(row => String(row.title || row.name).toLowerCase() === directLower)
      || rows[0];
    if (!exact?.slug) throw new Error(`Required dependency “${direct}” could not be resolved on uMod.`);
    return this.pluginInfo(exact.slug);
  }

  async installPlugin(server, slug) {
    const normalized = String(slug).trim();
    if (!normalized) throw new Error('A plugin slug is required.');
    const key = `${server.id}:${normalized.toLowerCase()}`;
    if (this.pluginJobs.has(key)) return this.pluginJobs.get(key);

    const job = this.enqueueServer(server.id, () => this.queue.push(() => this._installPlugin(server, normalized, new Set())))
      .finally(() => this.pluginJobs.delete(key));
    this.pluginJobs.set(key, job);
    return job;
  }

  async _installPlugin(server, slug, stack) {
    const normalized = String(slug).toLowerCase();
    if (stack.has(normalized)) {
      throw new Error(`Plugin dependency cycle detected: ${[...stack, normalized].join(' → ')}`);
    }
    stack.add(normalized);

    try {
      if (server.uMod === false) throw new Error(`uMod is disabled for ${server.name}. Enable uMod in the server configuration before installing plugins.`);
      const runtime = path.join(this.store.rustDir, 'RustDedicated.exe');
      if (!(await exists(runtime))) throw new Error('Rust runtime is not installed yet. Run One-Click Setup first.');
      const marker = path.join(this.store.rustDir, 'RustDedicated_Data', 'Managed', 'Oxide.Core.dll');
      if (!(await exists(marker))) throw new Error('uMod is not installed for this Rust runtime. Synchronize uMod first.');

      const info = await this.pluginInfo(slug);
      const downloadUrl = info.latest_release_download_url || info.download_url;
      if (!downloadUrl) throw new Error(`Plugin ${info.title || info.name || slug} has no direct download URL.`);
      const filename = this.pluginFilename(info, slug);
      const targetDir = this.pluginDir(server);
      await ensureDir(targetDir);
      const target = path.join(targetDir, filename);
      const existing = await exists(target);

      if (existing && info.latest_release_version_checksum) {
        const currentChecksum = sha1(await fsp.readFile(target)).toLowerCase();
        if (currentChecksum === String(info.latest_release_version_checksum).toLowerCase()) {
          const lock = await this.readLock(server);
          stack.delete(normalized);
          return {
            ...info,
            filename,
            installed: true,
            alreadyInstalled: true,
            updated: false,
            dependencies: lock.plugins[filename]?.required || []
          };
        }
      }

      const response = await fetchWithTimeout(downloadUrl, { headers: { 'User-Agent': USER_AGENT } });
      if (!response.ok) throw new Error(`Plugin download failed (${response.status}).`);
      const data = Buffer.from(await response.arrayBuffer());
      if (info.latest_release_version_checksum) {
        const expected = String(info.latest_release_version_checksum).toLowerCase();
        const actual = sha1(data).toLowerCase();
        if (expected.length >= 40 && actual !== expected) {
          throw new Error(`Plugin checksum verification failed for ${filename}.`);
        }
      }

      const dependencies = parseDependencies(data.toString('utf8'));
      if (this.store.state.settings.autoPluginDependencies && dependencies.required.length) {
        const installed = await this.installedMap(server);
        const lockEntries = Object.values(installed.lock.plugins || {});
        for (const dependency of dependencies.required) {
          const lower = dependency.toLowerCase().replace(/\.cs$/i, '');
          const present = installed.files.some(item =>
            item.name.toLowerCase() === lower || item.filename.toLowerCase() === `${lower}.cs`
          ) || lockEntries.some(item => String(item.slug || '').toLowerCase() === lower || String(item.name || '').toLowerCase() === lower);
          if (present) continue;
          const dependencyInfo = await this.resolveDependency(dependency);
          await this._installPlugin(server, dependencyInfo.slug, stack);
        }
      }

      const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
      const previousData = existing ? await fsp.readFile(target) : null;
      await fsp.writeFile(temp, data);
      try {
        await this.replacePluginFile(temp, target, previousData);
      } catch (error) {
        await fsp.unlink(temp).catch(() => {});
        throw error;
      }

      const lock = await this.readLock(server);
      const previousLockEntry = lock.plugins[filename];
      lock.plugins[filename] = {
        filename,
        slug: info.slug || slug,
        name: info.title || info.name || slug,
        version: info.latest_release_version || info.version || null,
        checksum: info.latest_release_version_checksum || sha1(data),
        required: dependencies.required,
        optional: dependencies.optional,
        updatedAt: Date.now()
      };
      try {
        await this.writeLock(server, lock);
      } catch (error) {
        if (previousData) await fsp.writeFile(target, previousData).catch(() => {});
        else await fsp.unlink(target).catch(() => {});
        if (previousLockEntry) lock.plugins[filename] = previousLockEntry;
        else delete lock.plugins[filename];
        throw new Error(`Plugin file was restored because its Forge lock record could not be committed: ${error.message}`);
      }
      this.emit({ type: 'progress', stage: 'Plugin', message: `${info.title || info.name || slug} installed on ${server.name}` });
      return {
        ...info,
        filename,
        installed: true,
        updated: true,
        dependencies
      };
    } finally {
      stack.delete(normalized);
    }
  }

  async updatePlugins(server) {
    return this.enqueueServer(server.id, () => this.queue.push(async () => {
      const lock = await this.readLock(server);
      const entries = Object.values(lock.plugins || {});
      const results = [];
      for (const entry of entries) {
        try {
          const info = await this.pluginInfo(entry.slug);
          const file = path.join(this.pluginDir(server), entry.filename || `${entry.slug}.cs`);
          const checksum = info.latest_release_version_checksum
            ? String(info.latest_release_version_checksum).toLowerCase()
            : null;
          const current = await exists(file) ? sha1(await fsp.readFile(file)).toLowerCase() : null;
          if (checksum && current === checksum) {
            results.push({ slug: entry.slug, updated: false });
            continue;
          }
          await this._installPlugin(server, entry.slug, new Set());
          results.push({ slug: entry.slug, updated: true });
        } catch (error) {
          results.push({ slug: entry.slug, updated: false, error: error.message });
        }
      }
      return results;
    }));
  }

  async removePlugin(server, filename) {
    return this.enqueueServer(server.id, async () => {
      const safe = path.basename(String(filename || ''));
      if (!safe.toLowerCase().endsWith('.cs') || safe !== String(filename)) throw new Error('Invalid plugin filename.');
      const lock = await this.readLock(server);
      const targetName = path.basename(safe, '.cs').toLowerCase();
      const targetEntry = lock.plugins[safe] || Object.values(lock.plugins || {}).find(entry => String(entry.filename || '').toLowerCase() === safe.toLowerCase());
      const targetKeys = new Set([
        targetName,
        String(targetEntry?.slug || '').toLowerCase().replace(/\.cs$/i, ''),
        String(targetEntry?.name || '').toLowerCase().replace(/\.cs$/i, '')
      ].filter(Boolean));
      const dependents = Object.values(lock.plugins || {}).filter(entry =>
        (entry.required || []).some(dep => targetKeys.has(String(dep).toLowerCase().replace(/\.cs$/i, '')))
      );
      if (dependents.length) {
        throw new Error(`Cannot remove ${safe}: required by ${dependents.map(entry => entry.name).join(', ')}.`);
      }
      const target = path.join(this.pluginDir(server), safe);
      if (!(await exists(target))) throw new Error(`Plugin ${safe} is not installed on ${server.name}.`);
      await fsp.unlink(target);
      delete lock.plugins[safe];
      await this.writeLock(server, lock);
      return { removed: safe };
    });
  }

  async listInstalledPlugins(server) {
    const dir = this.pluginDir(server);
    if (!(await exists(dir))) return [];
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const lock = await this.readLock(server);
    return entries
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.cs'))
      .map(entry => ({
        name: entry.name.replace(/\.cs$/i, ''),
        filename: entry.name,
        locked: Boolean(lock.plugins[entry.name]),
        version: lock.plugins[entry.name]?.version || null,
        dependencies: lock.plugins[entry.name]?.required || []
      }));
  }
}

module.exports = { UmodProvider, parseDependencies, TaskQueue };
