#!/bin/sh
# Double-click to remove BYO Stream from Discord.
cd "$(dirname "$0")" || exit 1
sh ./install.sh --uninstall
printf '\nYou can close this window now.\n'
