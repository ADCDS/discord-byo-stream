# VCStream installer for Windows. Re-run it to update, or after a Discord update
# removes the hook. Works in Windows PowerShell 5.1 and PowerShell 7.
#   & ([scriptblock]::Create((irm __VCSTREAM_SERVER__/dstream/dl/install.ps1))) <access-key>
#   & ([scriptblock]::Create((irm __VCSTREAM_SERVER__/dstream/dl/install.ps1))) -Uninstall
# From an unpacked release, run it next to its files: .\install.ps1 <access-key>
param(
  [Parameter(Position = 0)][string]$AccessKey,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$BaseUrl = '__VCSTREAM_SERVER__/dstream/dl'
$PayloadFiles = 'main.js', 'plugin.js', 'app-index.js'
$DataDir = Join-Path $env:APPDATA 'VCStream'
$Channels = @(
  @{ Folder = 'Discord'; Exe = 'Discord' },
  @{ Folder = 'DiscordPTB'; Exe = 'DiscordPTB' },
  @{ Folder = 'DiscordCanary'; Exe = 'DiscordCanary' }
)

# Never leave Discord closed because of a failure.
$script:Closed = @()
function Start-ClosedDiscord {
  foreach ($channel in $script:Closed) {
    $update = Join-Path $env:LOCALAPPDATA "$($channel.Folder)\Update.exe"
    if (Test-Path $update) { Start-Process $update -ArgumentList '--processStart', "$($channel.Exe).exe" }
  }
  $script:Closed = @()
}

# Throws instead of exiting: when run through a scriptblock, exit would close the window.
function Fail([string]$Message) {
  Start-ClosedDiscord
  throw "VCStream: $Message"
}

function Find-Installs {
  foreach ($channel in $Channels) {
    $root = Join-Path $env:LOCALAPPDATA $channel.Folder
    if (-not (Test-Path $root)) { continue }
    # Only the newest version runs; Discord's updater manages the rest.
    $latest = Get-ChildItem $root -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^app-(\d+(\.\d+)+)$' } |
      Sort-Object { [version]($_.Name.Substring(4)) } |
      Select-Object -Last 1
    if (-not $latest) { continue }
    $resources = Join-Path $latest.FullName 'resources'
    if ((Test-Path (Join-Path $resources 'app.asar')) -or (Test-Path (Join-Path $resources 'vcstream.app.asar'))) {
      [pscustomobject]@{ Channel = $channel; Resources = $resources }
    }
  }
}

function Assert-Writable([string]$Dir) {
  $probe = Join-Path $Dir '.vcstream-probe'
  try {
    [IO.File]::WriteAllText($probe, '')
    Remove-Item $probe -Force
  } catch {
    Fail "can't write to $Dir. Discord was left unchanged."
  }
}

function Close-Discord($Installs) {
  foreach ($install in $Installs) {
    $name = $install.Channel.Exe
    if (-not (Get-Process -Name $name -ErrorAction SilentlyContinue)) { continue }
    Write-Host "Closing $name..."
    $script:Closed += $install.Channel
    Stop-Process -Name $name -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 15 -and (Get-Process -Name $name -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
    if (Get-Process -Name $name -ErrorAction SilentlyContinue) { Fail "couldn't close $name. Quit it from the tray icon and run this again." }
  }
}

function Install-Hook([string]$Resources) {
  $asar = Join-Path $Resources 'app.asar'
  $preserved = Join-Path $Resources 'vcstream.app.asar'
  $appDir = Join-Path $Resources 'app'
  # A live app.asar is always Discord's current app, so any preserved copy is stale.
  if (Test-Path $asar) {
    if (Test-Path $preserved) { Remove-Item $preserved -Force }
    Move-Item $asar $preserved
  }
  if (-not (Test-Path $preserved)) { Fail "no app.asar in $Resources" }
  try {
    New-Item -ItemType Directory -Force -Path $appDir | Out-Null
    [IO.File]::WriteAllText((Join-Path $appDir 'package.json'), '{"main":"./index.js"}')
    Copy-Item (Join-Path $DataDir 'app-index.js') (Join-Path $appDir 'index.js') -Force
  } catch {
    Uninstall-Hook $Resources
    Fail "couldn't write the hook into $Resources. Discord was left unchanged."
  }
  Write-Host "Hooked $Resources"
}

function Uninstall-Hook([string]$Resources) {
  $asar = Join-Path $Resources 'app.asar'
  $preserved = Join-Path $Resources 'vcstream.app.asar'
  Remove-Item (Join-Path $Resources 'app') -Recurse -Force -ErrorAction SilentlyContinue
  if ((Test-Path $preserved) -and -not (Test-Path $asar)) { Move-Item $preserved $asar }
  Remove-Item $preserved -Force -ErrorAction SilentlyContinue
}

function Get-Payload {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  # Next to an unpacked release, use its files; otherwise download them.
  $local = if ($PSScriptRoot) { $PSScriptRoot } else { $null }
  foreach ($file in $PayloadFiles) {
    $target = Join-Path $DataDir $file
    if ($local -and (Test-Path (Join-Path $local $file))) {
      Copy-Item (Join-Path $local $file) $target -Force
    } else {
      try {
        Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$file" -OutFile "$target.new"
      } catch {
        Fail "download of $file failed: $($_.Exception.Message)"
      }
      if ((Get-Item "$target.new").Length -eq 0) { Fail "download of $file was empty" }
      Move-Item "$target.new" $target -Force
    }
  }
  [IO.File]::WriteAllText((Join-Path $DataDir 'config.json'), "{`"accessKey`":`"$AccessKey`"}")
}

try {
  if (-not $Uninstall) {
    if (-not $AccessKey) { Fail 'missing access key. Usage: install.ps1 <access-key>' }
    if ($AccessKey -notmatch '^[A-Za-z0-9_-]+$') { Fail 'that access key has invalid characters' }
  }

  $installs = @(Find-Installs)
  if ($installs.Count -eq 0) { Fail "couldn't find Discord. Install it and open it once, then run this again." }

  # Everything that can fail without touching Discord happens before closing it.
  foreach ($install in $installs) { Assert-Writable $install.Resources }
  if (-not $Uninstall) { Get-Payload }

  Close-Discord $installs
  if ($Uninstall) {
    foreach ($install in $installs) { Uninstall-Hook $install.Resources }
    Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host 'VCStream removed.'
  } else {
    foreach ($install in $installs) { Install-Hook $install.Resources }
    Write-Host 'VCStream installed.'
  }
  if ($script:Closed.Count) { Start-ClosedDiscord } else { Write-Host 'Open Discord to finish.' }
} catch {
  Start-ClosedDiscord
  Write-Host $_.Exception.Message -ForegroundColor Red
}
