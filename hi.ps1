

# Claude Chrome Extension patch
#
# This script finds, copies, and patches the Claude Chrome extension to:
#   1. Use a custom user agent (Firefox instead of revealing extension info)
#   2. Bypass permission category checks
#
# This will allow you to use Claude on Reddit, Amazon or wherever it would usually be blocked.
#
# After running, load the patched extension in Chrome:
#   1. Go to chrome://extensions/
#   2. Disable/remove the original Claude extension
#   3. Enable Developer mode (top right)
#   4. Click "Load unpacked" and select the destination folder

# ============== CONFIGURATION - EDIT THESE ==============
# Chrome profile folder name (check chrome://version for "Profile Path")
$ChromeProfile = "Default"

# Where to save the patched extension
$DestinationPath = "$HOME/ClaudeChromeExtension"

# Chrome user data path - auto-detected, or set manually:
# Windows:  $env:LOCALAPPDATA\Google\Chrome\User Data
# macOS:    $HOME/Library/Application Support/Google/Chrome
# Linux:    $HOME/.config/google-chrome
$ChromeUserData = "$HOME/Library/Application Support/Google/Chrome"
# ========================================================

$ErrorActionPreference = "Stop"

# Platform detection (PS5 doesn't have $IsWindows etc, but only runs on Windows)
if (-not (Get-Variable IsWindows -ErrorAction SilentlyContinue)) {
    $IsWindows = $true
    $IsMacOS = $false
    $IsLinux = $false
}

# Auto-detect Chrome path if not set
if (-not $ChromeUserData) {
    if ($IsWindows) {
        $ChromeUserData = "$env:LOCALAPPDATA\Google\Chrome\User Data"
    } elseif ($IsMacOS) {
        $ChromeUserData = "$HOME/Library/Application Support/Google/Chrome"
    } else {
        $ChromeUserData = "$HOME/.config/google-chrome"
    }
}

$ChromeExtensionsPath = Join-Path $ChromeUserData "$ChromeProfile/Extensions"

# Dynamic regex patterns (handle minified variable names)
# Matches: getUserAgent(){return`${this.constructor.name}/JS ${X}`}  where X is any identifier
$UserAgentPattern = 'getUserAgent\(\)\{return`\$\{this\.constructor\.name\}/JS \$\{[A-Za-z_$][A-Za-z0-9_$]*\}`\}'
$NewUserAgent = 'getUserAgent(){return"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0"}'

# Matches the getCategory function structure with any single-letter minified names
# Pattern: static async getCategory(e){const t=X(Y(e)),r=this.cache.get(t);if(r){if(!(Date.now()-r.timestamp>this.CACHE_TTL_MS))return r.category;this.cache.delete(t)}const o=this.pendingRequests.get(t);if(o)return o;const n=this.fetchCategoryFromAPI(t);this.pendingRequests.set(t,n);try{return await n}finally{this.pendingRequests.delete(t)}}
$GetCategoryPattern = 'static async getCategory\([a-z]\)\{const [a-z]=[A-Za-z_$]+\([A-Za-z_$]+\([a-z]\)\),[a-z]=this\.cache\.get\([a-z]\);if\([a-z]\)\{if\(!\(Date\.now\(\)-[a-z]\.timestamp>this\.CACHE_TTL_MS\)\)return [a-z]\.category;this\.cache\.delete\([a-z]\)\}const [a-z]=this\.pendingRequests\.get\([a-z]\);if\([a-z]\)return [a-z];const [a-z]=this\.fetchCategoryFromAPI\([a-z]\);this\.pendingRequests\.set\([a-z],[a-z]\);try\{return await [a-z]\}finally\{this\.pendingRequests\.delete\([a-z]\)\}\}'
$NewGetCategory = 'static async getCategory(e){return"category0"}'

Write-Host "Looking for Claude extension..." -ForegroundColor Cyan

if (-not (Test-Path $ChromeExtensionsPath)) {
    Write-Host "Chrome extensions folder not found at: $ChromeExtensionsPath" -ForegroundColor Red
    Write-Host "Check your ChromeProfile setting (current: '$ChromeProfile')" -ForegroundColor Yellow
    exit 1
}

# Find the Claude extension by checking manifest.json files
$ClaudeExtension = $null
foreach ($ExtDir in Get-ChildItem -Path $ChromeExtensionsPath -Directory) {
    foreach ($VersionDir in Get-ChildItem -Path $ExtDir.FullName -Directory) {
        $ManifestPath = Join-Path $VersionDir.FullName "manifest.json"
        if (Test-Path $ManifestPath) {
            $Manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
            if ($Manifest.name -eq "Claude") {
                $ClaudeExtension = @{
                    Id = $ExtDir.Name
                    Path = $ExtDir.FullName
                }
                break
            }
        }
    }
    if ($ClaudeExtension) { break }
}

if (-not $ClaudeExtension) {
    Write-Host "Could not find Claude extension!" -ForegroundColor Red
    exit 1
}

Write-Host "Found Claude extension: $($ClaudeExtension.Id)" -ForegroundColor Green

# Get the latest version folder (sorted by version number)
$VersionFolders = Get-ChildItem -Path $ClaudeExtension.Path -Directory |
    Sort-Object { [Version]($_.Name -replace '_', '.') } -Descending
$LatestVersion = $VersionFolders[0]

Write-Host "Latest version: $($LatestVersion.Name)" -ForegroundColor Green

# Clean destination and copy
if (Test-Path $DestinationPath) {
    Write-Host "Removing existing destination folder..." -ForegroundColor Yellow
    Remove-Item -Path $DestinationPath -Recurse -Force
}

Write-Host "Copying extension to $DestinationPath..." -ForegroundColor Cyan
Copy-Item -Path $LatestVersion.FullName -Destination $DestinationPath -Recurse

# Patch mcpServersStore-*.js (User Agent)
$AssetsPath = Join-Path $DestinationPath "assets"
$ServersStoreFile = Get-ChildItem -Path $AssetsPath -Filter "mcpServersStore-*.js" | Select-Object -First 1
if ($ServersStoreFile) {
    Write-Host "Patching $($ServersStoreFile.Name)..." -ForegroundColor Cyan
    $Content = Get-Content $ServersStoreFile.FullName -Raw
    if ($Content -match $UserAgentPattern) {
        $Content = $Content -replace $UserAgentPattern, $NewUserAgent
        Set-Content -Path $ServersStoreFile.FullName -Value $Content -NoNewline
        Write-Host "  User agent patched!" -ForegroundColor Green
    } else {
        Write-Host "  Warning: User agent pattern not found (structure may have changed)" -ForegroundColor Yellow
    }
} else {
    Write-Host "Warning: mcpServersStore-*.js not found!" -ForegroundColor Yellow
}

# Patch mcpPermissions-*.js (Category bypass)
$McpFile = Get-ChildItem -Path $AssetsPath -Filter "mcpPermissions-*.js" | Select-Object -First 1
if ($McpFile) {
    Write-Host "Patching $($McpFile.Name)..." -ForegroundColor Cyan
    $Content = Get-Content $McpFile.FullName -Raw
    if ($Content -match $GetCategoryPattern) {
        $Content = $Content -replace $GetCategoryPattern, $NewGetCategory
        Set-Content -Path $McpFile.FullName -Value $Content -NoNewline
        Write-Host "  Category bypass patched!" -ForegroundColor Green
    } else {
        Write-Host "  Warning: getCategory pattern not found (structure may have changed)" -ForegroundColor Yellow
    }
} else {
    Write-Host "Warning: mcpPermissions-*.js not found!" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done! Next steps:" -ForegroundColor Green
Write-Host "  1. Go to chrome://extensions/" -ForegroundColor White
Write-Host "  2. Disable/remove the original Claude extension" -ForegroundColor White
Write-Host "  3. Enable Developer mode (top right)" -ForegroundColor White
Write-Host "  4. Click 'Load unpacked' and select:" -ForegroundColor White
Write-Host "     $DestinationPath" -ForegroundColor Cyan
