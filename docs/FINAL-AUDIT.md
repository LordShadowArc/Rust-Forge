# Rust Forge 1.0.0 Final Audit Scope

This document records the static and integration-oriented audit used before the final 1.0.0 artifact was produced.

## Covered layers

1. Electron main-process lifecycle and single-instance behavior.
2. Preload IPC exposure and renderer event boundaries.
3. Modal lifecycle, focus containment, hit-testing and background inert state.
4. Server profile persistence and transactional rollback.
5. Server start/stop/restart/remove/wipe lifecycle serialization.
6. SteamCMD installation/update retry behavior and bounded subprocesses.
7. Windows Rust runtime validation including Steamworks assembly hygiene.
8. uMod installation, dependency resolution, safe replacement and rollback.
9. WebRCON lifecycle and credential hardening.
10. Scheduler, backup/wipe and telemetry isolation.
11. Runtime Health diagnostics and EAC/Steamworks signal classification.
12. Public server branding and generated `server.cfg` boundaries.
13. Playit process lifecycle, secure loopback binding and integrity-pinned agent installation.
14. Packaging, public-version freeze and ZIP integrity.

## Public version policy

All fixes remain inside the public **1.0.0** build until the project owner explicitly declares the project finished.

## Final verification notes

The repository's smoke audit is intentionally deterministic and does not require a live Rust installation, Steam account, Playit claim or Windows desktop session. Live Rust/SteamCMD/uMod behavior remains a final native-Windows environment test rather than something the Linux build environment can honestly claim to have executed.


## Final Runtime Corrections (v1.0.0)

### uMod Windows package source
The installer now uses the canonical `Oxide.Rust.zip` latest-release asset for Windows, with the official uMod download route as fallback. GitHub API availability is metadata-only and can no longer block an otherwise valid uMod download.

### uMod integrity
The runtime verifier checks the full core Oxide assembly set (`Oxide.Core.dll`, `Oxide.Common.dll`, `Oxide.CSharp.dll`, `Oxide.References.dll`, `Oxide.Rust.dll`, `Oxide.Unity.dll`) and reports the exact missing file names to Runtime Health/plugin-install errors.

### Rust readiness
Once a Rust instance reaches `READY`, later post-startup asset-warmup, bundle, navmesh or save chatter cannot downgrade its readiness phase back to a loading state. This prevents a healthy, joinable server from being displayed as `LOADING ASSETS`.

## Latest v1.0.0 runtime hardening pass

This pass specifically verifies the Rust/uMod startup order and readiness state. Rust/SteamCMD validation is completed before any uMod mutation; the exact Windows Oxide release asset is then installed as the final runtime mutation. The installation copies the package's `RustDedicated_Data` tree and verifies the complete core Oxide DLL set before reporting success.

The audit also verifies monotonic startup progress and that Runtime Health trusts a persisted READY state or an observed `Server startup complete` line in the selected server log, preventing a healthy server from being reported as stuck in `LOADING ASSETS`.

Forensic uMod extraction audit: two consecutive runs passed.
Source syntax audit: all 20 JavaScript source/test files passed `node --check`.
Package version: `1.0.0`.
