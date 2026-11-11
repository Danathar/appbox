#!/usr/bin/env bash
# Checks the contents of a freshly built appbox image. Runs inside a
# throwaway container of that image, started by tests/e2e/run.sh with this
# repo mounted read-only at /src. Prints PASS or FAIL per check and exits 1 if
# any check failed.
#
# It changes the throwaway container in two ways: it refreshes the apt lists
# (the image ships without them), and at the very end it runs the init hook,
# which installs claude-desktop the way a new box's first start does. Neither
# reaches the published image: this container is never committed or pushed.
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

# key_fingerprint FILE: the primary key fingerprint of every key in an armored
# or binary key file, one per line, so a file with an extra key does not match
# a single pinned fingerprint.
key_fingerprint() {
  gpg --show-keys --with-colons "$1" 2> /dev/null |
    awk -F: '/^pub:/ { primary = 1; next } primary && /^fpr:/ { print $10; primary = 0 }'
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
check "Signal's apt source trusts only Signal's keyring" \
  grep -qx 'Signed-By: /usr/share/keyrings/signal-desktop-keyring.gpg' /etc/apt/sources.list.d/signal-desktop.sources
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
apt_ok=0
if apt-get -qq -o Acquire::Retries=3 update; then
  apt_ok=1
  mapfile -t would_install < <(apt-get install -s claude-desktop 2> /dev/null | awk '/^Inst / { print $2 }')
  check "Anthropic's repo offers claude-desktop" [ "${#would_install[@]}" -gt 0 ]
  only_claude() { [ "${#would_install[@]}" -eq 1 ] && [ "${would_install[0]}" = claude-desktop ]; }
  check "installing claude-desktop adds only claude-desktop (would install: ${would_install[*]:-nothing})" only_claude
else
  fail "apt-get update failed inside the image (network, or a broken apt source)"
fi

echo "== Running claude-desktop-sync"
# Runs the init hook itself, last, because it installs claude-desktop and
# every check above needs it absent. distrobox-init runs with errexit, so the
# hook must exit 0 even when the install fails, and it must never upgrade an
# installed claude-desktop (AGENTS.md, hard rules). A fake apt-get first on
# PATH stands in for a broken network and records any call.
if [ "${apt_ok}" = 1 ]; then
  fakebin="$(mktemp -d)"
  hook_out="$(mktemp)"
  apt_called="${fakebin}/apt-get-called"
  printf '#!/bin/sh\n: > %s\nexit 100\n' "${apt_called}" > "${fakebin}/apt-get"
  chmod +x "${fakebin}/apt-get"

  # run_hook [PATH-prefix]: runs the hook, output to $hook_out, status to $hook_status.
  run_hook() {
    hook_status=0
    PATH="${1:+$1:}${PATH}" "${sync}" > "${hook_out}" 2>&1 || hook_status=$?
  }
  hook_exited_0() { [ "${hook_status}" -eq 0 ]; }

  run_hook "${fakebin}"
  check "the hook exits 0 when the install fails (exit ${hook_status})" hook_exited_0
  check "the hook warns that a failed install is retried on next box start" \
    grep -q 'WARNING: claude-desktop install failed; it will be retried' "${hook_out}"
  check "a failed install leaves claude-desktop uninstalled" not_installed claude-desktop

  rm -f "${apt_called}"
  run_hook
  check "the hook exits 0 on a new box (exit ${hook_status})" hook_exited_0
  check "the hook installs claude-desktop on a new box" installed claude-desktop
  if ! hook_exited_0 || not_installed claude-desktop; then cat "${hook_out}" >&2; fi

  if installed claude-desktop; then
    run_hook "${fakebin}"
    check "with claude-desktop installed the hook exits 0 (exit ${hook_status})" hook_exited_0
    check "with claude-desktop installed the hook never calls apt-get (install only, never upgrade)" \
      [ ! -e "${apt_called}" ]
  else
    fail "cannot check the already-installed case: the hook did not install claude-desktop"
  fi
else
  fail "claude-desktop-sync was not run: apt-get update failed above"
fi

echo
if [ "${failures}" -ne 0 ]; then
  echo "${failures} check(s) failed" >&2
  exit 1
fi
echo "All image checks passed."
