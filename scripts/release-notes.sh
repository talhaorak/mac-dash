#!/usr/bin/env bash
# Prints the CHANGELOG.md section of one version: scripts/release-notes.sh 1.2.0
set -euo pipefail
version="${1:?usage: release-notes.sh <version>}"
awk -v v="$version" '
  $0 ~ "^## \\[" v "\\]" { found = 1; next }
  found && /^## \[/ { exit }
  found { print }
' "$(dirname "$0")/../CHANGELOG.md" | sed -e '/./,$!d'
