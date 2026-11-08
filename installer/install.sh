#!/bin/sh
# VCStream installer for macOS and Linux. Re-run it to update, or after a Discord
# update removes the hook.
#   curl -fsSL __VCSTREAM_SERVER__/dstream/dl/install.sh | sh -s -- <access-key>
#   curl -fsSL __VCSTREAM_SERVER__/dstream/dl/install.sh | sh -s -- --uninstall
# From an unpacked release, run it next to its files: sh install.sh <access-key>
set -eu

BASE_URL=__VCSTREAM_SERVER__/dstream/dl
PAYLOAD="main.js plugin.js app-index.js linux-audio.js"

# Next to an unpacked release, use its files instead of downloading them.
LOCAL_DIR=
case "$0" in
  */install.sh|install.sh)
    dir=$(cd "$(dirname -- "$0")" && pwd)
    LOCAL_DIR=$dir
    for file in $PAYLOAD; do [ -f "$dir/$file" ] || LOCAL_DIR=; done
    ;;
esac
ARG=${1:-}

RESTART=0
# Never leave Discord closed because of a failure.
fail() {
  printf 'VCStream: %s\n' "$1" >&2
  if [ "$RESTART" = 1 ]; then open -a Discord >/dev/null 2>&1 || true; fi
  exit 1
}

case "$ARG" in
  --uninstall) ;;
  "") fail "missing access key. Usage: sh install.sh <access-key>" ;;
  *[!A-Za-z0-9_-]*) fail "that access key has invalid characters" ;;
esac

OS=$(uname -s)
case "$OS" in
  Darwin) DATA_DIR="$HOME/Library/Application Support/VCStream" ;;
  Linux) DATA_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/VCStream" ;;
  *) fail "unsupported system: $OS" ;;
esac

# Prints one resources folder per line, for every Discord channel installed.
find_resources() {
  if [ "$OS" = Darwin ]; then
    for base in /Applications "$HOME/Applications"; do
      for app in "Discord" "Discord PTB" "Discord Canary"; do
        dir="$base/$app.app/Contents/Resources"
        if [ -e "$dir/app.asar" ] || [ -e "$dir/vcstream.app.asar" ]; then printf '%s\n' "$dir"; fi
      done
    done
  else
    for channel in discord discordptb discordcanary; do
      root="${XDG_CONFIG_HOME:-$HOME/.config}/$channel"
      # Only the newest version runs, and Discord's updater manages the rest.
      latest=$(ls -d "$root"/app-* 2>/dev/null | sort -V | tail -n 1) || true
      if [ -n "$latest" ] && [ -d "$latest/resources" ]; then printf '%s\n' "$latest/resources"; fi
    done
  fi
}

discord_running() { pgrep -x "Discord|Discord PTB|Discord Canary|DiscordPTB|DiscordCanary" >/dev/null 2>&1; }

close_discord() {
  discord_running || return 0
  if [ "$OS" = Darwin ]; then
    printf 'Closing Discord...\n'
    osascript -e 'quit app "Discord"' >/dev/null 2>&1 || true
    tries=0
    while discord_running && [ "$tries" -lt 15 ]; do sleep 1; tries=$((tries + 1)); done
    RESTART=1
    # An if, not &&: under set -e a false && as the last command would end the script.
    if discord_running; then fail "couldn't close Discord. Quit it with Cmd+Q and run this again."; fi
  else
    fail "Discord is running. Close it fully, then run this again."
  fi
}

permission_help() {
  if [ "$OS" = Darwin ]; then
    fail "macOS blocked changes to Discord.app. Turn on your terminal app under System Settings > Privacy & Security > App Management, then run this again."
  fi
  fail "can't write to $1"
}

check_writable() {
  probe="$1/.vcstream-probe"
  (: > "$probe") 2>/dev/null || permission_help "$1"
  rm -f "$probe"
}

hook() {
  res=$1

  # A live app.asar is always Discord's current app, so any preserved copy is stale.
  if [ -e "$res/app.asar" ]; then
    rm -f "$res/vcstream.app.asar"
    mv "$res/app.asar" "$res/vcstream.app.asar" || permission_help "$res"
  fi
  [ -e "$res/vcstream.app.asar" ] || fail "no app.asar in $res"

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
  if [ -e "$res/vcstream.app.asar" ] && [ ! -e "$res/app.asar" ]; then
    mv "$res/vcstream.app.asar" "$res/app.asar" || permission_help "$res"
  fi
  rm -f "$res/vcstream.app.asar"
}

RESOURCES=$(find_resources)
if [ -z "$RESOURCES" ]; then
  if [ -d /var/lib/flatpak/app/com.discordapp.Discord ]; then
    fail "this is a system-wide Flatpak Discord, whose files are read-only. Use tools/run-in-flatpak-discord.mjs instead."
  fi
  fail "couldn't find Discord. Install it and open it once, then run this again."
fi

# Everything that can fail without touching Discord happens before closing it.
printf '%s\n' "$RESOURCES" | while IFS= read -r res; do check_writable "$res"; done || exit 1
if [ "$ARG" != --uninstall ]; then
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  for file in $PAYLOAD; do
    if [ -n "$LOCAL_DIR" ]; then
      cp "$LOCAL_DIR/$file" "$DATA_DIR/$file.new" || fail "copying $file failed"
    else
      curl -fsSL --retry 2 "$BASE_URL/$file" -o "$DATA_DIR/$file.new" || fail "download of $file failed"
    fi
    [ -s "$DATA_DIR/$file.new" ] || fail "$file is empty"
    mv "$DATA_DIR/$file.new" "$DATA_DIR/$file"
  done
  (umask 077; printf '{"accessKey":"%s"}\n' "$ARG" > "$DATA_DIR/config.json")
fi

close_discord

if [ "$ARG" = --uninstall ]; then
  printf '%s\n' "$RESOURCES" | while IFS= read -r res; do unhook "$res"; done || fail "uninstall failed"
  rm -rf "$DATA_DIR"
  printf 'VCStream removed.\n'
else
  printf '%s\n' "$RESOURCES" | while IFS= read -r res; do hook "$res"; done || fail "install failed"
  printf 'VCStream installed.\n'
fi

if [ "$RESTART" = 1 ]; then
  open -a Discord
else
  printf 'Open Discord to finish.\n'
fi
