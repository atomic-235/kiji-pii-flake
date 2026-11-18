#!/usr/bin/env bash
# Install the opencode-kiji-pii plugin into the user's OpenCode plugin directory.
#
#   curl -fsSL https://raw.githubusercontent.com/atomic-235/kiji-pii-flake/main/install-plugin.sh | bash
#   ./install-plugin.sh uninstall
set -euo pipefail

repo="atomic-235/kiji-pii-flake"
ref="${KIJI_PII_REF:-main}"
target_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
target="$target_dir/kiji-pii.ts"

usage() {
  echo "usage: $0 [install|uninstall]" >&2
  exit 1
}

uninstall() {
  if [ -f "$target" ]; then
    rm -f "$target"
    echo "Removed $target"
  else
    echo "Nothing to remove at $target"
  fi
}

install() {
  mkdir -p "$target_dir"
  curl -fsSL "https://raw.githubusercontent.com/$repo/$ref/plugin/index.ts" -o "$target"
  echo "Installed $target"
  echo
  echo "Next:"
  echo "  1. Start the Kiji PII service:  nix run github:$repo"
  echo "  2. Restart OpenCode:            opencode service restart"
  echo "  3. Enable masking:              /kiji on   (inside OpenCode)"
  echo
  echo "Until the service is running the plugin is a no-op: requests go out unmasked."
}

case "${1:-install}" in
  install) install ;;
  uninstall | remove) uninstall ;;
  -h | --help | help) usage ;;
  *) usage ;;
esac
