# Rust Forge 1.0.0

Rust Forge is an autonomous Windows Rust Dedicated Server manager designed around one shared Rust runtime and isolated multi-server identities.

## What 1.0.0 delivers

Rust Forge is intentionally split into independent runtime services: server lifecycle, SteamCMD, uMod/plugin management, WebRCON, process telemetry, backup/wipe automation, persistence and UI.

### Server fabric

- Unlimited server profiles on one shared Rust installation.
- Per-server `server.identity`, ports, config, save files, logs and uMod tree.
- Explicit server selection in Servers, Plugins and Control Center.
- Safe profile removal with optional background data deletion.
- PID-scoped process control; no global Rust process kill.
- Single-instance Forge application with Windows tray management.
- Automatic crash recovery with configurable restart behavior.

### Startup/runtime

- One-click SteamCMD → Rust Dedicated → uMod bootstrap.
- SteamCMD exit-code 7/8 refresh/retry flow.
- SteamCMD process safety timeout so a stuck install cannot hold the application forever.
- Real startup progress driven by Rust logfile output.
- Log files are unique per launch and streamed into the UI.
- Rust runtime and uMod updates safely stop and restart affected instances.

### RCON credential hardening

Rust Forge 1.0.0 never starts a server with an RCON password shorter than 8 characters. Existing weak credentials are automatically replaced with a generated credential before the server config is written.

### Windows Steamworks runtime hygiene

The Windows runtime doctor removes stale Posix/Win32 Steamworks assemblies and requires the Windows `Facepunch.Steamworks.Win64.dll`. The smoke suite explicitly exercises that Windows validation branch with a faithful Rust runtime fixture. The uMod installer also refuses Linux/macOS archives on Windows.

### WebRCON

Rust Forge uses Rust's WebSocket RCON mode (`rcon.web 1`) and exposes a built-in dashboard for connection status, commands and incoming console/chat messages. Rust documents WebRCON as the recommended modern RCON mode. The Rust server can also expose `serverinfo`, player information and live console output through RCON.


### RCON startup stability

During normal Rust boot, WebRCON may not be listening yet. Rust documents `rcon.web 1` as the recommended WebRCON mode and notes that the server is only fully ready after the `Server startup complete` milestone. Rust Forge therefore treats early `ECONNREFUSED` responses as transient background connection attempts instead of surfacing them as error notifications. Explicit manual RCON connection attempts still return a user-visible error when the endpoint cannot be reached.

### Runtime Diagnostics / Health Check

Rust Forge 1.0.0 includes a dedicated Health surface that can inspect either the shared runtime or a selected server. It checks RustDedicated, SteamCMD, Windows Steamworks assembly hygiene, server identity/config boundaries, process identity, game/query/RCON sockets, uMod presence, RCON credential strength, startup readiness, recent Rust log failures, Steamworks/EAC server signals and the latest process telemetry sample. Game/query are treated as UDP sockets and RCON as TCP, matching Rust's documented server architecture. A client integrity kick is deliberately surfaced as a warning because it is evidence of a client-side EAC rejection, not automatic proof that the server runtime is broken.

The Health surface is intentionally diagnostic: it does not modify the runtime merely by inspecting it, and it never requires a terminal.


### Public Server Identity & Playit

Server profiles now include first-class public metadata controls for `server.hostname`, `server.description`, `server.url`, `server.headerimage`, `server.logoimage` and validated `server.tags`. These are authored from the Forge UI and persisted into the generated `server.cfg`, so server branding does not require hand-editing command lines.

Playit is integrated as a shared, hidden Windows background agent. When a profile uses **Playit Tunnel** mode, Forge can keep the Rust game server on `127.0.0.1` and manage the Playit agent lifecycle. The agent binary is fetched from the official Playit release URL and verified against a pinned SHA-256 before installation. Forge deliberately keeps RCON private and does not attempt to synthesize tunnel definitions that are not part of Playit’s stable command contract; the user creates the UDP tunnel in the Playit dashboard and points it to the server's local game port. See [docs/PUBLIC-SERVER.md](docs/PUBLIC-SERVER.md).

### Telemetry

Per-server telemetry tracks CPU percentage, working-set memory, PID and uptime without requiring users to open a terminal.

### Performance profiles

Each server can select Eco, Balanced, Performance or Maximum. Forge applies safe Windows process priority classes and deliberately avoids realtime scheduling.

### Backups and wipes

Backups are ZIP archives stored outside the application package. Scheduled backups support retention and a safe quiesce mode.

The wipe engine follows Rust's documented server identity layout: `.sav` files contain world/entity state and `.map` files contain map data; optional blueprint wipes remove `player.blueprints`, while Rust+ `companion.id` is preserved.

The built-in scheduler supports weekly, biweekly and monthly wipe modes with an optional pre-wipe backup. Rust itself also exposes official wipe-timer concepts for weekly, biweekly and monthly schedules.

### Plugin Forge

- Explicit target-server selection.
- Duplicate install suppression.
- uMod checksum verification when published.
- Server-local plugin inventory.
- Forge lock file with version/checksum/dependency metadata.
- Required dependency resolution using uMod dependency annotations.
- Dependency-aware plugin removal.
- Batch installed-plugin update scanning.

uMod documents required dependencies, optional dependencies and explicit dependency references; Forge parses the supported required/optional forms and maintains its own local lock metadata for deterministic server management.

## Clean-PC installation

The recommended distribution is the Windows Setup EXE. It packages the Electron application and its production Node dependencies; first run downloads SteamCMD, Rust Dedicated and uMod into the user's Rust Forge data directory. The clean machine therefore needs only the Setup EXE and an internet connection.

## Development

```powershell
npm install
npm run check
npm start
```

## Windows builds

```powershell
npm run dist:portable
npm run dist:setup
```

Build output is written to `release/`.

## GitHub Releases

Set the real repository owner/name in `package.json` or let the included GitHub Actions workflow align it from `GITHUB_REPOSITORY`.

Push a release tag such as `v1.0.0`. The workflow builds and publishes both:

- `Rust-Forge-1.0.0-Setup-x64.exe`
- `Rust-Forge-1.0.0-portable-x64.exe`

No terminal or secondary management UI is required at runtime.

## Final runtime-hardening notes

The public release remains **1.0.0** while the project is still under finalization. Internal fixes do not change the public version.


The 1.0.0 build keeps a server in a visible `STARTING` state from process spawn until a Rust readiness signal is observed. Startup milestones are also written into the Forge console so world generation and other expensive boot phases are visible even when Rust's own output is dominated by low-level Unity allocator messages.

Remove and wipe actions are intentionally non-blocking from the UI. The dialog is owned by a dedicated modal host, closes immediately when an operation is accepted, and never waits on server shutdown or disk cleanup. Forge performs safe process shutdown and staged cleanup in the background and reports completion or failure through in-app feedback.

Scheduler edits and performance-profile edits are state-safe and do not unnecessarily restart a running server. Live telemetry updates patch only their metric cells instead of rebuilding the entire page. Console output is also appended incrementally rather than rebuilding thousands of existing DOM nodes on every line, and progress feedback is coalesced so high-volume SteamCMD output does not flood the notification stack.

## Audit documentation

See [docs/FINAL-AUDIT.md](docs/FINAL-AUDIT.md) for the final logic-audit scope and verification notes.

## uMod Windows runtime repair

Rust Forge treats the official uMod Windows download as the primary source, discovers the packaged `RustDedicated_Data/Managed` directory instead of assuming a fixed archive root, and verifies the patched Windows Oxide runtime contract (`Assembly-CSharp.dll`, `Oxide.Common.dll`, `Oxide.Core.dll`, `Oxide.CSharp.dll`, `Oxide.References.dll`, `Oxide.Rust.dll`, `Oxide.Unity.dll`). Optional database extensions are not required for core uMod readiness. It also serializes all shared Rust runtime mutations so SteamCMD validation/update can never race with an Oxide patch. On Windows, ZIP extraction falls back to the native PowerShell `Expand-Archive` path when needed.



### uMod Reliability
Rust Forge 1.0.0 serializes shared runtime preparation, prefers the current Windows Oxide release, and verifies the complete package in the real Rust installation before reporting success. For the current Rust 2634.289.1 runtime, the verified compatibility fallback is Oxide.Rust 2.0.7801.

## GitHub Release + Website

Rust Forge can be published entirely with free GitHub infrastructure. See `OPEN-SOURCE-PUBLISH.md` for the one-time repository setup, v1.0.0 tag flow, automatic Windows release build, and GitHub Pages deployment.

The desktop app includes an **About & Updates** surface that checks the public GitHub latest release and can download the newest Setup or Portable x64 asset into the user's Downloads folder.
