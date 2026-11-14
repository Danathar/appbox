# shellcheck shell=bash
# Shared helpers for the unit tests of host/appbox-update and host/install.
# Every .bats file loads this with `load helpers`.
#
# Nothing in these tests touches the real machine. Each test gets:
#   - $REPO, a scratch copy of the parts of the repo the scripts read
#     (host/, an empty hosts/, distrobox.ini, cosign.pub). Both scripts find
#     the repo from their own path (readlink -f "$0"), so they have to run
#     from a copy the test controls, never from this checkout.
#   - A private HOME and TMPDIR under $BATS_TEST_TMPDIR, and no XDG_* or
#     APPBOX_* variables inherited from whoever runs the tests.
#   - PATH set to only $STUBS (fakes for distrobox, podman, cosign, git,
#     pgrep, notify-send, curl, systemctl, hostname, timeout, sleep) and
#     $REALBIN (symlinks to harmless real tools such as sed and awk).
# Every stub appends one line per call to $CALLS, so a test can assert what
# the script ran and, just as important, what it did not run.
#
# Fake "running app" model: the podman stub reports $STUB_BOX_PID as the box's
# init process, and the pgrep stub prints $STUB_APP_PID for each app named in
# $STUB_RUNNING. Both default to the pid of the shell running the tests, so the
# script's mount-namespace comparison (/proc/<pid>/ns/mnt) sees the app as
# running inside the box. Apps named in $STUB_RUNNING_ELSEWHERE get a pid that
# has no /proc entry, which the script treats like a process in another box.

SRC="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

# Under kcov (.github/workflows/coverage-gate.yml) the bats shell itself runs
# with xtrace on, and the trace of bats' own multi-line internals can confuse
# kcov's parser. Only the scripts under test need tracing; they run in a child
# bash that kcov traces through BASH_ENV. Outside kcov this does nothing.
set +x

# A pid above the kernel's maximum (2^22), so /proc/<pid> never exists.
NO_SUCH_PID=2147483646

setup_sandbox() {
  # Canonical paths: the scripts resolve their own location with readlink -f,
  # so expected paths in assertions must not go through a symlink.
  SANDBOX="$(cd "$BATS_TEST_TMPDIR" && pwd -P)/sandbox"
  STUBS="$SANDBOX/stubs"
  REALBIN="$SANDBOX/realbin"
  CALLS="$SANDBOX/calls.log"
  STATE="$SANDBOX/state" # what the stubs remember between calls
  SCRIPT_TMP="$SANDBOX/tmp"
  mkdir -p "$STUBS" "$REALBIN" "$STATE/installed" "$STATE/candidate" "$SCRIPT_TMP" \
    "$SANDBOX/home"
  : >"$CALLS"

  make_repo

  # Real tools the scripts (and the stubs) need besides the stubbed ones.
  local tool path
  for tool in bash cat cp sed head tr cut awk date seq mkdir touch rm mktemp \
    basename dirname readlink ln ls; do
    path=$(command -v "$tool") || {
      echo "test host lacks $tool" >&2
      return 1
    }
    ln -s "$path" "$REALBIN/$tool"
  done

  install_stubs

  unset APPBOX_MAX_AGE_DAYS APPBOX_INI APPBOX_SELF_UPDATE APPBOX_REEXECED \
    APPBOX_PUBKEY XDG_STATE_HOME XDG_CONFIG_HOME
  export HOME="$SANDBOX/home" TMPDIR="$SCRIPT_TMP"
  export STUB_CALLS="$CALLS" STUB_STATE="$STATE"
  export STUB_HOSTNAME="testbox"
  export STUB_BOX_EXISTS=1 STUB_BOX_PID="$$" STUB_APP_PID="$$" STUB_OTHER_PID="$NO_SUCH_PID"
  export STUB_RUNNING="" STUB_RUNNING_ELSEWHERE=""
  unset STUB_RUNNING_AFTER_PULL
  export STUB_BOX_ID="0123456789abcdef0123456789abcdef"
  export STUB_DIGEST="sha256:1111111111111111111111111111111111111111111111111111111111111111"
  export STUB_GIT_PULL=current
  export STUB_GIT_NEW_HEAD="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  printf '%s\n' "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" >"$STATE/git-head"
  printf '%s\n' "oldimage" >"$STATE/box-image"
  box_age_days 1
  installed signal-desktop 7.0.0
  installed claude-desktop 1.0.0
}

# Copies the files the scripts read into $REPO. APPBOX_TEST_REPO overrides the
# location so the coverage job can keep one fixed path for every test (kcov
# reports coverage per file path, and needs the file to still exist when it
# writes its report). That directory is wiped per test, so it must be empty or
# one this function made before.
make_repo() {
  REPO="${APPBOX_TEST_REPO:-$BATS_TEST_TMPDIR/repo}"
  if [ -e "$REPO" ]; then
    if [ -f "$REPO/.appbox-test-repo" ]; then
      rm -rf "$REPO"
    elif [ -n "$(ls -A "$REPO")" ]; then
      echo "refusing to reuse $REPO: not empty and not made by these tests" >&2
      return 1
    fi
  fi
  mkdir -p "$REPO/host" "$REPO/hosts"
  REPO="$(cd "$REPO" && pwd -P)"
  : >"$REPO/.appbox-test-repo"
  cp "$SRC/host/appbox-update" "$SRC/host/install" \
    "$SRC/host/appbox-update.service" "$SRC/host/appbox-update.timer" "$REPO/host/"
  chmod +x "$REPO/host/appbox-update" "$REPO/host/install"
  cp "$SRC/distrobox.ini" "$SRC/cosign.pub" "$REPO/"
}

install_stubs() {
  cat >"$STUBS/hostname" <<'S'
#!/usr/bin/env bash
echo "hostname $*" >>"$STUB_CALLS"
echo "$STUB_HOSTNAME"
S
  # Records the time limit, then runs the command (the git stub).
  cat >"$STUBS/timeout" <<'S'
#!/usr/bin/env bash
echo "timeout $*" >>"$STUB_CALLS"
shift
exec "$@"
S
  # HEAD lives in $STUB_STATE/git-head. STUB_GIT_PULL picks what a pull does:
  # current (already up to date), advance (moves HEAD to STUB_GIT_NEW_HEAD) or
  # fail (cannot fast-forward).
  cat >"$STUBS/git" <<'S'
#!/usr/bin/env bash
echo "git $*" >>"$STUB_CALLS"
[ "$1" = "-C" ] && shift 2
head_file="$STUB_STATE/git-head"
case "$*" in
  "rev-parse HEAD")
    cat "$head_file"
    ;;
  "rev-parse --short HEAD")
    h=$(cat "$head_file")
    echo "${h:0:7}"
    ;;
  "pull --ff-only --quiet")
    echo "git-pull-env GIT_TERMINAL_PROMPT=${GIT_TERMINAL_PROMPT:-unset}" >>"$STUB_CALLS"
    case "$STUB_GIT_PULL" in
      current) ;;
      advance) printf '%s\n' "$STUB_GIT_NEW_HEAD" >"$head_file" ;;
      fail)
        echo "fatal: Not possible to fast-forward, aborting." >&2
        exit 128
        ;;
    esac
    ;;
  *)
    echo "git stub: unexpected arguments: $*" >&2
    exit 99
    ;;
esac
S
  cat >"$STUBS/podman" <<'S'
#!/usr/bin/env bash
echo "podman $*" >>"$STUB_CALLS"
case "$1" in
  container)
    # podman container exists BOX
    [ "$STUB_BOX_EXISTS" = 1 ]
    ;;
  inspect)
    # podman inspect -f FORMAT BOX
    case "$3" in
      '{{.State.Pid}}')
        if [ "${STUB_INSPECT_PID_FAIL:-0}" = 1 ]; then
          echo "Error: no such container" >&2
          exit 125
        fi
        echo "$STUB_BOX_PID"
        ;;
      '{{.Created.Unix}}') echo "$STUB_BOX_CREATED" ;;
      '{{.Id}}') echo "$STUB_BOX_ID" ;;
      '{{.Image}}') cat "$STUB_STATE/box-image" ;;
      *)
        echo "podman stub: unexpected inspect format $3" >&2
        exit 99
        ;;
    esac
    ;;
  pull)
    : >"$STUB_STATE/pulled"
    if [ "${STUB_PULL_EXIT:-0}" != 0 ]; then
      echo "Error: initializing source: manifest unknown" >&2
      exit "$STUB_PULL_EXIT"
    fi
    ;;
  image)
    # podman image inspect -f '{{.Digest}}' IMAGE
    echo "$STUB_DIGEST"
    ;;
  rmi) ;;
  *)
    echo "podman stub: unexpected arguments: $*" >&2
    exit 99
    ;;
esac
S
  # pgrep -x 'name1|name2': prints a pid for each named app that is running.
  # Apps in STUB_RUNNING_AFTER_PULL (when set) replace STUB_RUNNING once the
  # podman stub has seen a pull, to fake an app opened during the pull.
  cat >"$STUBS/pgrep" <<'S'
#!/usr/bin/env bash
echo "pgrep $*" >>"$STUB_CALLS"
running="$STUB_RUNNING"
if [ -f "$STUB_STATE/pulled" ] && [ -n "${STUB_RUNNING_AFTER_PULL+x}" ]; then
  running="$STUB_RUNNING_AFTER_PULL"
fi
found=1
IFS='|' read -ra names <<<"${*: -1}"
for name in "${names[@]}"; do
  for r in $STUB_RUNNING_ELSEWHERE; do
    if [ "$r" = "$name" ]; then
      echo "$STUB_OTHER_PID"
      found=0
    fi
  done
  for r in $running; do
    if [ "$r" = "$name" ]; then
      echo "$STUB_APP_PID"
      found=0
    fi
  done
done
exit "$found"
S
  # distrobox enter BOX -- CMD...: fakes the few commands the script runs in
  # the box against $STUB_STATE/installed/<pkg> and $STUB_STATE/candidate/<pkg>.
  # distrobox assemble create --replace --file INI: saves the ini it was given
  # (assembled.ini), gives the box a new image id and creates the exported
  # launchers, except those whose basename is in STUB_ASSEMBLE_MISSING.
  cat >"$STUBS/distrobox" <<'S'
#!/usr/bin/env bash
echo "distrobox $*" >>"$STUB_CALLS"
apps_dir="$HOME/.local/share/applications"
case "$1" in
  enter)
    box="$2"
    shift 3
    [ "$1" = sudo ] && shift
    pkg="${*: -1}"
    case "$1" in
      apt-get) exit "${STUB_APT_UPDATE_EXIT:-0}" ;;
      dpkg-query)
        if [ ! -f "$STUB_STATE/installed/$pkg" ]; then
          echo "dpkg-query: no packages found matching $pkg" >&2
          exit 1
        fi
        cat "$STUB_STATE/installed/$pkg"
        ;;
      apt-cache)
        inst="(none)"
        [ -f "$STUB_STATE/installed/$pkg" ] && inst=$(cat "$STUB_STATE/installed/$pkg")
        cand="$inst"
        [ -f "$STUB_STATE/candidate/$pkg" ] && cand=$(cat "$STUB_STATE/candidate/$pkg")
        printf '%s:\n  Installed: %s\n  Candidate: %s\n  Version table:\n' "$pkg" "$inst" "$cand"
        ;;
      env)
        # env DEBIAN_FRONTEND=noninteractive apt-get -y -q install --only-upgrade PKG
        [ "${STUB_APT_INSTALL_EXIT:-0}" = 0 ] || exit "$STUB_APT_INSTALL_EXIT"
        cat "$STUB_STATE/candidate/$pkg" >"$STUB_STATE/installed/$pkg"
        ;;
      /usr/libexec/appbox/claude-desktop-sync) ;;
      sh) ;; # sh -c "<init_hooks value>"
      distrobox-export)
        [ "${STUB_EXPORT_FAIL:-0}" = 1 ] && exit 1
        mkdir -p "$apps_dir"
        : >"$apps_dir/$box-${pkg##*/}"
        ;;
      *)
        echo "distrobox stub: unexpected command in box: $*" >&2
        exit 99
        ;;
    esac
    ;;
  assemble)
    ini="${*: -1}"
    cp "$ini" "$STUB_STATE/assembled.ini"
    [ "${STUB_ASSEMBLE_EXIT:-0}" = 0 ] || exit "$STUB_ASSEMBLE_EXIT"
    echo "${STUB_NEW_IMAGE:-newimage}" >"$STUB_STATE/box-image"
    box=$(sed -n 's/^\[\(.*\)\]$/\1/p' "$ini" | head -n 1)
    mkdir -p "$apps_dir"
    for app in $(sed -n 's/^exported_apps=//p' "$ini"); do
      case " ${STUB_ASSEMBLE_MISSING:-} " in *" ${app##*/} "*) continue ;; esac
      : >"$apps_dir/$box-${app##*/}"
    done
    ;;
  *)
    echo "distrobox stub: unexpected arguments: $*" >&2
    exit 99
    ;;
esac
S
  cat >"$STUBS/cosign" <<'S'
#!/usr/bin/env bash
echo "cosign $*" >>"$STUB_CALLS"
if [ "${STUB_COSIGN_EXIT:-0}" != 0 ]; then
  echo "Error: no matching signatures" >&2
  exit "$STUB_COSIGN_EXIT"
fi
S
  # The network check: prints the HTTP code like curl -w '%{http_code}'.
  # The first STUB_NET_DOWN_FOR calls fail with 000 (no connection).
  cat >"$STUBS/curl" <<'S'
#!/usr/bin/env bash
echo "curl $*" >>"$STUB_CALLS"
n=$(cat "$STUB_STATE/curl-count" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" >"$STUB_STATE/curl-count"
if [ "$n" -le "${STUB_NET_DOWN_FOR:-0}" ]; then
  printf '000'
  exit 7
fi
printf '401'
S
  cat >"$STUBS/sleep" <<'S'
#!/usr/bin/env bash
echo "sleep $*" >>"$STUB_CALLS"
S
  # STUB_NOTIFY_FAIL=1 fakes a machine with no desktop session to notify.
  cat >"$STUBS/notify-send" <<'S'
#!/usr/bin/env bash
echo "notify-send $*" >>"$STUB_CALLS"
[ "${STUB_NOTIFY_FAIL:-0}" != 1 ]
S
  cat >"$STUBS/systemctl" <<'S'
#!/usr/bin/env bash
echo "systemctl $*" >>"$STUB_CALLS"
exit "${STUB_SYSTEMCTL_EXIT:-0}"
S
  chmod +x "$STUBS"/*
}

# box_age_days N: the box was created N days (and an hour) ago.
box_age_days() {
  export STUB_BOX_CREATED=$(($(date +%s) - $1 * 86400 - 3600))
}

# installed PKG VERSION / candidate PKG VERSION: what dpkg-query and
# apt-cache policy report inside the box. not_installed PKG removes it.
installed() { printf '%s' "$2" >"$STATE/installed/$1"; }
candidate() { printf '%s' "$2" >"$STATE/candidate/$1"; }
not_installed() { rm -f "$STATE/installed/$1"; }

# host_env LINE...: writes hosts/<hostname>.env in the scratch repo.
host_env() { printf '%s\n' "$@" >"$REPO/hosts/$STUB_HOSTNAME.env"; }

run_update() {
  run env "PATH=$STUBS:$REALBIN" "$BASH" "$REPO/host/appbox-update" "$@"
}

run_install() {
  run env "PATH=$STUBS:$REALBIN" "$BASH" "$REPO/host/install" "$@"
}

calls() { cat "$CALLS"; }

# count_calls PATTERN: number of logged calls matching the grep pattern.
count_calls() { grep -c -- "$1" "$CALLS" || true; }

state_dir() { echo "$HOME/.local/state/appbox"; }
