#!/bin/sh
# Prints the GitHub release notes for one platform.
#   tools/release-notes.sh linux|macos|windows <version> [owner/repo]
set -eu
platform=$1 version=$2 repo=${3:-ADCDS/discord-byo-stream}
url="https://github.com/$repo/releases/download/$platform-v$version"
name="discord-byo-stream-$platform-v$version"
guide="https://github.com/$repo#readme"
guide_pt="https://github.com/$repo/blob/main/README.pt-BR.md"
case "$platform" in
  windows)
    cat <<MD
**Download [$name.zip]($url/$name.zip)**, extract it (right-click, *Extract All*) and double-click **Install.cmd**. Type the server address and access key you were given.

Or paste this into PowerShell:
\`\`\`powershell
irm $url/install.ps1 | iex
\`\`\`
MD
    ;;
  macos)
    cat <<MD
**Download [$name.zip]($url/$name.zip)** and double-click **Install.command**. Type the server address and access key you were given. macOS asks you to allow it the first time: the guide shows where.

Or paste this into Terminal:
\`\`\`sh
curl -fsSL $url/install.sh | sh
\`\`\`
MD
    ;;
  linux)
    cat <<MD
Close Discord and paste this into a terminal. It asks for the server address and access key you were given:
\`\`\`sh
curl -fsSL $url/install.sh | sh
\`\`\`
Or download [$name.tar.gz]($url/$name.tar.gz), unpack it and run \`sh install.sh\`. Needs the official Discord (.deb or .tar.gz); Flatpak and Snap can't be hooked.
MD
    ;;
esac
cat <<MD

Step-by-step guide: [English]($guide) · [Português (Brasil)]($guide_pt). Run the installer again after a Discord update. \`SHA256SUMS.txt\` lists the checksums of every file.
MD
