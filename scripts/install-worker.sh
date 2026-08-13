#!/usr/bin/env bash
set -euo pipefail

# REQUIRED BEFORE PUBLISHING: replace this placeholder or set TALOS_GITHUB_REPO.
REPO="${TALOS_GITHUB_REPO:-ChronoAIProject/talos}"
VERSION="latest"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || { echo "--version requires worker-vX.Y.Z" >&2; exit 1; }
      VERSION="$2"
      shift 2
      ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

[[ "$REPO" != "OWNER/talos" ]] || { echo "Talos installer REPO is not configured. Set TALOS_GITHUB_REPO=owner/repository or update scripts/install-worker.sh before publishing." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js 22+ is required. Install Node.js, then rerun this installer." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required. Install npm with Node.js, then rerun this installer." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required." >&2; exit 1; }

NODE_MAJOR="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] && (( NODE_MAJOR >= 22 )) || { echo "Node.js 22+ is required; found $(node --version)." >&2; exit 1; }

case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux) OS="linux" ;;
  *) echo "This installer supports macOS and Linux. Windows installation is documented in docs/WORKER.md." >&2; exit 1 ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64|arm64|aarch64) ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

if [[ "$VERSION" == "latest" ]]; then
  RELEASE_JSON="$(curl --fail --silent --show-error "https://api.github.com/repos/${REPO}/releases?per_page=100")"
  VERSION="$(printf '%s' "$RELEASE_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d).find(x=>x.tag_name.startsWith('worker-v'));if(!r)throw new Error('no worker-v release found');process.stdout.write(r.tag_name)})")"
fi
[[ "$VERSION" == worker-v* ]] || { echo "Version must use the worker-vX.Y.Z tag format." >&2; exit 1; }

ARTIFACT_VERSION="${VERSION#worker-v}"
ARTIFACT="talos-worker-${ARTIFACT_VERSION}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${ARTIFACT}"
INSTALL_ROOT="${HOME}/.talos-worker"
VERSION_DIR="${INSTALL_ROOT}/versions/${VERSION}"
BIN_DIR="${HOME}/.local/bin"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "Installing Talos worker ${VERSION} for ${OS}/${ARCH}"
curl --fail --location --silent --show-error "$URL" -o "${TEMP_DIR}/${ARTIFACT}"
curl --fail --location --silent --show-error "https://github.com/${REPO}/releases/download/${VERSION}/SHA256SUMS" -o "${TEMP_DIR}/SHA256SUMS"
EXPECTED_SHA="$(awk -v artifact="$ARTIFACT" '$2 == artifact { print $1 }' "${TEMP_DIR}/SHA256SUMS")"
[[ -n "$EXPECTED_SHA" ]] || { echo "SHA256SUMS does not contain ${ARTIFACT}." >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA="$(sha256sum "${TEMP_DIR}/${ARTIFACT}" | awk '{ print $1 }')"
else
  ACTUAL_SHA="$(shasum -a 256 "${TEMP_DIR}/${ARTIFACT}" | awk '{ print $1 }')"
fi
[[ "$EXPECTED_SHA" == "$ACTUAL_SHA" ]] || { echo "Checksum verification failed for ${ARTIFACT}." >&2; exit 1; }
mkdir -p "$VERSION_DIR" "$BIN_DIR"
tar -xzf "${TEMP_DIR}/${ARTIFACT}" -C "$TEMP_DIR"
cp -R "${TEMP_DIR}/talos-worker/." "$VERSION_DIR/"
(cd "$VERSION_DIR" && npm install --omit=dev)
ln -sfn "${VERSION_DIR}/talos-worker.js" "${BIN_DIR}/talos-worker"

echo "Installed ${BIN_DIR}/talos-worker"
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) echo "Add ${BIN_DIR} to PATH, for example: export PATH=\"${BIN_DIR}:\$PATH\"" ;;
esac
echo "Next: talos-worker init"
