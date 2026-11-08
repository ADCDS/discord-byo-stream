#!/usr/bin/env bash
# Manage per-friend access keys.
#   tools/keys.sh add <name>      create or rotate a key, stored in .keys/<name>.key
#   tools/keys.sh invite <name>   print install instructions with that key, to send them
#   tools/keys.sh revoke <name>   remove it from the server and locally
# Only the SHA-256 of a key goes to the server (sshHost and serverDir in
# byo-stream.config.json). Changes apply immediately.
set -euo pipefail
action=${1:-}; name=${2:-}
[[ "$name" =~ ^[a-z0-9_-]{1,32}$ ]] || { echo "usage: $0 add|invite|revoke <name: a-z 0-9 _ ->" >&2; exit 2; }
root=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$root/byo-stream.config.json" ] || { echo "copy byo-stream.config.example.json to byo-stream.config.json and fill it in" >&2; exit 2; }
config() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$root/byo-stream.config.json" "$1"; }
SSH_HOST=$(config sshHost)
KEYS_FILE="$(config serverDir)/data/keys.json"

update_server() { # $1=name $2=hash (empty to revoke)
  ssh -o BatchMode=yes "$SSH_HOST" python3 - "$1" "${2:-}" "$KEYS_FILE" <<'PY'
import json, os, sys
name, digest, path = sys.argv[1], sys.argv[2], sys.argv[3]
keys = json.load(open(path)) if os.path.exists(path) else {}
keys = {k: v for k, v in keys.items() if v != name}
if digest:
    keys[digest] = name
tmp = path + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(keys, f, indent=1)
os.replace(tmp, path)
print("server keys:", sorted(keys.values()))
PY
}

case "$action" in
  add)
    umask 077; mkdir -p "$root/.keys"
    key=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
    digest=$(printf '%s' "$key" | sha256sum | cut -d' ' -f1)
    update_server "$name" "$digest"
    printf '%s\n' "$key" > "$root/.keys/$name.key"
    echo "saved $root/.keys/$name.key. To send it: $0 invite $name"
    ;;
  invite)
    [ -f "$root/.keys/$name.key" ] || { echo "no key for $name; run: $0 add $name" >&2; exit 1; }
    key=$(cat "$root/.keys/$name.key")
    server=$(config server)
    version=$(cd "$root/plugin" && node -p "require('./package.json').version")
    releases="https://github.com/ADCDS/discord-byo-stream/releases/download"
    cat <<TXT
BYO Stream: screen sharing in Discord through my server.
Guide: https://github.com/ADCDS/discord-byo-stream (Português: README.pt-BR.md)

Server: $server
Access key: $key

Windows: download $releases/windows-v$version/discord-byo-stream-windows-v$version.zip
  extract it, double-click Install.cmd and paste the server and key above.
macOS, in Terminal:
  curl -fsSL $releases/macos-v$version/install.sh | sh -s -- --server $server $key
Linux, in a terminal, with Discord closed:
  curl -fsSL $releases/linux-v$version/install.sh | sh -s -- --server $server $key
TXT
    ;;
  revoke)
    update_server "$name" ""
    rm -f "$root/.keys/$name.key"
    ;;
  *) echo "usage: $0 add|invite|revoke <name>" >&2; exit 2 ;;
esac
