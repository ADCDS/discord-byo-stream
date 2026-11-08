# Runs the built install.ps1 (dist/public, so build first) against a fake Discord tree.
#   powershell -ExecutionPolicy Bypass -File test\install-test.ps1
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '..\dist\public\install.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) 'vcstream-install-test'
Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
$env:LOCALAPPDATA = "$root\local"; $env:APPDATA = "$root\roaming"
$res = "$env:LOCALAPPDATA\Discord\app-1.0.9200\resources"
New-Item -ItemType Directory -Force $res, "$env:LOCALAPPDATA\Discord\app-1.0.9199\resources" | Out-Null
'OLD VERSION' | Set-Content "$env:LOCALAPPDATA\Discord\app-1.0.9199\resources\app.asar"
'REAL ASAR v1' | Set-Content "$res\app.asar"
$failures = 0
function Check($name, [scriptblock]$test) { if (& $test) { "PASS  $name" } else { "FAIL  $name"; $script:failures++ } }
function Run([string[]]$a) { & powershell -NoProfile -ExecutionPolicy Bypass -File $installer @a 2>&1 | Out-String }
$data = "$env:APPDATA\VCStream"

$o = Run @()
Check 'rejects a missing key' { $o -match 'missing access key' -and (Get-Content "$res\app.asar") -eq 'REAL ASAR v1' }
$o = Run @('bad key;x')
Check 'rejects a malformed key' { $o -match 'invalid characters' }
$o = Run @('KEY_abc-123')
Check 'install reports success' { $o -match 'VCStream installed' }
Check 'newest version hooked' { Test-Path "$res\app\index.js" }
Check 'older version untouched' { (Get-Content "$env:LOCALAPPDATA\Discord\app-1.0.9199\resources\app.asar") -eq 'OLD VERSION' }
Check 'original preserved' { (Get-Content "$res\vcstream.app.asar") -eq 'REAL ASAR v1' }
Check 'live app.asar moved aside' { -not (Test-Path "$res\app.asar") }
Check 'hook package.json' { (Get-Content "$res\app\package.json") -eq '{"main":"./index.js"}' }
Check 'hook entry points at the real app' { (Get-Content "$res\app\index.js" -Raw) -match 'vcstream.app.asar' }
Check 'payload copied from the release folder' { (Get-Item "$data\plugin.js").Length -gt 100000 }
Check 'key stored as JSON' { (Get-Content "$data\config.json" -Raw | ConvertFrom-Json).accessKey -eq 'KEY_abc-123' }
$o = Run @('KEY_new')
Check 're-run keeps the original' { (Get-Content "$res\vcstream.app.asar") -eq 'REAL ASAR v1' }
Check 're-run updates the key' { (Get-Content "$data\config.json" -Raw | ConvertFrom-Json).accessKey -eq 'KEY_new' }
'REAL ASAR v2' | Set-Content "$res\app.asar"
$o = Run @('KEY_new')
Check 'Discord update: newer app wins' { (Get-Content "$res\vcstream.app.asar") -eq 'REAL ASAR v2' }
$o = Run @('-Uninstall')
Check 'uninstall reports' { $o -match 'VCStream removed' }
Check 'uninstall restores the app' { (Get-Content "$res\app.asar") -eq 'REAL ASAR v2' }
Check 'uninstall removes hook and preserved copy' { -not (Test-Path "$res\app") -and -not (Test-Path "$res\vcstream.app.asar") }
Check 'uninstall removes data and key' { -not (Test-Path $data) }
$o = Run @('-Uninstall')
Check 'uninstalling twice is harmless' { (Get-Content "$res\app.asar") -eq 'REAL ASAR v2' }
Remove-Item "$env:LOCALAPPDATA\Discord" -Recurse -Force
$o = Run @('KEY_x')
Check 'no Discord: clear message' { $o -match "couldn't find Discord" }
Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
if ($failures) { "$failures FAILED"; exit 1 } else { 'ALL PASSED' }
