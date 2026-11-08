#!/bin/sh
# Builds a release archive for one platform into dist/release.
#   tools/package.sh linux|macos|windows
set -eu
platform=${1:-}
root=$(cd "$(dirname "$0")/.." && pwd)
case "$platform" in
  linux|macos) installer=install.sh ;;
  windows) installer=install.ps1 ;;
  *) echo "usage: $0 linux|macos|windows" >&2; exit 2 ;;
esac
version=$(node -p "require('$root/plugin/package.json').version")
(cd "$root/plugin" && node build.mjs)

name="vcstream-$platform-v$version"
out="$root/dist/release"
stage="$out/$name"
rm -rf "$stage"
mkdir -p "$stage"
for file in "$installer" main.js plugin.js app-index.js linux-audio.js; do
  cp "$root/dist/public/$file" "$stage/"
done

server=$(grep -o "BASE_URL=[^ ]*" "$stage/install.sh" 2>/dev/null | cut -d= -f2 || true)
case "$platform" in
  windows)
    cat > "$stage/INSTALL.txt" <<TXT
VCStream $version for Windows

Close Discord, then run this in PowerShell from this folder, with your access key:
  powershell -ExecutionPolicy Bypass -File .\\install.ps1 <access-key>
To remove it:
  powershell -ExecutionPolicy Bypass -File .\\install.ps1 -Uninstall
Run it again after a Discord update, which removes the hook.
TXT
    (cd "$out" && rm -f "$name.zip" && zip -qr "$name.zip" "$name")
    echo "$out/$name.zip"
    ;;
  *)
    cat > "$stage/INSTALL.txt" <<TXT
VCStream $version for $platform

Run this in a terminal from this folder, with your access key:
  sh install.sh <access-key>
To remove it:
  sh install.sh --uninstall
Run it again after a Discord update, which removes the hook.
TXT
    [ "$platform" = macos ] && cat >> "$stage/INSTALL.txt" <<'TXT'

If macOS says it blocked changes to Discord.app, turn on your terminal app under
System Settings > Privacy & Security > App Management, then run it again.
TXT
    (cd "$out" && tar -czf "$name.tar.gz" "$name")
    echo "$out/$name.tar.gz"
    ;;
esac
