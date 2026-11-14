#!/bin/sh
# macOS LaunchAgent: restore the installed hook offline, then check daily for a
# newer stable macOS release. No Node/Python install, key in arguments, or sudo.
set -eu
umask 077
DATA_DIR="$HOME/Library/Application Support/discord-byo-stream"
UPDATE_API='__BYO_UPDATE_API__'
RELEASE_ROOT='__BYO_RELEASE_ROOT__'
PAYLOAD='main.js plugin.js app-index.js audio-source.js linux-audio.js install.sh update.sh'
[ "$(uname -s)" = Darwin ] || exit 0
[ -f "$DATA_DIR/config.json" ] && [ -f "$DATA_DIR/install.sh" ] || exit 0
# Leave running Discord sessions alone. The installer checks again before writing.
if pgrep -U "$(id -u)" -f '/[^/]*[Dd]iscord[^/]*\.app/Contents/MacOS/' >/dev/null 2>&1; then exit 0; fi

lock_kind=flock
if command -v shlock >/dev/null 2>&1; then
  shlock -p "$$" -f "$DATA_DIR/.update-lock" || exit 0
  lock_kind=shlock
else
  exec 8> "$DATA_DIR/.update-lock"
  flock -n 8 || exit 0
fi
stage=
cleanup() {
  [ -z "$stage" ] || rm -rf "$stage"
  if [ "$lock_kind" = shlock ] && [ "$(cat "$DATA_DIR/.update-lock" 2>/dev/null)" = "$$" ]; then rm -f "$DATA_DIR/.update-lock"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
# launchd appends to this file. Keep it bounded without logging credentials.
if [ -f "$DATA_DIR/updater.log" ] && [ "$(wc -c < "$DATA_DIR/updater.log")" -gt 1048576 ]; then
  tail -c 524288 "$DATA_DIR/updater.log" > "$DATA_DIR/updater.log.new"
  cat "$DATA_DIR/updater.log.new" > "$DATA_DIR/updater.log"
  rm -f "$DATA_DIR/updater.log.new"
fi

NONINTERACTIVE=1 sh "$DATA_DIR/install.sh" --repair || { log 'Repair failed; run the installer from Terminal (macOS App Management may require it).'; exit 1; }
# Custom server builds retain their distribution source and only repair locally.
[ -n "$UPDATE_API" ] || exit 0
today=$(date -u '+%Y-%m-%d')
[ "$(cat "$DATA_DIR/update-checked" 2>/dev/null || true)" != "$today" ] || exit 0
# Bound even failed requests to once daily, including GitHub rate limits/offline use.
printf '%s\n' "$today" > "$DATA_DIR/update-checked"
stage=$(mktemp -d "$DATA_DIR/.update.XXXXXX")
download() { curl -fsSL --retry 2 --connect-timeout 10 --max-time 120 "$1" -o "$2"; }
download "$UPDATE_API" "$stage/releases.json" || { log 'Update check unavailable; keeping installed version.'; exit 0; }

# JXA ships with macOS. Parse actual JSON and exclude drafts, prereleases, other
# platforms and malformed tags. Numeric sorting handles 0.1.10 versus 0.1.9.
tag=$(osascript -l JavaScript -e '
ObjC.import("Foundation");
function run(argv) {
  const text = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
  const releases = JSON.parse(ObjC.unwrap(text));
  const tags = releases.filter(r => !r.draft && !r.prerelease && /^macos-v\d+\.\d+\.\d+$/.test(r.tag_name)).map(r => r.tag_name);
  const parts = tag => tag.slice(7).split(".").map(Number);
  const compare = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] - y[i]; } return 0; };
  tags.sort(compare);
  const latest = tags[tags.length - 1];
  return latest && compare(latest, "macos-v" + argv[1]) > 0 ? latest : "";
}' "$stage/releases.json" "$(cat "$DATA_DIR/version")") || { log 'Invalid release response; keeping installed version.'; exit 0; }
case "$tag" in macos-v[0-9]*.[0-9]*.[0-9]*) ;; *) exit 0 ;; esac
printf '%s' "$tag" | grep -Eq '^macos-v[0-9]+\.[0-9]+\.[0-9]+$' || exit 1
url="$RELEASE_ROOT/$tag"
download "$url/SHA256SUMS.txt" "$stage/SHA256SUMS.txt" || exit 1
for file in $PAYLOAD; do
  download "$url/$file" "$stage/$file" || exit 1
  [ -s "$stage/$file" ] || exit 1
  expected=$(awk -v file="$file" '$2 == file || $2 == "*" file { print $1 }' "$stage/SHA256SUMS.txt")
  actual=$(shasum -a 256 "$stage/$file"); actual=${actual%% *}
  if [ "${#expected}" -ne 64 ] || [ "$expected" != "$actual" ]; then
    log "Checksum failed for $file; keeping installed version."
    exit 1
  fi
done
if NONINTERACTIVE=1 sh "$stage/install.sh" --background; then
  log "Installed $tag; changes load next time Discord opens."
else
  code=$?
  if [ "$code" -eq 75 ]; then
    rm -f "$DATA_DIR/update-checked"
    log 'Discord opened during the update; deferred until it closes.'
  else
    log 'Update installation failed; run the installer from Terminal.'
    exit "$code"
  fi
fi
