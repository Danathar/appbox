#!/usr/bin/env bash
# Checks the contents of a freshly built appbox image. Runs inside a
# throwaway container of that image, started by tests/e2e/run.sh with this
# repo mounted read-only at /src. Prints PASS or FAIL per check and exits 1 if
# any check failed.
#
# The one thing this changes inside the container is the apt lists (the image
# ships without them), to ask apt what a box-start install would pull in.
set -uo pipefail

src="${SRC:-/src}"
failures=0

pass() { printf 'PASS: %s\n' "$*"; }
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}
check() {
  local what="$1"
  shift
  if "$@"; then pass "${what}"; else fail "${what}"; fi
}

installed() {
  dpkg-query -W -f '${Status}' "$1" 2> /dev/null | grep -q 'ok installed'
}
not_installed() { ! installed "$1"; }

# key_fingerprint FILE: primary key fingerprint of an armored or binary key.
key_fingerprint() {
  gpg --show-keys --with-colons "$1" 2> /dev/null | awk -F: '/^fpr:/ { print $10; exit }'
}

# Pinned in scripts/appbox.sh (fetch_key). Checked against it below so a key
# rotation there cannot leave this test checking the old key.
claude_fpr=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE
signal_fpr=DBA36B5181D0C816F630E889D980A17457F6FB06

echo "== Base"
want_version="$(sed -n 's/^ARG UBUNTU_VERSION=//p' "${src}/ContainerFiles/appbox")"
# shellcheck source=/dev/null
. /etc/os-release
is_pinned_ubuntu() { [ "${ID}" = ubuntu ] && [ "${VERSION_ID}" = "${want_version}" ]; }
check "${ID} ${VERSION_ID} is Ubuntu ${want_version}, the UBUNTU_VERSION in ContainerFiles/appbox" is_pinned_ubuntu

echo "== Signal"
check "signal-desktop is installed" installed signal-desktop
check "Signal's apt source is present" test -s /etc/apt/sources.list.d/signal-desktop.sources
check "Signal's keyring is present" test -s /usr/share/keyrings/signal-desktop-keyring.gpg
check "the test's Signal fingerprint is the one scripts/appbox.sh pins" \
  grep -q "${signal_fpr}" "${src}/scripts/appbox.sh"
check "Signal's keyring holds key ${signal_fpr}" \
  [ "$(key_fingerprint /usr/share/keyrings/signal-desktop-keyring.gpg)" = "${signal_fpr}" ]

echo "== Claude Desktop (repo only, never the package)"
check "claude-desktop is NOT installed (the image is public)" not_installed claude-desktop
claude_list=/etc/apt/sources.list.d/claude-desktop.list
claude_key=/usr/share/keyrings/claude-desktop-archive-keyring.asc
check "Anthropic's apt source is present" test -s "${claude_list}"
check "Anthropic's apt source points at downloads.claude.ai and is signed-by its keyring" \
  grep -Eq "^deb \[[^]]*signed-by=${claude_key}[^]]*\] https://downloads\.claude\.ai/claude-desktop/apt/stable stable main$" "${claude_list}"
check "Anthropic's key is present" test -s "${claude_key}"
check "the test's Anthropic fingerprint is the one scripts/appbox.sh pins" \
  grep -q "${claude_fpr}" "${src}/scripts/appbox.sh"
check "Anthropic's key file holds key ${claude_fpr}" \
  [ "$(key_fingerprint "${claude_key}")" = "${claude_fpr}" ]

echo "== claude-desktop-sync (the init hook in distrobox.ini)"
sync=/usr/libexec/appbox/claude-desktop-sync
check "${sync} exists and is executable" test -x "${sync}"
check "${sync} is scripts/claude-desktop-sync from this checkout" cmp -s "${sync}" "${src}/scripts/claude-desktop-sync"
check "distrobox.ini runs ${sync} as its init hook" grep -qx "init_hooks=${sync}" "${src}/distrobox.ini"

echo "== packages/appbox.packages"
mapfile -t extra < <(grep -Ev '^[[:space:]]*(#|$)' "${src}/packages/appbox.packages")
if [ "${#extra[@]}" -eq 0 ]; then
  pass "no extra packages are listed, nothing to check"
fi
for pkg in "${extra[@]}"; do
  check "${pkg} (from packages/appbox.packages) is installed" installed "${pkg}"
done

echo "== Build leftovers"
check "/tmp/appbox was removed" [ ! -e /tmp/appbox ]

echo "== Box-start install of Claude Desktop"
# scripts/appbox.sh pre-installs claude-desktop's dependencies so the init
# hook installs one package, not ~200. Ask apt (simulate only) what an install
# would add now.
if apt-get -qq -o Acquire::Retries=3 update; then
  mapfile -t would_install < <(apt-get install -s claude-desktop 2> /dev/null | awk '/^Inst / { print $2 }')
  check "Anthropic's repo offers claude-desktop" [ "${#would_install[@]}" -gt 0 ]
  only_claude() { [ "${#would_install[@]}" -eq 1 ] && [ "${would_install[0]}" = claude-desktop ]; }
  check "installing claude-desktop adds only claude-desktop (would install: ${would_install[*]:-nothing})" only_claude
else
  fail "apt-get update failed inside the image (network, or a broken apt source)"
fi

echo
if [ "${failures}" -ne 0 ]; then
  echo "${failures} check(s) failed" >&2
  exit 1
fi
echo "All image checks passed."
