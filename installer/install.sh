#!/bin/sh
# BYO Stream __BYO_VERSION__ installer for macOS and Linux. Run it again to update, or after
# a Discord update removes the hook. It asks for anything not given:
#   curl -fsSL __BYO_PAYLOAD_URL__/install.sh | sh
#   curl -fsSL __BYO_PAYLOAD_URL__/install.sh | sh -s -- --server https://example.com <access-key>
#   curl -fsSL __BYO_PAYLOAD_URL__/install.sh | sh -s -- --uninstall
# From an unpacked release, run it next to its files: sh install.sh
set -eu

PAYLOAD_URL=__BYO_PAYLOAD_URL__
DEFAULT_SERVER=__BYO_DEFAULT_SERVER__
PAYLOAD="main.js plugin.js app-index.js audio-source.js linux-audio.js"

# Next to an unpacked release, use its files instead of downloading them.
LOCAL_DIR=
case "$0" in
  */install.sh|install.sh)
    dir=$(cd "$(dirname -- "$0")" && pwd)
    LOCAL_DIR=$dir
    for file in $PAYLOAD; do [ -f "$dir/$file" ] || LOCAL_DIR=; done
    ;;
esac

# macOS: the Discord apps this run closed, one path per line, to reopen at the end.
CLOSED=
reopen_closed() {
  [ -n "$CLOSED" ] || return 0
  old_ifs=$IFS; IFS='
'
  for app in $CLOSED; do open "$app" >/dev/null 2>&1 || true; done
  IFS=$old_ifs
  CLOSED=
}

# Never leave Discord closed because of a failure.
fail() {
  printf 'BYO Stream: %s\n' "$1" >&2
  reopen_closed
  exit 1
}

UNINSTALL=
SERVER=
KEY=
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --server) [ $# -ge 2 ] || fail "--server needs an address"; SERVER=$2; shift ;;
    --server=*) SERVER=${1#--server=} ;;
    -h|--help) printf 'Usage: sh install.sh [--server https://example.com] [access-key]\n       sh install.sh --uninstall\n'; exit 0 ;;
    -*) fail "unknown option $1" ;;
    *) [ -z "$KEY" ] || fail "unexpected argument $1"; KEY=$1 ;;
  esac
  shift
done

# Questions go to the terminal, which still works when this script arrives through a pipe.
# NONINTERACTIVE=1 never asks, for scripts.
has_tty() { [ -z "${NONINTERACTIVE:-}" ] && (: < /dev/tty) 2>/dev/null; }
ask() { # $1 = question, $2 = suggested answer
  has_tty || return 1
  if [ -n "$2" ]; then printf '%s [%s]: ' "$1" "$2" > /dev/tty; else printf '%s: ' "$1" > /dev/tty; fi
  IFS= read -r answer < /dev/tty || answer=
  [ -n "$answer" ] || answer=$2
  printf '%s' "$answer"
}

if [ -z "$UNINSTALL" ]; then
  # Downloaded from a server's own /dstream/dl, the installer is for that server.
  [ -n "$SERVER" ] || SERVER=$DEFAULT_SERVER
  if [ -z "$SERVER" ]; then
    SERVER=$(ask "Server address (from whoever gave you your access key)" "") ||
      fail "no server given. Usage: sh install.sh --server https://example.com <access-key>"
  fi
  # Accept "example.com" and trailing slashes, as people paste them.
  case "$SERVER" in http://*) fail "the server must use https://" ;; https://*) ;; ?*) SERVER="https://$SERVER" ;; esac
  SERVER=$(printf '%s' "$SERVER" | sed 's:/*$::')
  printf '%s' "$SERVER" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' || fail "\"$SERVER\" isn't a server address like https://example.com"
  if [ -z "$KEY" ]; then
    KEY=$(ask "Access key" "") || fail "no access key given. Usage: sh install.sh --server $SERVER <access-key>"
  fi
  KEY=$(printf '%s' "$KEY" | tr -d ' \r\n')
  case "$KEY" in
    "") fail "no access key given" ;;
    *[!A-Za-z0-9_-]*) fail "that access key has invalid characters. Copy it again, exactly as you got it." ;;
  esac
fi

# A wrong address or key fails here, before anything is changed.
check_server() {
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -H "Authorization: Bearer $KEY" "$SERVER/dstream/check" 2>/dev/null) || code=000
  case "$code" in
    200) ;;
    401) fail "$SERVER didn't accept that access key. Copy it again, exactly as you got it." ;;
    000) fail "couldn't reach $SERVER. Check the address and your internet connection." ;;
    *) fail "$SERVER doesn't look like a BYO Stream server (HTTP $code). Check the address." ;;
  esac
}

OS=$(uname -s)
case "$OS" in
  Darwin) DATA_DIR="$HOME/Library/Application Support/discord-byo-stream" ;;
  Linux) DATA_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/discord-byo-stream" ;;
  *) fail "unsupported system: $OS" ;;
esac

# Prints one resources folder per line, for every Discord channel installed.
find_resources() {
  if [ "$OS" = Darwin ]; then
    {
      for base in /Applications "$HOME/Applications"; do
        for app in "Discord" "Discord PTB" "Discord Canary"; do printf '%s\n' "$base/$app.app"; done
      done
      # Copies elsewhere or renamed, if Spotlight knows them.
      mdfind "kMDItemCFBundleIdentifier == 'com.hnc.Discord*'" 2>/dev/null || true
    } | while IFS= read -r app; do
      dir="$app/Contents/Resources"
      if [ -e "$dir/app.asar" ] || [ -e "$dir/byo-stream.app.asar" ]; then printf '%s\n' "$dir"; fi
    done | awk '!seen[$0]++'
  else
    for channel in discord discordptb discordcanary; do
      root="${XDG_CONFIG_HOME:-$HOME/.config}/$channel"
      # Only the newest version runs, and Discord's updater manages the rest.
      latest=$(ls -d "$root"/app-* 2>/dev/null | sort -V | tail -n 1) || true
      if [ -n "$latest" ] && [ -d "$latest/resources" ]; then printf '%s\n' "$latest/resources"; fi
    done
  fi
}

# Only this user's Discord: another logged-in user's copy isn't ours to close.
app_running() { pgrep -U "$(id -u)" -f "$1/Contents/MacOS/" >/dev/null 2>&1; }
linux_discord_running() { pgrep -U "$(id -u)" -x "Discord|DiscordPTB|DiscordCanary" >/dev/null 2>&1; }

close_discord() {
  if [ "$OS" != Darwin ]; then
    if linux_discord_running; then fail "Discord is running. Close it fully, then run this again."; fi
    return 0
  fi
  old_ifs=$IFS; IFS='
'
  for res in $RESOURCES; do
    app=${res%/Contents/Resources}
    app_running "$app" || continue
    name=$(basename "$app" .app)
    printf 'Closing %s...\n' "$name"
    CLOSED="$CLOSED$app
"
    osascript -e "tell application \"$name\" to quit" >/dev/null 2>&1 || true
    tries=0
    while app_running "$app" && [ "$tries" -lt 15 ]; do sleep 1; tries=$((tries + 1)); done
    # An if, not &&: under set -e a false && as the last command would end the script.
    if app_running "$app"; then fail "couldn't close $name. Quit it with Cmd+Q and run this again."; fi
  done
  IFS=$old_ifs
}

permission_help() {
  if [ "$OS" = Darwin ]; then
    if [ ! -O "$1" ]; then
      fail "${1%/Contents/Resources} belongs to another user account. Install BYO Stream from that account, or reinstall Discord for yours."
    fi
    fail "macOS blocked changes to Discord.app. Turn on your terminal app under System Settings > Privacy & Security > App Management, then run this again."
  fi
  fail "can't write to $1"
}

check_writable() {
  probe="$1/.byo-stream-probe"
  (: > "$probe") 2>/dev/null || permission_help "$1"
  rm -f "$probe"
}

hook() {
  res=$1

  # A live app.asar is always Discord's current app, so any preserved copy is stale.
  if [ -e "$res/app.asar" ]; then
    rm -f "$res/byo-stream.app.asar"
    mv "$res/app.asar" "$res/byo-stream.app.asar" || permission_help "$res"
  fi
  [ -e "$res/byo-stream.app.asar" ] || fail "no app.asar in $res"

  if ! { mkdir -p "$res/app" &&
         printf '{"main":"./index.js"}\n' > "$res/app/package.json" &&
         cp "$DATA_DIR/app-index.js" "$res/app/index.js"; }; then
    unhook "$res"
    fail "couldn't write the hook into $res. Discord was left unchanged."
  fi
  printf 'Hooked %s\n' "$res"
}

unhook() {
  res=$1
  rm -rf "$res/app"
  if [ -e "$res/byo-stream.app.asar" ] && [ ! -e "$res/app.asar" ]; then
    mv "$res/byo-stream.app.asar" "$res/app.asar" || permission_help "$res"
  fi
  rm -f "$res/byo-stream.app.asar"
}

RESOURCES=$(find_resources)
if [ -z "$RESOURCES" ]; then
  if [ "$OS" = Linux ]; then
    for sandboxed in /var/lib/flatpak/app/com.discordapp.Discord "$HOME/.local/share/flatpak/app/com.discordapp.Discord" /snap/discord; do
      if [ -d "$sandboxed" ]; then
        fail "only a Flatpak or Snap Discord is installed, and their files are read-only. Install Discord's .deb or .tar.gz from discord.com, open it once, then run this again."
      fi
    done
  fi
  fail "couldn't find Discord. Install it and open it once, then run this again."
fi

# Everything that can fail without touching Discord happens before closing it.
printf '%s\n' "$RESOURCES" | while IFS= read -r res; do check_writable "$res"; done || exit 1
if [ -z "$UNINSTALL" ]; then
  check_server
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  for file in $PAYLOAD; do
    if [ -n "$LOCAL_DIR" ]; then
      cp "$LOCAL_DIR/$file" "$DATA_DIR/$file.new" || fail "copying $file failed"
    else
      curl -fsSL --retry 2 "$PAYLOAD_URL/$file" -o "$DATA_DIR/$file.new" || fail "download of $file failed"
    fi
    [ -s "$DATA_DIR/$file.new" ] || fail "$file is empty"
    mv "$DATA_DIR/$file.new" "$DATA_DIR/$file"
  done
  # Both values were checked against strict patterns above, so they need no escaping.
  (umask 077; printf '{"accessKey":"%s","server":"%s"}\n' "$KEY" "$SERVER" > "$DATA_DIR/config.json")
fi

close_discord

if [ -n "$UNINSTALL" ]; then
  printf '%s\n' "$RESOURCES" | while IFS= read -r res; do unhook "$res"; done || fail "uninstall failed"
  rm -rf "$DATA_DIR"
  printf 'BYO Stream removed.\n'
else
  printf '%s\n' "$RESOURCES" | while IFS= read -r res; do hook "$res"; done || fail "install failed"
  printf 'BYO Stream installed for %s.\n' "$SERVER"
fi

if [ -n "$CLOSED" ]; then
  reopen_closed
else
  printf 'Open Discord to finish.\n'
fi
