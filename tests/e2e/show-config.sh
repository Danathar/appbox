#!/usr/bin/env bash
# Runs the real host/appbox-update --show-config from this checkout, with
# self-update off and a throwaway HOME, and checks it reports this repo's own
# settings. --show-config reads files and prints; it never pulls the checkout
# and never calls podman, distrobox or the network, and this script checks
# that it did not create its state directory. Run by the `E2E (image build)`
# job in .github/workflows/ci.yml, on a runner with no box.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
tmp_home="$(mktemp -d)"
trap 'rm -rf "${tmp_home}"' EXIT
failures=0

expect() {
  local key="$1" value="$2" line
  line="$(printf '%-16s%s' "${key}:" "${value}")"
  if grep -Fxq -- "${line}" <<< "${out}"; then
    echo "PASS: ${line}"
  else
    echo "FAIL: want the line '${line}'" >&2
    failures=$((failures + 1))
  fi
}

out="$(env -u APPBOX_INI -u APPBOX_MAX_AGE_DAYS -u APPBOX_PUBKEY -u APPBOX_REEXECED \
  -u XDG_STATE_HOME HOME="${tmp_home}" APPBOX_SELF_UPDATE=0 \
  "${repo_root}/host/appbox-update" --show-config)"
echo "${out}"
echo

host="$(hostname -s)"
expect "host" "${host}"
if [ ! -f "${repo_root}/hosts/${host}.env" ]; then
  expect "host settings" "none (defaults)"
  expect "max age (days)" "7"
fi
expect "checkout" "${repo_root} @ $(git -C "${repo_root}" rev-parse --short HEAD)"
expect "self-update" "off"
expect "ini" "${repo_root}/distrobox.ini"
expect "box" "$(sed -n 's/^\[\(.*\)\]$/\1/p' "${repo_root}/distrobox.ini" | head -n 1)"
expect "image" "$(sed -n 's/^image=//p' "${repo_root}/distrobox.ini" | head -n 1)"
expect "guarded apps" "claude-desktop signal-desktop"
expect "public key" "${repo_root}/cosign.pub"
expect "state" "${tmp_home}/.local/state/appbox"

if [ -e "${tmp_home}/.local" ]; then
  echo "FAIL: --show-config created ${tmp_home}/.local" >&2
  failures=$((failures + 1))
else
  echo "PASS: --show-config wrote nothing under HOME"
fi

if [ "${failures}" -ne 0 ]; then
  echo "${failures} check(s) failed" >&2
  exit 1
fi
