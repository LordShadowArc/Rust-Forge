# Public Server + Playit Guide

Rust Forge 1.0.0 keeps Rust server identity, networking and tunnel policy in one server profile.

## Public branding

Use **Servers → Edit → Public Server Identity** to configure:

- **Server Hostname** — the Rust-facing server name.
- **Server Description** — public description/details text.
- **Website** — optional HTTPS/HTTP URL.
- **Header Image URL** — optional server browser header image.
- **Server Icon URL** — optional logo image.
- **Server Browser Tags** — up to four validated Rust tags with mutually-exclusive groups.

Forge writes these values to the profile's generated `server.cfg`. The profile remains the source of truth; the application does not require users to hand-edit config files.

## Playit mode

Playit is a **shared background agent**. Multiple Rust Forge server profiles can use Playit, while the agent itself is started only once.

For a secure profile:

1. Set **Access Mode** to `Playit Tunnel`.
2. Keep **Secure local binding** enabled.
3. Forge binds the Rust game/query endpoints to `127.0.0.1` according to the profile policy.
4. Start the managed Playit agent.
5. In the Playit dashboard, create a **UDP** tunnel that forwards to `127.0.0.1:<Game Port>`.
6. Enter the public address shown by Playit into **Public Game Address** if you want Forge to display it.
7. Only enable **Expose query through Playit** when a separate UDP query tunnel has deliberately been created.
8. Keep RCON private. Rust Forge never maps the RCON TCP port through Playit.

Rust Forge does not attempt to create or mutate Playit tunnel definitions automatically. This is intentional: the public dashboard/agent workflow is the stable, user-visible contract, while Forge owns lifecycle, secure local binding, process management, diagnostics and address metadata.

## Health diagnostics

The Runtime Health surface reports:

- RustDedicated / SteamCMD availability
- Windows Steamworks assembly hygiene
- server identity/config boundaries
- game/query/RCON socket state
- RCON credential policy
- uMod state
- Rust startup readiness
- recent Rust/EAC/Steamworks log signals
- managed Playit agent state and secure-bind policy
- latest telemetry sample

A client-side `EAC: Client integrity violation` is reported as a warning because it indicates an EAC rejection of a client connection; it is not automatically treated as proof that the server runtime is broken.
