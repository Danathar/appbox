#!/usr/bin/env bash
# End-to-end test of the public image: builds ContainerFiles/appbox with
# podman from this checkout, then runs tests/e2e/in-image.sh inside the result
# with the repo mounted read-only at /src.
#
# Meant for CI (the `E2E (image build)` job in .github/workflows/ci.yml, on
# ubuntu-latest, which ships podman). It needs the network: the build pulls
# the ublue base image and installs from the Ubuntu, Signal and Anthropic apt
# repos, and in-image.sh refreshes the apt lists once.
#
# Not checked here: the cosign signature of the ublue base image. That check
# runs in .github/workflows/build-appbox.yml before every published build.
# This build is throwaway and is never pushed or signed.
#
# Usage: tests/e2e/run.sh
#   E2E_IMAGE  tag to build and test (default localhost/appbox:e2e)
#   E2E_SKIP_BUILD=1  test an already built E2E_IMAGE instead of building
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image="${E2E_IMAGE:-localhost/appbox:e2e}"

if [ "${E2E_SKIP_BUILD:-0}" != 1 ]; then
  echo "== Building ${image} from ContainerFiles/appbox"
  podman build --pull=newer -f "${repo_root}/ContainerFiles/appbox" -t "${image}" "${repo_root}"
fi

echo "== Checking image labels"
label="$(podman image inspect -f '{{index .Labels "com.github.containers.toolbox"}}' "${image}")"
if [ "${label}" != "true" ]; then
  echo "FAIL: label com.github.containers.toolbox is '${label}', want 'true' (distrobox and toolbox need it)" >&2
  exit 1
fi
echo "PASS: label com.github.containers.toolbox=true"

# label=disable lets the container read the mount on SELinux hosts without
# relabelling the checkout.
echo "== Checking the image contents"
podman run --rm --user root --security-opt label=disable \
  -v "${repo_root}:/src:ro" \
  --entrypoint /bin/bash \
  "${image}" /src/tests/e2e/in-image.sh
