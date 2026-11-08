# Runs install.ps1 with Invoke-WebRequest replaced by a fake token server, so the
# installer test needs no network: KEY_bad is refused, down.example.com can't be
# reached, and any other key is accepted.
#   powershell -File test\fake-web.ps1 <install.ps1> [installer arguments]
# A plain param block, so the installer's own arguments stay in $args.
param([string]$Installer)
Add-Type -TypeDefinition @'
public class FakeResponse { public int StatusCode; }
public class FakeWebException : System.Exception {
  public FakeResponse Response;
  public FakeWebException(int code) : base("HTTP " + code) { Response = new FakeResponse(); Response.StatusCode = code; }
}
'@
function Invoke-WebRequest {
  param([string]$Uri, [hashtable]$Headers, [string]$OutFile, [int]$TimeoutSec, [switch]$UseBasicParsing)
  New-Item -ItemType Directory -Force $env:APPDATA | Out-Null
  Add-Content (Join-Path $env:APPDATA 'requests.log') $Uri
  if ($Uri -like 'https://down.example.com/*') { throw 'Unable to connect to the remote server' }
  if ($Uri -like '*/dstream/check') {
    if ($Headers.Authorization -like '*KEY_bad') { throw [FakeWebException]::new(401) }
    return
  }
  throw [FakeWebException]::new(404)
}
& $Installer @args
