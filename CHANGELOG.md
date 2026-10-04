
## 1.0.0 — uMod Reliability Hardening

### Final uMod synchronization correction

- Fixed the Windows uMod `installOrUpdate()` transaction returning the async function instead of its executing promise. The previous form allowed callers to continue immediately and run final integrity checks before any Oxide files were installed.
- Added an integration audit that executes the real `installOrUpdate()` path and verifies all Windows Oxide assemblies in the live target tree before success is returned.

- Coalesced overlapping shared runtime preparation requests so bootstrap/start/plugin-repair cannot prepare the same Rust runtime twice concurrently.
- Added an exact compatibility fallback for Rust 2634.289.1 → Oxide.Rust 2.0.7801 while keeping the live release API authoritative when reachable.
- Added Windows `curl.exe` download fallback for GitHub/uMod redirected release assets.
- Changed uMod installation to copy the complete Windows Oxide package root, including the `oxide` runtime tree, instead of copying only `RustDedicated_Data`.
- Added post-copy file-size and target-path verification with per-DLL telemetry.
- Kept the public application version at 1.0.0.
# Changelog
- Serialized the complete Rust runtime mutation transaction so concurrent starts, uMod sync, and SteamCMD update/validate operations cannot overwrite each other.

## v1.0.0 — Runtime/uMod corrective hardening

- Hardened Windows Oxide runtime installation: staged package validation now requires the patched `Assembly-CSharp.dll` plus `Oxide.Common.dll`, `Oxide.Core.dll`, `Oxide.CSharp.dll`, `Oxide.References.dll`, `Oxide.Rust.dll`, and `Oxide.Unity.dll` before uMod can be marked ready.
- Prefer the official uMod Rust Windows download endpoint, with deterministic GitHub release fallbacks.
- Added archive layout discovery, extraction fallback through Windows `Expand-Archive`, final-path verification, and detailed uMod installation telemetry.
- Server startup now refuses to claim uMod readiness when the verified core Oxide assemblies are incomplete.
- Duplicate concurrent Start requests now share one lifecycle operation instead of racing runtime preparation.

1.0.0 — Runtime / uMod / console final hardening

- uMod installation now prefers the official stable Rust download endpoint and falls back through Windows-compatible Oxide.Rust release assets.
- Hardened uMod archive extraction to handle nested package roots and verify `RustDedicated_Data\Managed\Oxide.Core.dll` after copying the full package into the Rust runtime.
- Added start-time network preflight: Game and Query port conflicts now fail early with an actionable message; a busy local RCON TCP port is automatically repaired to the next free private port before Rust starts.
- Rust startup now recognizes the completed Bootstrap milestone as a valid ready path, while preserving an explicit `READY · RCON OFFLINE` warning when an RCON bind conflict is observed.
- Live console commands now prefer WebRCON when connected and always echo the command/result into the main console; stdin remains the boot-time fallback.
- Runtime Diagnostics now surfaces persisted RCON startup warnings.
- Public release remains **1.0.0**.


## 1.0.0 — Runtime/Plugin Stability

- Treats `id`/`serverId` carried by the server-save IPC envelope as transport metadata instead of rejecting valid configuration saves.
- Plugin installation now prepares the shared uMod runtime automatically when uMod is enabled but not yet synchronized, using the existing safe runtime-maintenance path.
- Keeps the public release pinned to `1.0.0`.


## Final 1.0.0 — Public server / Playit finalization

- Added first-class public server identity fields: hostname, description, website, header image, logo image and validated browser tags.
- Added per-server network policy with Direct/LAN and Playit Tunnel modes.
- Added secure Playit binding that keeps Rust game/query endpoints on `127.0.0.1` while the managed tunnel agent is active.
- Added optional query exposure with explicit opt-in and public-address metadata.
- Added a shared Playit agent manager with hidden process lifecycle, claim-state handling and SHA-256 verified official Windows x64 installation.
- Kept RCON private; Forge never maps the RCON TCP port through Playit.
- Extended Runtime Health to diagnose Playit state, secure binding and public address policy.
- Fixed Playit controls inside the server configuration modal so they use the same dedicated modal event path as every other secondary action.
- Public release remains **1.0.0**.

## 1.0.0 — RCON startup hardening

- RCON startup credentials are now guaranteed safe and explicitly passed to RustDedicated.

# Rust Forge 1.0.0

### Final 1.0.0 audit correction
- Fixed the Windows smoke-test fixture so the simulated Rust Dedicated runtime contains `Facepunch.Steamworks.Win64.dll`, matching the real Windows runtime contract.
- Kept the public release at `1.0.0`; this is an internal final-audit correction, not a version bump.


## Final hardening included in the 1.0.0 release

- Runtime setup no longer hides behind an opaque `RUNTIME CHECK` state.
- Rust Dedicated installation now reports explicit runtime phases: SteamCMD launch, Rust runtime ready, uMod install/check, Windows runtime validation, and final runtime ready.
- Runtime operations have safety timeouts so a stalled network/process operation cannot leave the UI waiting forever.
- SteamCMD now emits explicit lifecycle logs with its PID and exit code.
- Windows Steamworks validation runs before RustDedicated launch and can trigger an automatic Rust runtime repair when the Win64 assembly is missing.
- uMod installation/update is validated before launch and distinguishes missing uMod from an ordinary update check.
- Startup progress remains within version 1.0.0; no public version bump is required for these hardening fixes.


## Final audit pass — still 1.0.0

- Fixed destructive-server modal ownership so Remove, Cancel, Close and backdrop interactions are handled by a dedicated modal host instead of competing document listeners.
- Removed invalid nested `<label>` markup from the destructive-server dialog.
- Added durable deletion metadata and startup recovery for staged server data cleanup.
- Made bootstrap stop active servers before mutating the shared Rust runtime, then restore them safely.
- Added safe existing-file replacement for plugin updates, including lock-file rollback when persistence fails.
- Hardened dependency matching for plugin names, slugs and filenames.
- Added a timeout to Windows telemetry sampling and explicit RCON socket termination on connection timeout.
- Coalesced progress feedback into one in-app notification and changed live console updates to incremental DOM insertion.
- Verified the complete public source remains frozen at **1.0.0**.


### 1.0.0 — Runtime Diagnostics finalization
- Added a dedicated Runtime Diagnostics / Health Check surface.
- Added shared-runtime validation for RustDedicated, SteamCMD and Windows Steamworks assemblies.
- Added per-server checks for identity/config, PID/process identity, game/query/RCON sockets, uMod, RCON credentials, startup readiness and recent log signatures.
- Added explicit EAC/Steamworks signal interpretation so client integrity kicks are warnings while server-side initialization failures are escalated.
- Added latest telemetry samples to diagnostics without coupling the UI to the telemetry polling loop.
- Added deterministic audit coverage for the health matrix and diagnostic escalation paths.
- Public release remains 1.0.0.


### v1.0.0 runtime follow-up
- Hardened Windows uMod synchronization around the official Oxide.Rust Windows release asset and strict post-install runtime verification.
- Startup readiness matching now strips ANSI control sequences before interpreting Rust milestones.


## 1.0.0 final runtime hardening

- uMod Windows installation now uses the canonical `Oxide.Rust.zip` release asset and no longer depends on GitHub API availability for installation.
- uMod verification now reports the exact missing Oxide assemblies.
- Rust startup readiness is monotonic: once `READY` is reached, later asset-warmup/navmesh chatter cannot downgrade the server back to a loading phase.
- Plugin installation errors now include the missing uMod runtime assemblies when synchronization is incomplete.

## GitHub / Product Delivery

- Added an in-app **About & Updates** release surface.
- Automatic public GitHub release checks on launch and periodically while the app is running.
- Latest Setup and Portable x64 release downloads with SHA-256 verification when GitHub provides a digest.
- Added GitHub source, releases and project website shortcuts.
- Added a free static GitHub Pages website in `site/`.
- Added GitHub Actions workflows for Windows release publishing and GitHub Pages deployment.
- Added repository metadata auto-configuration for CI so the packaged update feed points at the actual public repository.
