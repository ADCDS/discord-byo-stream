#!/bin/sh
# Double-click to install or update BYO Stream. Keep it next to the other files from the zip.
cd "$(dirname "$0")" || exit 1
sh ./install.sh
printf '\nYou can close this window now.\n'
