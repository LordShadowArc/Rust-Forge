const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

function parseRepoSlug(pkg) {
  const url = String(pkg?.repository?.url || '').replace(/^git\+/, '').replace(/\.git$/, '');
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  if (m && m[1] !== 'OWNER' && m[2] !== 'REPO') return `${m[1]}/${m[2]}`;
  return String(process.env.RUST_FORGE_GITHUB_REPO || '').trim() || null;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Rust-Forge/1.0.0', 'Accept': 'application/vnd.github+json' },
      timeout: 15000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return requestJson(res.headers.location).then(resolve, reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub API returned HTTP ${res.statusCode}.`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('GitHub returned invalid release metadata.')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub release request timed out.')));
    req.on('error', reject);
  });
}

function compareVersions(a, b) {
  const norm = value => String(value || '0').replace(/^v/i, '').split('-')[0].split('.').map(x => Number.parseInt(x, 10) || 0);
  const aa = norm(a), bb = norm(b);
  for (let i = 0; i < 3; i += 1) { if (aa[i] !== bb[i]) return aa[i] - bb[i]; }
  return 0;
}

function pickAsset(release, kind) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const suffix = kind === 'setup' ? /-Setup-x64\.exe$/i : /-portable-x64\.exe$/i;
  return assets.find(a => suffix.test(String(a.name || '')));
}

function download(url, destination, expectedDigest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    const hash = crypto.createHash('sha256');
    let received = 0;
    let total = 0;
    let settled = false;

    const fail = error => {
      if (settled) return;
      settled = true;
      file.close(() => {});
      fs.rm(destination, { force: true }, () => reject(error));
    };

    const doRequest = target => {
      const req = https.get(target, {
        headers: { 'User-Agent': 'Rust-Forge/1.0.0', 'Accept': 'application/octet-stream' },
        timeout: 30000
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return doRequest(res.headers.location);
        }
        if (res.statusCode !== 200) return fail(new Error(`Download returned HTTP ${res.statusCode}.`));
        total = Number(res.headers['content-length'] || 0);
        res.on('data', chunk => {
          received += chunk.length;
          hash.update(chunk);
          onProgress?.(total ? received / total : 0, received, total);
        });
        res.pipe(file);
        res.on('error', fail);
      });
      req.on('timeout', () => req.destroy(new Error('GitHub download timed out.')));
      req.on('error', fail);
    };

    file.on('error', fail);
    file.on('finish', () => {
      if (settled) return;
      file.close(async () => {
        try {
          const digest = hash.digest('hex');
          if (expectedDigest && expectedDigest.startsWith('sha256:')) {
            const expected = expectedDigest.slice('sha256:'.length).toLowerCase();
            if (digest.toLowerCase() !== expected) return fail(new Error('Downloaded release checksum does not match GitHub metadata.'));
          }
          settled = true;
          resolve({ destination, sha256: digest, bytes: received });
        } catch (error) { fail(error); }
      });
    });

    doRequest(url);
  });
}

class UpdateManager {
  constructor({ emit } = {}) {
    this.emit = emit;
    this.last = null;
    this.busy = false;
  }

  repository() {
    const pkg = require('../../package.json');
    const slug = parseRepoSlug(pkg);
    if (!slug) throw new Error('GitHub repository is not configured yet. Set repository.url in package.json or RUST_FORGE_GITHUB_REPO.');
    return slug;
  }

  urls() {
    const slug = this.repository();
    const [owner, repo] = slug.split('/');
    return {
      slug,
      repo: `https://github.com/${owner}/${repo}`,
      releases: `https://github.com/${owner}/${repo}/releases`,
      latest: `https://github.com/${owner}/${repo}/releases/latest`,
      source: `https://github.com/${owner}/${repo}`,
      pages: `https://${owner}.github.io/${repo}/`
    };
  }

  async check() {
    if (this.busy) return this.last;
    const pkg = require('../../package.json');
    this.busy = true;
    this.emit?.({ type: 'updates:state', state: { status: 'checking', currentVersion: app.getVersion() } });
    try {
      const urls = this.urls();
      const release = await requestJson(`https://api.github.com/repos/${urls.slug}/releases/latest`);
      if (release.draft || release.prerelease) throw new Error('The latest GitHub release is not a stable public release.');
      const latestVersion = String(release.tag_name || release.name || '').replace(/^v/i, '');
      if (!/^\d+\.\d+\.\d+/.test(latestVersion)) throw new Error('Latest GitHub release has no valid semantic version.');
      const setup = pickAsset(release, 'setup');
      const portable = pickAsset(release, 'portable');
      this.last = {
        status: 'ready', currentVersion: app.getVersion(), latestVersion,
        updateAvailable: compareVersions(latestVersion, app.getVersion()) > 0,
        releaseName: release.name || `Rust Forge ${latestVersion}`,
        releaseNotes: String(release.body || '').slice(0, 4000),
        publishedAt: release.published_at || null,
        urls,
        assets: {
          setup: setup ? { name: setup.name, url: setup.browser_download_url, size: setup.size, digest: setup.digest || null } : null,
          portable: portable ? { name: portable.name, url: portable.browser_download_url, size: portable.size, digest: portable.digest || null } : null
        }
      };
      this.emit?.({ type: 'updates:state', state: this.last });
      return this.last;
    } catch (error) {
      this.last = { status: 'error', currentVersion: app.getVersion(), error: error.message, urls: (() => { try { return this.urls(); } catch { return null; } })() };
      this.emit?.({ type: 'updates:state', state: this.last });
      throw error;
    } finally { this.busy = false; }
  }

  async download(kind) {
    if (!this.last || !this.last.assets?.[kind]) await this.check();
    const asset = this.last?.assets?.[kind];
    if (!asset) throw new Error(`No ${kind} x64 release asset was found on the latest GitHub release.`);
    const downloads = app.getPath('downloads');
    fs.mkdirSync(downloads, { recursive: true });
    const destination = path.join(downloads, asset.name);
    this.emit?.({ type: 'updates:download', state: { kind, phase: 'starting', name: asset.name, progress: 0, destination } });
    const result = await download(asset.url, destination, asset.digest, (progress, received, total) => {
      this.emit?.({ type: 'updates:download', state: { kind, phase: 'downloading', name: asset.name, progress, received, total, destination } });
    });
    this.emit?.({ type: 'updates:download', state: { kind, phase: 'complete', name: asset.name, progress: 1, ...result } });
    return result;
  }
}

module.exports = { UpdateManager, compareVersions };
