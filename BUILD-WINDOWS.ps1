$ErrorActionPreference = 'Stop'

Write-Host "Rust Forge Windows build" -ForegroundColor Cyan
Write-Host "Checking Node.js..."
node --version
npm --version

Write-Host "Installing dependencies..." -ForegroundColor DarkCyan
npm install

Write-Host "Running smoke checks..." -ForegroundColor DarkCyan
npm run check

Write-Host "Building Windows Setup + Portable artifacts..." -ForegroundColor DarkCyan
npm run dist

Write-Host "Build complete. See .\release" -ForegroundColor Green
Get-ChildItem .\release -File | Select-Object Name, Length
