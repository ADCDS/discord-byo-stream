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
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
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
if [ -n "\$status" ]; then
  case "\$url" in */dstream/check) ;; *) printf 404; exit 0 ;; esac
  case "\$auth" in *KEY_bad) printf 401 ;; *) printf 200 ;; esac
  exit 0
fi
cp "$built/\${url##*/}" "\$out"
EOF
cat > "$work/bin/pgrep" <<EOF
#!/bin/sh
[ -e "$work/running" ]
EOF
cat > "$work/bin/osascript" <<EOF
#!/bin/sh
rm -f "$work/running"
EOF
cat > "$work/bin/open" <<EOF
#!/bin/sh
: > "$work/reopened"
EOF
chmod +x "$work/bin/"*

home="$work/home"
res="$home/Applications/Discord.app/Contents/Resources"
data="$home/Library/Application Support/discord-byo-stream"
mkdir -p "$res"
printf 'REAL ASAR v1' > "$res/app.asar"
# Alone, the installer downloads its files (through the curl stub).
cp "$built/install.sh" "$work/install.sh"
# The installer may not ask anything here, so it needs everything as arguments.
run() { HOME="$home" PATH="$work/bin:$PATH" NONINTERACTIVE=1 sh "$work/install.sh" "$@" < /dev/null; }
fails() { ! run "$@"; }

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

run --server="$SERVER" KEY_new >/dev/null
check "re-running keeps the original" grep -q 'REAL ASAR v1' "$res/byo-stream.app.asar"
check "re-running updates the key" grep -q 'KEY_new' "$data/config.json"

printf 'REAL ASAR v2' > "$res/app.asar"
run --server "$SERVER" KEY_new >/dev/null
check "Discord update: newer app wins" grep -q 'REAL ASAR v2' "$res/byo-stream.app.asar"

run --uninstall >/dev/null
check "uninstall restores the app" grep -q 'REAL ASAR v2' "$res/app.asar"
check "uninstall removes the preserved copy" test ! -e "$res/byo-stream.app.asar"
check "uninstall removes the hook" test ! -e "$res/app"
check "uninstall removes data and key" test ! -e "$data"

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
HOME="$home" PATH="$work/bin:$PATH" NONINTERACTIVE=1 sh "$built/install.sh" --uninstall >/dev/null

# Double-clicking Install.command in an unpacked release: it asks in the terminal.
# A pseudo-terminal types the answers, including a pasted key with stray spaces.
mkdir -p "$work/release"
cp "$built/"*.js "$built/install.sh" "$root/installer/wrappers/Install.command" "$work/release/"
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

[ "$failures" = 0 ] && echo "ALL PASSED" || { echo "$failures FAILED"; exit 1; }
