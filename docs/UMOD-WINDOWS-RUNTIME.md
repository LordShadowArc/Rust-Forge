# uMod Windows Runtime — v1.0.0

Rust Forge installs uMod only after the Rust Dedicated runtime is final and SteamCMD validation is complete.

## Required Windows runtime contract

Forge considers the Windows Oxide runtime ready only when the patched game assembly and the Oxide runtime assemblies are present under `RustDedicated_Data/Managed`: Core: `Assembly-CSharp.dll`, `Oxide.Common.dll`, `Oxide.Core.dll`, `Oxide.CSharp.dll`, `Oxide.References.dll`, `Oxide.Rust.dll`, `Oxide.Unity.dll`. Database extensions such as `Oxide.MySql.dll` or `Oxide.SQLite.dll` are optional and do not block core uMod readiness.

Forge also serializes the complete Rust runtime mutation transaction. SteamCMD install/update/validate and uMod installation can never interleave, because SteamCMD validation restores vanilla Managed assemblies and must always happen before the final Oxide patch.

## Installation sources

The canonical Windows source is `https://umod.org/games/rust/download`. GitHub release assets are fallback sources.

## Extraction safety

The installer validates the archive before copying it, discovers the actual `RustDedicated_Data/Managed` directory regardless of archive nesting, verifies the copied assemblies at their final paths, and on Windows can retry extraction with native `Expand-Archive`.
