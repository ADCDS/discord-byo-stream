#!/bin/sh
# Builds one platform's GitHub release into dist/release/<platform>: an archive to
# download and unpack, plus the same files loose for the one-line installers.
#   tools/package.sh linux|macos|windows
set -eu
platform=${1:-}
root=$(cd "$(dirname "$0")/.." && pwd)
case "$platform" in
  linux|macos) files="install.sh main.js plugin.js app-index.js audio-source.js linux-audio.js" ;;
  windows) files="install.ps1 main.js plugin.js app-index.js audio-source.js" ;;
  *) echo "usage: $0 linux|macos|windows" >&2; exit 2 ;;
esac
# A relative require: on Windows, node can't read Git Bash's /c/... paths.
version=$(cd "$root/plugin" && node -p "require('./package.json').version")
(cd "$root/plugin" && BYO_RELEASE="$platform" node build.mjs)
built="$root/dist/release-files/$platform"

name="discord-byo-stream-$platform-v$version"
out="$root/dist/release/$platform"
stage="$root/dist/release/stage-$platform/$name"
rm -rf "$out" "$root/dist/release/stage-$platform"
mkdir -p "$out" "$stage"
for file in $files; do
  cp "$built/$file" "$stage/"
  cp "$built/$file" "$out/"
done
cp "$root/LICENSE" "$stage/LICENSE.txt"

case "$platform" in
  windows)
    cp "$root/installer/wrappers/Install.cmd" "$root/installer/wrappers/Uninstall.cmd" "$stage/"
    # Windows wants CRLF in text files people open in Notepad.
    sed 's/$/\r/' > "$stage/READ ME.txt" <<TXT
BYO Stream $version for Windows

1. Extract this zip (right-click it, Extract All).
2. Double-click Install.cmd in the extracted folder.
   If Windows asks whether to run it, choose Run (or More info, then Run anyway).
3. Type the server address and access key you were given, and press Enter.

Discord restarts by itself. Run Install.cmd again after a Discord update, and to update
BYO Stream. Uninstall.cmd removes it.

Help: https://github.com/ADCDS/discord-byo-stream
TXT
    ;;
  macos)
    cp "$root/installer/wrappers/Install.command" "$root/installer/wrappers/Uninstall.command" "$stage/"
    chmod +x "$stage/Install.command" "$stage/Uninstall.command"
    cat > "$stage/READ ME.txt" <<TXT
BYO Stream $version for macOS

1. Double-click Install.command.
   If macOS says it can't verify it: open System Settings > Privacy & Security,
   scroll down, click Open Anyway next to "Install.command", then Open.
2. Type the server address and access key you were given, and press Return.
3. If it says macOS blocked changes to Discord.app: in System Settings > Privacy &
   Security > App Management, turn on Terminal, then double-click Install.command again.

Discord restarts by itself. Run Install.command again after a Discord update, and to
update BYO Stream. Uninstall.command removes it.

Help: https://github.com/ADCDS/discord-byo-stream
TXT
    ;;
  linux)
    cat > "$stage/READ ME.txt" <<TXT
BYO Stream $version for Linux

Close Discord, then in a terminal in this folder:
  sh install.sh
It asks for the server address and access key you were given. To remove it:
  sh install.sh --uninstall

Run it again after a Discord update, and to update BYO Stream. Needs the official
Discord (.deb or .tar.gz from discord.com); Flatpak and Snap Discord can't be hooked.

Help: https://github.com/ADCDS/discord-byo-stream
TXT
    ;;
esac

# Zips unpack into a folder of their own name on Windows and macOS, so their files go at
# the top level. The tarball keeps the usual top folder.
if [ "$platform" = linux ]; then
  (cd "$stage/.." && tar -czf "$out/$name.tar.gz" "$name")
else
  if command -v zip >/dev/null 2>&1; then
    (cd "$stage" && zip -qrX "$out/$name.zip" .)
  else # Windows runners have 7-Zip instead
    (cd "$stage" && 7z a -tzip -bso0 "$(cygpath -w "$out/$name.zip" 2>/dev/null || echo "$out/$name.zip")" . >/dev/null)
  fi
fi
rm -rf "$root/dist/release/stage-$platform"
sums=$(cd "$out" && if command -v sha256sum >/dev/null 2>&1; then sha256sum -- *; else shasum -a 256 -- *; fi)
printf '%s\n' "$sums" > "$out/SHA256SUMS.txt"
ls "$out"
