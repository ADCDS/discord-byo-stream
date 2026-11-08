#!/bin/sh
# VCStream installer for macOS and Linux. Re-run it to update, or after a Discord
# update removes the hook.
#   curl -fsSL __VCSTREAM_SERVER__/dstream/dl/install.sh | sh -s -- <access-key>
#   curl -fsSL __VCSTREAM_SERVER__/dstream/dl/install.sh | sh -s -- --uninstall
# From an unpacked release, run it next to its files: sh install.sh <access-key>
set -eu

BASE_URL=__VCSTREAM_SERVER__/dstream/dl
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
ARG=${1:-}

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
  printf 'VCStream: %s\n' "$1" >&2
  reopen_closed
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
    {
      for base in /Applications "$HOME/Applications"; do
        for app in "Discord" "Discord PTB" "Discord Canary"; do printf '%s\n' "$base/$app.app"; done
      done
      # Copies elsewhere or renamed, if Spotlight knows them.
      mdfind "kMDItemCFBundleIdentifier == 'com.hnc.Discord*'" 2>/dev/null || true
    } | while IFS= read -r app; do
      dir="$app/Contents/Resources"
      if [ -e "$dir/app.asar" ] || [ -e "$dir/vcstream.app.asar" ]; then printf '%s\n' "$dir"; fi
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
      fail "${1%/Contents/Resources} belongs to another user account. Install VCStream from that account, or reinstall Discord for yours."
    fi
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

if [ -n "$CLOSED" ]; then
  reopen_closed
else
  printf 'Open Discord to finish.\n'
fi
