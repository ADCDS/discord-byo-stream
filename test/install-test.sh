#!/bin/sh
# Runs the built install.sh (dist/public, so build first) against a fake macOS home with
# uname, curl and friends stubbed. Discord's real layout was taken from its DMG. Runs on
# Linux and on macOS itself.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

check() { # name, then a command that must succeed
  name=$1; shift
  if "$@" >/dev/null 2>&1; then echo "PASS  $name"; else echo "FAIL  $name"; failures=$((failures + 1)); fi
}

mkdir -p "$work/bin"
cat > "$work/bin/uname" <<'EOF'
#!/bin/sh
echo Darwin
EOF
cat > "$work/bin/curl" <<EOF
#!/bin/sh
for last; do :; done
while [ \$# -gt 0 ]; do
  case "\$1" in -o) out=\$2; shift ;; https*) url=\$1 ;; esac
  shift
done
cp "$root/dist/public/\${url##*/}" "\$out"
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
data="$home/Library/Application Support/VCStream"
mkdir -p "$res"
printf 'REAL ASAR v1' > "$res/app.asar"
# Alone, the installer downloads its files (through the curl stub).
cp "$root/dist/public/install.sh" "$work/install.sh"
run() { HOME="$home" PATH="$work/bin:$PATH" sh "$work/install.sh" "$@"; }

check "rejects a missing key" sh -c '! HOME="$1" PATH="$2/bin:$PATH" sh "$2/install.sh"' _ "$home" "$work"
check "rejects a malformed key" sh -c '! HOME="$1" PATH="$2/bin:$PATH" sh "$2/install.sh" "bad key;rm"' _ "$home" "$work"
check "bad key changed nothing" grep -q 'REAL ASAR v1' "$res/app.asar"

: > "$work/running"
run KEY_abc-123 >/dev/null
check "install succeeds and closes Discord" test ! -e "$work/running"
check "reopens Discord afterwards" test -e "$work/reopened"
check "original app preserved" grep -q 'REAL ASAR v1' "$res/vcstream.app.asar"
check "live app.asar moved aside" test ! -e "$res/app.asar"
check "hook entry written" grep -q 'vcstream.app.asar' "$res/app/index.js"
check "hook package.json written" grep -q '"main":"./index.js"' "$res/app/package.json"
check "payload downloaded" test -s "$data/plugin.js"
check "key stored" grep -q 'KEY_abc-123' "$data/config.json"
check "config is private" sh -c '[ "$(ls -l "$1" | cut -c1-10)" = "-rw-------" ]' _ "$data/config.json"

run KEY_new >/dev/null
check "re-running keeps the original" grep -q 'REAL ASAR v1' "$res/vcstream.app.asar"
check "re-running updates the key" grep -q 'KEY_new' "$data/config.json"

printf 'REAL ASAR v2' > "$res/app.asar"
run KEY_new >/dev/null
check "Discord update: newer app wins" grep -q 'REAL ASAR v2' "$res/vcstream.app.asar"

run --uninstall >/dev/null
check "uninstall restores the app" grep -q 'REAL ASAR v2' "$res/app.asar"
check "uninstall removes the preserved copy" test ! -e "$res/vcstream.app.asar"
check "uninstall removes the hook" test ! -e "$res/app"
check "uninstall removes data and key" test ! -e "$data"

# macOS App Management makes Discord.app unwritable: nothing may change, and
# Discord must not be left closed.
chmod a-w "$res"
: > "$work/running"; rm -f "$work/reopened"
run KEY_x >/dev/null 2>&1
check "blocked install fails without closing Discord" test -e "$work/running"
check "blocked install leaves the app alone" grep -q 'REAL ASAR v2' "$res/app.asar"
check "blocked install writes no hook" test ! -e "$res/app"
chmod u+w "$res"
rm -f "$work/running"

# Next to an unpacked release, it uses those files and never downloads.
printf '#!/bin/sh\nexit 7\n' > "$work/bin/curl"
HOME="$home" PATH="$work/bin:$PATH" sh "$root/dist/public/install.sh" KEY_local >/dev/null
check "release folder install needs no download" grep -q 'KEY_local' "$data/config.json"
check "release folder payload copied" test -s "$data/linux-audio.js"
HOME="$home" PATH="$work/bin:$PATH" sh "$root/dist/public/install.sh" --uninstall >/dev/null

# Cleaning up without any install must not disturb Discord.
run --uninstall >/dev/null
check "uninstalling twice is harmless" grep -q 'REAL ASAR v2' "$res/app.asar"

[ "$failures" = 0 ] && echo "ALL PASSED" || { echo "$failures FAILED"; exit 1; }
