#!/bin/sh
# Runs a built install.sh against a fake macOS home with uname, curl and friends stubbed.
# Discord's real layout was taken from its DMG. Runs on Linux and on macOS itself.
#   sh test/install-test.sh [built folder]
# The folder defaults to the release build from tools/package.sh (macos, else linux).
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
built=${1:-}
if [ -z "$built" ]; then
  for dir in "$root/dist/release-files/macos" "$root/dist/release-files/linux"; do
    [ -f "$dir/install.sh" ] && built=$dir && break
  done
fi
[ -f "$built/install.sh" ] || { echo "build first: tools/package.sh macos" >&2; exit 2; }
built=$(cd "$built" && pwd)
work=$(mktemp -d)
trap 'if [ -n "${KEEP_TEST_WORK:-}" ]; then printf "Test files: %s\n" "$work"; else rm -rf "$work"; fi' EXIT
failures=0
SERVER=https://streams.example.com

check() { # name, then a command that must succeed
  name=$1; shift
  if "$@" >/dev/null 2>&1; then echo "PASS  $name"; else echo "FAIL  $name"; failures=$((failures + 1)); fi
}

mkdir -p "$work/bin"
cat > "$work/bin/uname" <<'EOF'
#!/bin/sh
echo Darwin
EOF
# The server check answers like the token server: 401 for KEY_bad, no connection to
# down.example.com. Downloads come from the built folder.
cat > "$work/bin/curl" <<EOF
#!/bin/sh
out= url= status= auth=
while [ \$# -gt 0 ]; do
  case "\$1" in
    -o) out=\$2; shift ;;
    -w) status=1; shift ;;
    -H) auth=\$2; shift ;;
    https*) url=\$1 ;;
  esac
  shift
done
echo "\$url" >> "$work/curl.log"
case "\$url" in https://down.example.com/*) [ -n "\$status" ] && printf 000; exit 7 ;; esac
if [ -f "$work/fail-download" ] && [ "\${url##*/}" = "\$(cat "$work/fail-download")" ]; then exit 7; fi
if [ -f "$work/open-on-download" ] && [ "\${url##*/}" = main.js ]; then : > "$work/running"; fi
if [ -n "\$status" ]; then
  case "\$url" in */dstream/check) ;; *) printf 404; exit 0 ;; esac
  case "\$auth" in *KEY_bad) printf 401 ;; *) printf 200 ;; esac
  exit 0
fi
case "\$url" in
  https://api.github.com/*) cp "$work/releases.json" "\$out"; exit ;;
  */macos-v0.1.10/*) cp "$work/new-release/\${url##*/}" "\$out"; exit ;;
esac
cp "$built/\${url##*/}" "\$out"
EOF
cat > "$work/bin/pgrep" <<EOF
#!/bin/sh
[ -e "$work/running" ]
EOF
cat > "$work/bin/osascript" <<EOF
#!/bin/sh
if [ "\$1" = -l ]; then
  if [ -x /usr/bin/osascript ]; then exec /usr/bin/osascript "\$@"; fi
  exec node "$root/test/jxa-test-runner.mjs" "\$@"
fi
rm -f "$work/running"
EOF
cat > "$work/bin/launchctl" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$work/launchctl.log"
EOF
# Don't discover additional renamed Discord copies through Spotlight.
cat > "$work/bin/mdfind" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$work/bin/open" <<EOF
#!/bin/sh
: > "$work/reopened"
EOF
chmod +x "$work/bin/"*

home="$work/home"
res="$home/Applications/Discord.app/Contents/Resources"
data="$home/Library/Application Support/discord-byo-stream"
agent="$home/Library/LaunchAgents/com.byo-stream.updater.plist"
mkdir -p "$res"
printf 'REAL ASAR v1' > "$res/app.asar"
# Alone, the installer downloads its files (through the curl stub).
cp "$built/install.sh" "$work/install.sh"
# The installer may not ask anything here, so it needs everything as arguments.
run() { HOME="$home" PATH="$work/bin:$PATH" NONINTERACTIVE=1 sh "$work/install.sh" "$@" < /dev/null; }
fails() { ! run "$@"; }
lock_free() {
  if command -v shlock >/dev/null 2>&1; then test ! -e "$1"; else flock -n "$1" true; fi
}
stale_lock() {
  # Use a real exited child PID. macOS shlock deliberately refuses to reclaim a
  # lock with the same ctime second as its temporary lock, so let it age first.
  owner=$(sh -c 'printf "%s\n" "$$"')
  printf '%s\n' "$owner" > "$1"
  if command -v shlock >/dev/null 2>&1; then sleep 2; fi
}

check "unable to ask, a missing server is an error" fails KEY_abc
check "unable to ask, a missing key is an error" fails --server "$SERVER"
check "rejects a malformed key" fails --server "$SERVER" "bad key;rm"
check "rejects a plain http server" fails --server http://streams.example.com KEY_abc
check "rejects a server with a path" fails --server https://streams.example.com/x KEY_abc
check "rejects a key the server refuses" fails --server "$SERVER" KEY_bad
check "rejects a server it can't reach" fails --server https://down.example.com KEY_abc
check "failures changed nothing" grep -q 'REAL ASAR v1' "$res/app.asar"
check "failures wrote no hook" test ! -e "$res/app"

: > "$work/running"
run --server streams.example.com/ KEY_abc-123 >/dev/null
check "install succeeds and closes Discord" test ! -e "$work/running"
check "reopens Discord afterwards" test -e "$work/reopened"
check "original app preserved" grep -q 'REAL ASAR v1' "$res/byo-stream.app.asar"
check "live app.asar moved aside" test ! -e "$res/app.asar"
check "hook entry written" grep -q 'byo-stream.app.asar' "$res/app/index.js"
check "hook package.json written" grep -q '"main":"./index.js"' "$res/app/package.json"
check "payload downloaded" test -s "$data/plugin.js"
check "key stored" grep -q '"accessKey":"KEY_abc-123"' "$data/config.json"
check "server stored, as an https origin" grep -q '"server":"https://streams.example.com"}' "$data/config.json"
check "payload came from the release" grep -q 'releases/download/.*/plugin.js' "$work/curl.log"
check "config is private" sh -c '[ "$(ls -l "$1" | cut -c1-10)" = "-rw-------" ]' _ "$data/config.json"
check "macOS helper installed" test -s "$agent"
check "helper registered" grep -q '^bootstrap gui/' "$work/launchctl.log"
check "helper and repair installer persisted" test -s "$data/update.sh"

# Validate the real generated plist, including paths with spaces and no key.
check "helper plist parses with correct arguments" python3 -c 'import plistlib,sys; p=plistlib.load(open(sys.argv[1],"rb")); assert p["ProgramArguments"] == ["/bin/sh",sys.argv[2]+"/update.sh"]; assert p["StartInterval"] == 60; assert "KEY_" not in str(p)' "$agent" "$data"

run >/dev/null
check "reinstall reuses saved server and key" grep -q 'KEY_abc-123' "$data/config.json"
check "a different server cannot inherit the saved key" fails --server https://other.example.com

# Local repair works offline, preserves the updated Discord app and never quits it.
: > "$work/curl.log"
rm -f "$work/reopened"
printf 'REAL ASAR repaired' > "$res/app.asar"
run --repair >/dev/null
check "repair uses newest Discord app" grep -q 'REAL ASAR repaired' "$res/byo-stream.app.asar"
check "repair needs no network" test ! -s "$work/curl.log"
check "repair does not open Discord" test ! -e "$work/reopened"
printf 'REAL ASAR while running' > "$res/app.asar"
: > "$work/running"
run --repair >/dev/null
check "repair does not quit a running Discord" test -e "$work/running"
check "repair leaves a running Discord untouched" grep -q 'REAL ASAR while running' "$res/app.asar"
rm -f "$work/running"
stale_lock "$data/.install-lock"
run --repair >/dev/null
check "repair recovers an abandoned installer lock" lock_free "$data/.install-lock"
if command -v shlock >/dev/null 2>&1; then
  printf '%s\n' "$$" > "$data/.install-lock"
  check "concurrent install is rejected" fails --repair
  rm -f "$data/.install-lock"
else
  locked_install_fails() { ! flock -n "$data/.install-lock" env HOME="$home" PATH="$work/bin:$PATH" NONINTERACTIVE=1 sh "$work/install.sh" --repair; }
  check "concurrent install is rejected" locked_install_fails
fi

# A partial download must not replace any of the installed payload or close Discord.
cp "$data/main.js" "$work/original-main.js"
printf 'plugin.js' > "$work/fail-download"
: > "$work/running"
check "partial download fails" fails
check "partial download preserves payload" cmp -s "$work/original-main.js" "$data/main.js"
check "partial download leaves Discord running" test -e "$work/running"
rm -f "$work/fail-download" "$work/running"

run --server="$SERVER" KEY_new >/dev/null
check "re-running keeps the original" grep -q 'REAL ASAR while running' "$res/byo-stream.app.asar"
check "re-running updates the key" grep -q 'KEY_new' "$data/config.json"

printf 'REAL ASAR v2' > "$res/app.asar"
run --server "$SERVER" KEY_new >/dev/null
check "Discord update: newer app wins" grep -q 'REAL ASAR v2' "$res/byo-stream.app.asar"

run --uninstall >/dev/null
check "uninstall restores the app" grep -q 'REAL ASAR v2' "$res/app.asar"
check "uninstall removes the preserved copy" test ! -e "$res/byo-stream.app.asar"
check "uninstall removes the hook" test ! -e "$res/app"
check "uninstall removes data and key" test ! -e "$data"
check "uninstall removes background helper" test ! -e "$agent"

# macOS App Management makes Discord.app unwritable: nothing may change, and
# Discord must not be left closed.
chmod a-w "$res"
: > "$work/running"; rm -f "$work/reopened"
run --server "$SERVER" KEY_x >/dev/null 2>&1
check "blocked install fails without closing Discord" test -e "$work/running"
check "blocked install leaves the app alone" grep -q 'REAL ASAR v2' "$res/app.asar"
check "blocked install writes no hook" test ! -e "$res/app"
chmod u+w "$res"
rm -f "$work/running"

# Next to an unpacked release, it uses those files and only checks the key online.
: > "$work/curl.log"
HOME="$home" PATH="$work/bin:$PATH" NONINTERACTIVE=1 sh "$built/install.sh" --server "$SERVER" KEY_local >/dev/null
check "release folder install needs no download" grep -q 'KEY_local' "$data/config.json"
check "release folder payload copied" test -s "$data/linux-audio.js"
check "release folder install downloads nothing" sh -c '! grep -q releases/download "$1"' _ "$work/curl.log"

# Exercise the scheduled helper against complete release files and their hashes.
update() { HOME="$home" PATH="$work/bin:$PATH" NONINTERACTIVE=1 sh "$data/update.sh"; }
mkdir -p "$work/new-release"
cp "$built/"*.js "$built/"*.sh "$work/new-release/"
# The installer carries the release version; don't rewrite executable plugin code.
sed "s/^VERSION=.*/VERSION=0.1.10/" "$built/install.sh" > "$work/new-release/install.sh"
(cd "$work/new-release" && shasum -a 256 -- *.js *.sh > SHA256SUMS.txt)
cat > "$work/releases.json" <<'EOF'
[
 {"tag_name":"windows-v9.0.0","draft":false,"prerelease":false},
 {"tag_name":"macos-v9.0.0","draft":false,"prerelease":true},
 {"tag_name":"macos-v8.0.0","draft":true,"prerelease":false},
 {"tag_name":"macos-v0.1.9","draft":false,"prerelease":false},
 {"tag_name":"macos-v0.1.10","draft":false,"prerelease":false}
]
EOF
: > "$work/curl.log"
: > "$work/running"
update >/dev/null
check "scheduled helper waits for Discord to close" test ! -s "$work/curl.log"
check "scheduled helper does not quit Discord" test -e "$work/running"
rm -f "$work/running"
printf 'REAL ASAR offline' > "$res/app.asar"
printf '%s' 'releases?per_page=100' > "$work/fail-download"
update >/dev/null
check "offline helper repairs Discord" grep -q 'REAL ASAR offline' "$res/byo-stream.app.asar"
check "offline helper keeps payload" cmp -s "$built/plugin.js" "$data/plugin.js"
check "offline helper keeps installed version" sh -c '[ "$(cat "$1/version")" != 0.1.10 ]' _ "$data"
rm -f "$work/fail-download" "$data/update-checked"
printf '\ncorruption' >> "$work/new-release/main.js"
check "checksum mismatch rejected" sh -c '! HOME="$1" PATH="$2:$PATH" NONINTERACTIVE=1 sh "$3/update.sh"' _ "$home" "$work/bin" "$data"
check "bad update preserves installed main" cmp -s "$built/main.js" "$data/main.js"
check "bad update preserves saved key" grep -q KEY_local "$data/config.json"
cp "$built/main.js" "$work/new-release/main.js"
rm -f "$data/update-checked"
: > "$work/open-on-download"
update > "$work/deferred.out"
check "update defers if Discord opens during download" grep -q 'deferred until it closes' "$work/deferred.out"
check "deferred update leaves current version" sh -c '[ "$(cat "$1/version")" != 0.1.10 ]' _ "$data"
check "deferred update can retry when Discord closes" test ! -e "$data/update-checked"
check "deferred update does not close Discord" test -e "$work/running"
rm -f "$work/running" "$work/open-on-download"
stale_lock "$data/.update-lock"
update > "$work/update.out"
check "helper selects numeric latest stable macOS version" grep -q '^0.1.10$' "$data/version"
check "helper keeps saved server and key" grep -q '"accessKey":"KEY_local","server":"https://streams.example.com"' "$data/config.json"
check "helper recovers abandoned update lock" lock_free "$data/.update-lock"
check "helper releases installer lock" lock_free "$data/.install-lock"
: > "$work/curl.log"
update >/dev/null
check "release check runs at most daily" test ! -s "$work/curl.log"
rm -f "$data/update-checked"
update >/dev/null
check "current release is not downloaded again" sh -c '! grep -q releases/download "$1"' _ "$work/curl.log"
HOME="$home" PATH="$work/bin:$PATH" NONINTERACTIVE=1 sh "$built/install.sh" --no-auto-update >/dev/null
check "opt out removes helper" test ! -e "$agent"
printf 'REAL ASAR v2' > "$res/app.asar"
HOME="$home" PATH="$work/bin:$PATH" NONINTERACTIVE=1 sh "$built/install.sh" --uninstall >/dev/null

# Double-clicking Install.command in an unpacked release: it asks in the terminal.
# A pseudo-terminal types the answers, including a pasted key with stray spaces.
mkdir -p "$work/release"
cp "$built/"*.js "$built/"*.sh "$root/installer/wrappers/Install.command" "$work/release/"
HOME="$home" PATH="$work/bin:$PATH" python3 "$root/test/answer-prompts.py" "streams.example.com| KEY_typed " \
  sh "$work/release/Install.command" > "$work/prompt.out" 2>&1
check "Install.command asks for the server" grep -q 'Server address' "$work/prompt.out"
check "Install.command asks for the key" grep -q 'Access key' "$work/prompt.out"
check "typed answers are stored" grep -q '"accessKey":"KEY_typed","server":"https://streams.example.com"' "$data/config.json"
check "Install.command installs" grep -q 'byo-stream.app.asar' "$res/app/index.js"
run --uninstall >/dev/null

# Cleaning up without any install must not disturb Discord.
run --uninstall >/dev/null
check "uninstalling twice is harmless" grep -q 'REAL ASAR v2' "$res/app.asar"

# Removing Discord first must still allow removing its background helper and key.
run --server "$SERVER" KEY_remove >/dev/null
rm -rf "$home/Applications/Discord.app"
check "uninstall works after Discord is removed" run --uninstall
check "uninstall without Discord removes helper" test ! -e "$agent"
check "uninstall without Discord removes key" test ! -e "$data"

[ "$failures" = 0 ] && echo "ALL PASSED" || { echo "$failures FAILED"; exit 1; }
