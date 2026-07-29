#!/bin/sh
# Install primer.
#
#   curl -fsSL https://raw.githubusercontent.com/vedan/primer/main/install.sh | sh
#
# Puts a single file in ~/.local/bin. No Node, no npm, no build step. Nothing is
# installed system-wide and nothing needs sudo; removing it is `rm`.
#
# Set PRIMER_REPO to install from a fork, PRIMER_VERSION to pin a release.
set -eu

REPO="${PRIMER_REPO:-vedan/primer}"
VERSION="${PRIMER_VERSION:-latest}"
BIN_DIR="${PRIMER_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- what are we --

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os_tag=macos ;;
  Linux)  os_tag=linux ;;
  *) die "unsupported system: $os. Primer ships binaries for macOS, Linux, and Windows." ;;
esac
case "$arch" in
  x86_64|amd64) arch_tag=x64 ;;
  arm64|aarch64) arch_tag=arm64 ;;
  *) die "unsupported processor: $arch" ;;
esac
asset="primer-${os_tag}-${arch_tag}"

# ------------------------------------------------------------------- download --

# PRIMER_URL points the installer at a mirror, an internal file server, or a
# locally built binary. It is also how the success path gets tested without
# publishing a release.
if [ -n "${PRIMER_URL:-}" ]; then
  url="$PRIMER_URL"
elif [ "$VERSION" = latest ]; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$asset"
fi

command -v curl >/dev/null 2>&1 || die "curl is required"
mkdir -p "$BIN_DIR"

tmp=$(mktemp -d)
# Leave nothing behind if the download or the checksum fails partway.
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading primer ($os_tag/$arch_tag)..."
curl -fsSL "$url" -o "$tmp/primer" || die "could not download $url
If this is a fresh checkout with no releases yet, build from source instead:
  npm install && npm run build && npm link"

# Verify against the checksum published beside the binary. A silently corrupted
# 90MB download otherwise shows up much later as an unreadable crash.
if curl -fsSL "$url.sha256" -o "$tmp/primer.sha256" 2>/dev/null; then
  expected=$(cut -d' ' -f1 < "$tmp/primer.sha256")
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp/primer" | cut -d' ' -f1)
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$tmp/primer" | cut -d' ' -f1)
  else
    actual=""
  fi
  if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
    die "checksum mismatch — refusing to install.
  expected $expected
  got      $actual"
  fi
  [ -n "$actual" ] && say "Checksum verified."
else
  say "Note: no published checksum for this release; skipping verification."
fi

chmod +x "$tmp/primer"
# Replace in one step. Overwriting in place breaks a running copy on some systems.
mv -f "$tmp/primer" "$BIN_DIR/primer"

# --------------------------------------------------------------------- report --

say ""
say "primer installed to $BIN_DIR/primer"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say ""
    say "$BIN_DIR is not on your PATH. Add this to your shell profile:"
    say "  export PATH=\"\$PATH:$BIN_DIR\""
    ;;
esac

say ""
say "Next:"
say "  primer start        set up your first child, and open the parent page"
say ""
say "Primer drives the tutor through Claude Code, so install that too if you"
say "have not: https://claude.com/claude-code"
