const fs = require('fs');
const path = require('path');

const repo = String(process.env.GITHUB_REPOSITORY || process.argv[2] || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '');
if (!repo || !repo.includes('/')) {
  if (process.argv.includes('--site-only')) process.exit(0);
  console.error('Usage: GITHUB_REPOSITORY=owner/repo npm run configure:repo');
  process.exit(1);
}
const [owner, name] = repo.split('/');
const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.repository = { type: 'git', url: `https://github.com/${owner}/${name}.git` };
pkg.build = pkg.build || {};
pkg.build.publish = [{ provider: 'github', releaseType: 'release' }];
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const configPath = path.join(root, 'site', 'config.js');
const pages = `https://${owner}.github.io/${name}/`;
const source = `https://github.com/${owner}/${name}`;
fs.writeFileSync(configPath, `window.RUST_FORGE_SITE = ${JSON.stringify({ repository: repo, owner, name, source, releases: `${source}/releases`, latest: `${source}/releases/latest`, pages })};\n`);
console.log(`Configured Rust Forge for ${repo}.`);
