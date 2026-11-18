#!/usr/bin/env sh
# Install the opencode-kiji-pii plugin.
#
#   curl -fsSL https://raw.githubusercontent.com/atomic-235/kiji-pii-flake/main/install-plugin.sh | sh
#   ./install-plugin.sh uninstall
#
# Copies one file into ~/.config/opencode/plugins/. No config edits, no build,
# no package manager, no Nix.
set -eu

repo="atomic-235/kiji-pii-flake"
ref="${KIJI_PII_REF:-main}"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
plugins_dir="$config_dir/plugins"
target="$plugins_dir/kiji-pii.ts"

cleanup_dir=""
cleanup() {
  [ -n "$cleanup_dir" ] && [ -d "$cleanup_dir" ] && rm -rf "$cleanup_dir"
  return 0
}
trap cleanup EXIT

usage() {
  echo "usage: $0 [install|uninstall]" >&2
  exit 1
}

uninstall() {
  if [ -f "$target" ]; then
    rm -f "$target"
    echo "Removed $target"
    echo "Restart OpenCode to unload it: opencode service restart"
  else
    echo "Nothing to remove at $target"
  fi
}

download() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    echo "ERROR: curl or wget is required" >&2
    exit 1
  fi
}

install() {
  here=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || pwd)

  if [ -f "$here/plugin/index.ts" ]; then
    source_file="$here/plugin/index.ts"
  else
    cleanup_dir="${TMPDIR:-/tmp}/kiji-pii-$$"
    mkdir -p "$cleanup_dir"
    archive="$cleanup_dir/source.tar.gz"
    echo "Downloading opencode-kiji-pii from github.com/$repo"
    download "https://github.com/$repo/archive/refs/heads/$ref.tar.gz" "$archive"
    tar -xzf "$archive" -C "$cleanup_dir"
    source_dir=$(find "$cleanup_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)
    source_file="$source_dir/plugin/index.ts"
    if [ ! -f "$source_file" ]; then
      echo "ERROR: downloaded archive did not contain plugin/index.ts" >&2
      exit 1
    fi
  fi

  mkdir -p "$plugins_dir"
  cp "$source_file" "$target"
  echo "Installed $target"
  echo
  echo "Next:"
  echo "  1. Start the Kiji PII service:"
  echo "       podman run -d --rm --name kiji-pii -p 127.0.0.1:8788:8788 ghcr.io/atomic-235/kiji-pii:latest"
  echo "     or with Nix:"
  echo "       nix run github:$repo"
  echo "  2. Restart OpenCode:  opencode service restart"
  echo "  3. Enable masking:    /kiji on"
  echo
  echo "With no service listening the plugin is a no-op: requests go out unmasked."
}

case "${1:-install}" in
  install) install ;;
  uninstall | remove) uninstall ;;
  -h | --help | help) usage ;;
  *) usage ;;
esac
