#!/usr/bin/env bats
# Unit tests for host/install. systemctl and everything host/appbox-update
# calls are stubs (helpers.bash), and HOME is a scratch directory, so no real
# unit is linked, enabled or started.

load helpers

setup() {
  setup_sandbox
  UNIT_DIR="$HOME/.config/systemd/user"
  DROPIN="$UNIT_DIR/appbox-update.service.d/checkout.conf"
}

@test "links the service and timer from this checkout into the user unit directory" {
  run_install
  [ "$status" -eq 0 ]
  [ "$(readlink "$UNIT_DIR/appbox-update.service")" = "$REPO/host/appbox-update.service" ]
  [ "$(readlink "$UNIT_DIR/appbox-update.timer")" = "$REPO/host/appbox-update.timer" ]
}

@test "honours XDG_CONFIG_HOME for the unit directory" {
  export XDG_CONFIG_HOME="$SANDBOX/xdg-config"
  run_install
  [ "$status" -eq 0 ]
  [ -L "$SANDBOX/xdg-config/systemd/user/appbox-update.timer" ]
  [ ! -e "$UNIT_DIR" ]
}

@test "a checkout outside ~/claude/appbox gets a drop-in pointing ExecStart at it" {
  run_install
  [ "$status" -eq 0 ]
  [[ "$output" == *"Checkout is not ~/claude/appbox; wrote $DROPIN"* ]]
  [ "$(cat "$DROPIN")" = "$(printf '[Service]\nExecStart=\nExecStart=%s/host/appbox-update' "$REPO")" ]
}

@test "a checkout at ~/claude/appbox needs no drop-in, and a stale one is removed" {
  mkdir -p "$HOME/claude" "$(dirname "$DROPIN")"
  ln -s "$REPO" "$HOME/claude/appbox"
  printf '[Service]\nExecStart=\nExecStart=/old/place/host/appbox-update\n' >"$DROPIN"
  run_install
  [ "$status" -eq 0 ]
  [ ! -e "$DROPIN" ]
  [[ "$output" != *"Checkout is not ~/claude/appbox"* ]]
}

@test "reloads systemd, then enables and starts the timer" {
  run_install
  [ "$status" -eq 0 ]
  local reload enable
  reload=$(grep -n '^systemctl --user daemon-reload$' "$CALLS" | cut -d: -f1)
  enable=$(grep -n '^systemctl --user enable --now appbox-update.timer$' "$CALLS" | cut -d: -f1)
  [ -n "$reload" ]
  [ -n "$enable" ]
  [ "$reload" -lt "$enable" ]
  [[ "$(calls)" == *"systemctl --user list-timers appbox-update.timer --no-pager"* ]]
}

@test "without hosts/<hostname>.env it says the defaults apply and how to change them" {
  run_install
  [ "$status" -eq 0 ]
  [[ "$output" == *"No hosts/testbox.env in the repo; this machine uses the defaults."* ]]
  [[ "$output" == *"copy hosts/example.env to hosts/testbox.env"* ]]
}

@test "with hosts/<hostname>.env there is no hint" {
  host_env "APPBOX_MAX_AGE_DAYS=7"
  run_install
  [ "$status" -eq 0 ]
  [[ "$output" != *"No hosts/testbox.env"* ]]
}

@test "ends by showing the effective settings, without pulling or touching the box" {
  run_install
  [ "$status" -eq 0 ]
  [[ "$output" == *"box:            apps"* ]]
  [[ "$output" == *"checkout:       $REPO @ aaaaaaa"* ]]
  [[ "$(calls)" != *"pull --ff-only"* ]]
  [[ "$(calls)" != *"podman"* ]]
  [[ "$(calls)" != *"distrobox"* ]]
}

@test "is safe to re-run" {
  run_install
  [ "$status" -eq 0 ]
  run_install
  [ "$status" -eq 0 ]
  [ "$(readlink "$UNIT_DIR/appbox-update.service")" = "$REPO/host/appbox-update.service" ]
  [ "$(ls "$(dirname "$DROPIN")")" = "checkout.conf" ]
}

@test "a systemctl failure stops the install" {
  export STUB_SYSTEMCTL_EXIT=1
  run_install
  [ "$status" -ne 0 ]
  [[ "$output" != *"box:            apps"* ]]
}
