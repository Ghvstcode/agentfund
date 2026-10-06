#!/bin/sh
# AgentFund worker installer.
#
#   curl -fsSL https://raw.githubusercontent.com/agentfund/agentfund/main/scripts/install.sh | sh
#
# Detects OS and architecture, downloads the release archive and its checksum
# file from GitHub, verifies the SHA-256, and installs the `agentfund` binary.
#
# Environment:
#   AGENTFUND_REPO          GitHub repository to download from   (default: agentfund/agentfund)
#   AGENTFUND_VERSION       version to install, e.g. 0.3.1 or v0.3.1 (default: latest release)
#   AGENTFUND_INSTALL_DIR   where to put the binary (default: ~/.local/bin, or /usr/local/bin when run as root)
#   AGENTFUND_BASE_URL      download base URL override (mirrors, tests); the script fetches
#                           $AGENTFUND_BASE_URL/agentfund_<version>_<os>_<arch>.tar.gz and
#                           $AGENTFUND_BASE_URL/agentfund_<version>_checksums.txt (requires AGENTFUND_VERSION)
set -eu

BINARY=agentfund
REPO="${AGENTFUND_REPO:-agentfund/agentfund}"
VERSION="${AGENTFUND_VERSION:-}"
BASE_URL="${AGENTFUND_BASE_URL:-}"

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

fetch() { # fetch <url> <output-file>
  if have curl; then
    curl -fsSL --proto '=https,http,file' -o "$2" "$1"
  elif have wget; then
    wget -q -O "$2" "$1"
  else
    die "need curl or wget"
  fi
}

sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif have shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif have openssl; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    die "need sha256sum, shasum or openssl to verify the download"
  fi
}

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "unsupported operating system: $(uname -s) (linux and darwin are supported)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *) die "unsupported architecture: $(uname -m) (amd64 and arm64 are supported)" ;;
esac

case "$REPO" in
  */*) ;;
  *) die "AGENTFUND_REPO must look like owner/name, got '$REPO'" ;;
esac

if [ -z "$VERSION" ]; then
  [ -z "$BASE_URL" ] || die "AGENTFUND_BASE_URL requires AGENTFUND_VERSION"
  tmp_latest="$(mktemp)"
  fetch "https://api.github.com/repos/${REPO}/releases/latest" "$tmp_latest" ||
    { rm -f "$tmp_latest"; die "cannot determine the latest release of ${REPO}; set AGENTFUND_VERSION"; }
  VERSION="$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp_latest" | head -n 1)"
  rm -f "$tmp_latest"
  [ -n "$VERSION" ] || die "cannot determine the latest release of ${REPO}; set AGENTFUND_VERSION"
fi
TAG="v${VERSION#v}"
VERSION="${VERSION#v}"
case "$VERSION" in
  *[!0-9A-Za-z.+-]* | '') die "refusing odd version string '$VERSION'" ;;
esac

if [ -z "$BASE_URL" ]; then
  BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"
fi
ARCHIVE="${BINARY}_${VERSION}_${OS}_${ARCH}.tar.gz"
CHECKSUMS="${BINARY}_${VERSION}_checksums.txt"

if [ -n "${AGENTFUND_INSTALL_DIR:-}" ]; then
  DEST="$AGENTFUND_INSTALL_DIR"
elif [ "$(id -u)" = 0 ]; then
  DEST=/usr/local/bin
else
  DEST="${HOME}/.local/bin"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

say "Downloading ${ARCHIVE} (${TAG}) from ${BASE_URL}"
fetch "${BASE_URL}/${ARCHIVE}" "${WORK}/${ARCHIVE}" || die "download failed: ${BASE_URL}/${ARCHIVE}"
fetch "${BASE_URL}/${CHECKSUMS}" "${WORK}/${CHECKSUMS}" || die "download failed: ${BASE_URL}/${CHECKSUMS}"

WANT="$(awk -v f="$ARCHIVE" '$2 == f || $2 == "*" f {print $1}' "${WORK}/${CHECKSUMS}" | head -n 1)"
[ -n "$WANT" ] || die "${CHECKSUMS} has no entry for ${ARCHIVE}"
GOT="$(sha256_of "${WORK}/${ARCHIVE}")"
[ "$WANT" = "$GOT" ] || die "checksum mismatch for ${ARCHIVE}: expected ${WANT}, got ${GOT}"
say "Checksum OK (${GOT})"

mkdir "${WORK}/x"
tar -xzf "${WORK}/${ARCHIVE}" -C "${WORK}/x" "$BINARY" 2>/dev/null || tar -xzf "${WORK}/${ARCHIVE}" -C "${WORK}/x"
[ -f "${WORK}/x/${BINARY}" ] || die "the archive does not contain ${BINARY}"
chmod 0755 "${WORK}/x/${BINARY}"

mkdir -p "$DEST" 2>/dev/null || true
if [ -w "$DEST" ]; then
  mv -f "${WORK}/x/${BINARY}" "${DEST}/${BINARY}"
elif have sudo; then
  say "Installing to ${DEST} needs elevated permissions (sudo)"
  sudo mkdir -p "$DEST"
  sudo install -m 0755 "${WORK}/x/${BINARY}" "${DEST}/${BINARY}"
else
  die "cannot write to ${DEST}; set AGENTFUND_INSTALL_DIR to a writable directory"
fi

say "Installed ${DEST}/${BINARY}"
"${DEST}/${BINARY}" version || true
case ":${PATH}:" in
  *":${DEST}:"*) ;;
  *) say "Note: ${DEST} is not on your PATH. Add it, e.g.:  export PATH=\"${DEST}:\$PATH\"" ;;
esac
say "Next: ${BINARY} login <server-url>   then   ${BINARY} approve <server-url>/<project>"
