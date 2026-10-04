# Rust Forge — GitHub Publish Guide

Rust Forge is designed to stay completely free to publish and distribute using GitHub Releases + GitHub Pages.

## One-time repository setup

Create a **public** repository named `Rust-Forge` (or any name you prefer), then put this project at its root.

The included release workflow reads `${GITHUB_REPOSITORY}` automatically, so you do not need to hardcode your GitHub username in the application source before publishing.

## First v1.0.0 release

The project is currently version `1.0.0`.

```powershell
npm ci
npm run check
git add .
git commit -m "Rust Forge v1.0.0"
git tag v1.0.0
git push origin main --tags
```

GitHub Actions builds and publishes:

- `Rust-Forge-1.0.0-Setup-x64.exe`
- `Rust-Forge-1.0.0-portable-x64.exe`
- electron-builder update metadata (`latest.yml`, blockmap)

The NSIS target is the auto-updatable Windows target supported by `electron-updater`; Portable is distributed as a standalone download. citeturn282750search0turn282750search1

## Website

The `site/` folder is a static GitHub Pages site. The workflow configures the repository links automatically and deploys the site on pushes to `main`. GitHub's current Pages workflow uses `actions/checkout`, `actions/configure-pages`, `actions/upload-pages-artifact`, and `actions/deploy-pages`. citeturn995604search5turn995604search6

## Future releases

When you are ready for a new release, bump `package.json` with the next semver version, tag it, and push the tag:

```powershell
npm version patch --no-git-tag-version
git add package.json
git commit -m "Release <next-version>"
git tag v<next-version>
git push origin main --tags
```

The application checks GitHub's public latest-release endpoint and the About & Updates screen can download the latest Setup or Portable EXE directly into the user's Downloads folder. GitHub also provides stable `/releases/latest` links for the latest release page. citeturn282750search6

## Free model

Rust Forge itself is MIT-licensed and does not require a paid subscription. GitHub hosts the source, releases and Pages site. Optional third-party services such as Playit are independent services with their own terms and limits.
