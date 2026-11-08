# Runs the built install.ps1 against a fake Discord tree and a fake token server
# (fake-web.ps1). Build first: sh tools/package.sh windows
#   powershell -ExecutionPolicy Bypass -File test\install-test.ps1
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '..\dist\release-files\windows\install.ps1'
$fakeWeb = Join-Path $PSScriptRoot 'fake-web.ps1'
$server = 'https://streams.example.com'
$root = Join-Path ([IO.Path]::GetTempPath()) 'byo-stream-install-test'
Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
$env:LOCALAPPDATA = "$root\local"; $env:APPDATA = "$root\roaming"
$res = "$env:LOCALAPPDATA\Discord\app-1.0.9200\resources"
New-Item -ItemType Directory -Force $res, "$env:LOCALAPPDATA\Discord\app-1.0.9199\resources" | Out-Null
'OLD VERSION' | Set-Content "$env:LOCALAPPDATA\Discord\app-1.0.9199\resources\app.asar"
'REAL ASAR v1' | Set-Content "$res\app.asar"
$failures = 0
function Check($name, [scriptblock]$test) { if (& $test) { "PASS  $name" } else { "FAIL  $name"; $script:failures++ } }
# -NonInteractive: a question the installer would ask fails instead of waiting.
function Run([string[]]$a) { & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $fakeWeb $installer @a 2>&1 | Out-String }
$data = "$env:APPDATA\discord-byo-stream"
function Unchanged { (Get-Content "$res\app.asar") -eq 'REAL ASAR v1' -and -not (Test-Path "$res\app") }

$o = Run @('-Server', $server)
Check 'unable to ask, a missing key is an error' { $o -match 'BYO Stream:|NonInteractive' -and $o -notmatch 'installed' }
$o = Run @('KEY_abc')
Check 'unable to ask, a missing server is an error' { $o -match 'BYO Stream:|NonInteractive' -and $o -notmatch 'installed' }
$o = Run @('-Server', $server, 'bad key;x')
Check 'rejects a malformed key' { $o -match 'invalid characters' }
$o = Run @('-Server', 'http://streams.example.com', 'KEY_abc')
Check 'rejects a plain http server' { $o -match 'must use https' }
$o = Run @('-Server', 'https://streams.example.com/x', 'KEY_abc')
Check 'rejects a server with a path' { $o -match "isn't a server address" }
$o = Run @('-Server', $server, 'KEY_bad')
Check 'rejects a key the server refuses' { $o -match "didn't accept that access key" }
$o = Run @('-Server', 'https://down.example.com', 'KEY_abc')
Check "rejects a server it can't reach" { $o -match "couldn't reach" }
Check 'failures changed nothing' { Unchanged }
$o = Run @('-Server', 'streams.example.com/', 'KEY_abc-123')
Check 'install reports success' { $o -match 'BYO Stream installed for https://streams.example.com' }
Check 'newest version hooked' { Test-Path "$res\app\index.js" }
Check 'older version untouched' { (Get-Content "$env:LOCALAPPDATA\Discord\app-1.0.9199\resources\app.asar") -eq 'OLD VERSION' }
Check 'original preserved' { (Get-Content "$res\byo-stream.app.asar") -eq 'REAL ASAR v1' }
Check 'live app.asar moved aside' { -not (Test-Path "$res\app.asar") }
Check 'hook package.json' { (Get-Content "$res\app\package.json") -eq '{"main":"./index.js"}' }
Check 'hook entry points at the real app' { (Get-Content "$res\app\index.js" -Raw) -match 'byo-stream.app.asar' }
Check 'payload copied from the release folder' { (Get-Item "$data\plugin.js").Length -gt 100000 }
$config = Get-Content "$data\config.json" -Raw | ConvertFrom-Json
Check 'key stored as JSON' { $config.accessKey -eq 'KEY_abc-123' }
Check 'server stored, as an https origin' { $config.server -eq 'https://streams.example.com' }
Check 'nothing downloaded next to the release files' { -not (Select-String -Quiet -Path "$env:APPDATA\requests.log" -Pattern 'releases/download') }
$o = Run @('-Server', $server, 'KEY_new')
Check 're-run keeps the original' { (Get-Content "$res\byo-stream.app.asar") -eq 'REAL ASAR v1' }
Check 're-run updates the key' { (Get-Content "$data\config.json" -Raw | ConvertFrom-Json).accessKey -eq 'KEY_new' }
'REAL ASAR v2' | Set-Content "$res\app.asar"
$o = Run @('-Server', $server, 'KEY_new')
Check 'Discord update: newer app wins' { (Get-Content "$res\byo-stream.app.asar") -eq 'REAL ASAR v2' }
$o = Run @('-Uninstall')
Check 'uninstall reports' { $o -match 'BYO Stream removed' }
Check 'uninstall restores the app' { (Get-Content "$res\app.asar") -eq 'REAL ASAR v2' }
Check 'uninstall removes hook and preserved copy' { -not (Test-Path "$res\app") -and -not (Test-Path "$res\byo-stream.app.asar") }
Check 'uninstall removes data and key' { -not (Test-Path $data) }
$o = Run @('-Uninstall')
Check 'uninstalling twice is harmless' { (Get-Content "$res\app.asar") -eq 'REAL ASAR v2' }
Remove-Item "$env:LOCALAPPDATA\Discord" -Recurse -Force
$o = Run @('-Server', $server, 'KEY_x')
Check 'no Discord: clear message' { $o -match "couldn't find Discord" }
Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
if ($failures) { "$failures FAILED"; exit 1 } else { 'ALL PASSED' }
