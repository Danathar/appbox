#!/usr/bin/env bash
# Build-time setup for the appbox image. Runs once from ContainerFiles/appbox.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
export DEBIAN_FRONTEND=noninteractive

# Fail loudly if the base image changed Ubuntu release under us.
# shellcheck source=/dev/null
. /etc/os-release
if [ "${VERSION_ID}" != "${UBUNTU_VERSION:?UBUNTU_VERSION must be set}" ]; then
    echo "Base image is Ubuntu ${VERSION_ID}, but UBUNTU_VERSION is ${UBUNTU_VERSION}." >&2
    echo "If this is the intended upgrade, bump UBUNTU_VERSION in ContainerFiles/appbox." >&2
    exit 1
fi

# Download a signing key and refuse it unless its primary fingerprint matches.
# usage: fetch_key URL EXPECTED_FINGERPRINT OUTPUT_FILE
fetch_key() {
    local url="$1" expected="$2" out="$3" tmp actual
    tmp="$(mktemp)"
    curl -fsSL --retry 3 -o "${tmp}" "${url}"
    actual="$(gpg --show-keys --with-colons "${tmp}" | awk -F: '/^fpr:/ { print $10; exit }')"
    if [ "${actual}" != "${expected}" ]; then
        echo "Key fingerprint mismatch for ${url}: got ${actual}, expected ${expected}" >&2
        exit 1
    fi
    install -m 0644 "${tmp}" "${out}"
    rm -f "${tmp}"
}

# Signal (https://signal.org/download/linux/). amd64 only.
# The key is dearmored, as Signal's instructions do; the .sources file is
# Signal's own, so its format tracks whatever they publish.
fetch_key https://updates.signal.org/desktop/apt/keys.asc \
    DBA36B5181D0C816F630E889D980A17457F6FB06 /tmp/signal-keys.asc
gpg --dearmor < /tmp/signal-keys.asc > /usr/share/keyrings/signal-desktop-keyring.gpg
rm -f /tmp/signal-keys.asc
curl -fsSL --retry 3 -o /etc/apt/sources.list.d/signal-desktop.sources \
    https://updates.signal.org/static/desktop/apt/signal-desktop.sources

# Claude Desktop: repo and key only. The package itself is proprietary and is
# installed at box start by claude-desktop-sync, never baked into this image.
fetch_key https://downloads.claude.ai/claude-desktop/key.asc \
    31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE \
    /usr/share/keyrings/claude-desktop-archive-keyring.asc
echo "deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/claude-desktop-archive-keyring.asc] https://downloads.claude.ai/claude-desktop/apt/stable stable main" \
    > /etc/apt/sources.list.d/claude-desktop.list

install -D -m 0755 "${here}/claude-desktop-sync" /usr/libexec/appbox/claude-desktop-sync

apt-get update
apt-get -y upgrade
# shellcheck disable=SC2046
apt-get install -y signal-desktop $(grep -Ev '^[[:space:]]*(#|$)' "${here}/appbox.packages")

# Pre-install everything claude-desktop pulls in (Depends and Recommends,
# including the qemu/OVMF/virtiofsd stack Cowork uses), but not claude-desktop
# itself. These all come from the Ubuntu archive, and it turns the box-start
# install from ~200 packages into one. Computed from a simulated install, so
# it follows dependency changes in Anthropic's package automatically.
mapfile -t claude_deps < <(apt-get install -s claude-desktop |
    awk '/^Inst / && $2 != "claude-desktop" { print $2 }')
apt-get install -y "${claude_deps[@]}"
if dpkg-query -W -f '${Status}' claude-desktop 2> /dev/null | grep -q 'ok installed'; then
    echo "claude-desktop must not be installed in the image" >&2
    exit 1
fi

apt-get clean
rm -rf /var/lib/apt/lists/*
