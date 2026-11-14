#!/usr/bin/env bats
# Unit tests for host/appbox-update. See helpers.bash for the sandbox: every
# external command is a stub, and the script runs from a scratch copy of the
# repo, so nothing here touches a real box, image or checkout.

load helpers

setup() { setup_sandbox; }

# has_line TEXT: some line of $output is exactly TEXT.
has_line() { grep -Fxq -- "$1" <<<"$output"; }

# has_config KEY VALUE: --show-config printed "KEY:" padded to 16 columns, then VALUE.
has_config() {
  local line
  line=$(printf '%-16s%s' "$1:" "$2")
  has_line "$line" || {
    echo "missing config line: '$line'" >&2
    echo "$output" >&2
    return 1
  }
}

# A run that rebuilt the box exits 0.
assert_rebuild_exit() {
  [ "$status" -eq 0 ]
}

assert_no_rebuild() {
  [[ "$(calls)" != *"podman pull"* ]]
  [[ "$(calls)" != *"distrobox assemble"* ]]
}

# --- per-machine settings (hosts/<hostname>.env) ----------------------------

@test "no hosts/<hostname>.env: --show-config reports the defaults" {
  run_update --show-config
  [ "$status" -eq 0 ]
  has_config "host" "testbox"
  has_config "host settings" "none (defaults)"
  has_config "checkout" "$REPO @ aaaaaaa"
  has_config "self-update" "on"
  has_config "ini" "$REPO/distrobox.ini"
  has_config "box" "apps"
  has_config "image" "ghcr.io/danathar/appbox:latest"
  has_config "max age (days)" "7"
  has_config "guarded apps" "claude-desktop signal-desktop"
  has_config "public key" "$REPO/cosign.pub"
  has_config "cosign" "$STUBS/cosign"
  has_config "state" "$HOME/.local/state/appbox"
}

@test "the settings file is picked by the short hostname" {
  export STUB_HOSTNAME=laptop
  host_env "APPBOX_MAX_AGE_DAYS=3"
  run_update --show-config
  [ "$status" -eq 0 ]
  [[ "$(calls)" == *"hostname -s"* ]]
  has_config "host" "laptop"
  has_config "host settings" "$REPO/hosts/laptop.env"
  has_config "max age (days)" "3"
}

@test "another machine's settings file is not read" {
  printf 'APPBOX_MAX_AGE_DAYS=3\n' >"$REPO/hosts/otherhost.env"
  run_update --show-config
  [ "$status" -eq 0 ]
  has_config "host settings" "none (defaults)"
  has_config "max age (days)" "7"
}

@test "all three known keys are read from the settings file" {
  printf '[apps]\nimage=ghcr.io/danathar/appbox:20260101\n' >"$REPO/hosts/testbox.ini"
  host_env "APPBOX_MAX_AGE_DAYS=10" "APPBOX_INI=hosts/testbox.ini" "APPBOX_SELF_UPDATE=0"
  run_update --show-config
  [ "$status" -eq 0 ]
  has_config "max age (days)" "10"
  has_config "ini" "$REPO/hosts/testbox.ini"
  has_config "image" "ghcr.io/danathar/appbox:20260101"
  has_config "self-update" "off"
}

@test "comments and blank lines are skipped without a warning" {
  host_env "# a comment" "" "APPBOX_MAX_AGE_DAYS=5" "#APPBOX_MAX_AGE_DAYS=9"
  run_update --show-config
  [ "$status" -eq 0 ]
  has_config "max age (days)" "5"
  [[ "$output" != *"Ignoring"* ]]
}

@test "an unknown key is ignored with a warning naming the key and the file" {
  host_env "APPBOX_COLOR=blue" "APPBOX_MAX_AGE_DAYS=4"
  run_update --show-config
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ignoring unknown setting 'APPBOX_COLOR' in $REPO/hosts/testbox.env"* ]]
  has_config "max age (days)" "4"
}

@test "a variable already in the environment wins over the settings file" {
  host_env "APPBOX_MAX_AGE_DAYS=4"
  export APPBOX_MAX_AGE_DAYS=12
  run_update --show-config
  [ "$status" -eq 0 ]
  has_config "max age (days)" "12"
}

@test "the last line is read even without a trailing newline" {
  printf 'APPBOX_SELF_UPDATE=1\nAPPBOX_MAX_AGE_DAYS=6' >"$REPO/hosts/testbox.env"
  run_update --show-config
  [ "$status" -eq 0 ]
  has_config "max age (days)" "6"
}

@test "the settings file is never executed: command substitution stays literal text" {
  host_env "APPBOX_INI=\$(touch $SANDBOX/pwned)"
  run_update --show-config
  [ "$status" -eq 1 ]
  [ ! -e "$SANDBOX/pwned" ]
  [[ "$output" == *"distrobox ini not found: $REPO/\$(touch $SANDBOX/pwned)"* ]]
}

@test "the settings file is never executed: shell lines are unknown keys" {
  host_env "touch $SANDBOX/pwned" "export APPBOX_MAX_AGE_DAYS=2" "APPBOX_MAX_AGE_DAYS=3;touch $SANDBOX/pwned"
  run_update --show-config
  [ ! -e "$SANDBOX/pwned" ]
  [[ "$output" == *"Ignoring unknown setting 'touch $SANDBOX/pwned'"* ]]
  [[ "$output" == *"Ignoring unknown setting 'export APPBOX_MAX_AGE_DAYS'"* ]]
  # The whole value is taken as text, so it is rejected as not a number.
  [ "$status" -eq 1 ]
  [[ "$output" == *"APPBOX_MAX_AGE_DAYS must be a whole number, got '3;touch $SANDBOX/pwned'"* ]]
}

@test "a non-numeric APPBOX_MAX_AGE_DAYS stops the run before anything else" {
  host_env "APPBOX_MAX_AGE_DAYS=7d"
  run_update
  [ "$status" -eq 1 ]
  [[ "$output" == *"APPBOX_MAX_AGE_DAYS must be a whole number, got '7d'"* ]]
  [[ "$(calls)" != *"podman"* ]]
  [[ "$(calls)" != *"distrobox"* ]]
}

@test "an empty APPBOX_MAX_AGE_DAYS falls back to the default of 7" {
  host_env "APPBOX_MAX_AGE_DAYS="
  run_update --show-config
  [ "$status" -eq 0 ]
  has_config "max age (days)" "7"
}

@test "an absolute APPBOX_INI is used as is" {
  printf '[otherbox]\nimage=example.test/other:latest\n' >"$SANDBOX/other.ini"
  export APPBOX_INI="$SANDBOX/other.ini"
  run_update --show-config
  [ "$status" -eq 0 ]
  has_config "ini" "$SANDBOX/other.ini"
  has_config "box" "otherbox"
  has_config "image" "example.test/other:latest"
}

@test "a missing ini exits 1 and points at the setting" {
  host_env "APPBOX_INI=hosts/nope.ini"
  run_update
  [ "$status" -eq 1 ]
  [[ "$output" == *"distrobox ini not found: $REPO/hosts/nope.ini (check APPBOX_INI in $REPO/hosts/testbox.env)"* ]]
  [[ "$(calls)" != *"podman"* ]]
}

# --- --show-config ----------------------------------------------------------

@test "--show-config never pulls the checkout or touches the box" {
  run_update --show-config
  [ "$status" -eq 0 ]
  [[ "$(calls)" != *"pull --ff-only"* ]]
  [[ "$(calls)" != *"podman"* ]]
  [[ "$(calls)" != *"distrobox"* ]]
  [[ "$(calls)" != *"notify-send"* ]]
  [ ! -e "$(state_dir)" ]
}

@test "--show-config honours APPBOX_PUBKEY and XDG_STATE_HOME" {
  export APPBOX_PUBKEY=/etc/appbox/cosign.pub XDG_STATE_HOME="$SANDBOX/xdg-state"
  run_update --show-config
  [ "$status" -eq 0 ]
  has_config "public key" "/etc/appbox/cosign.pub"
  has_config "state" "$SANDBOX/xdg-state/appbox"
}

@test "--show-config falls back to Homebrew's cosign when none is on PATH" {
  rm "$STUBS/cosign"
  run_update --show-config
  [ "$status" -eq 0 ]
  has_config "cosign" "/home/linuxbrew/.linuxbrew/bin/cosign"
}

# --- self-update of the checkout --------------------------------------------

@test "self-update fast-forwards with no prompt and a 60 second limit" {
  run_update
  [ "$status" -eq 0 ]
  [[ "$(calls)" == *"timeout 60 git -C $REPO pull --ff-only --quiet"* ]]
  [[ "$(calls)" == *"git-pull-env GIT_TERMINAL_PROMPT=0"* ]]
  [[ "$output" != *"re-running"* ]]
}

@test "a new commit re-runs the updated script once, with the same arguments" {
  export STUB_GIT_PULL=advance
  box_age_days 0
  run_update --force
  assert_rebuild_exit
  [[ "$output" == *"Updated checkout aaaaaaa..bbbbbbb; re-running"* ]]
  [ "$(count_calls '^git .* pull --ff-only')" -eq 1 ]
  # --force reached the second run: a 0-day-old box was rebuilt.
  [[ "$(calls)" == *"distrobox assemble create --replace"* ]]
}

@test "a failed fast-forward is logged and the run carries on" {
  export STUB_GIT_PULL=fail
  candidate signal-desktop 7.1.0
  run_update
  [ "$status" -eq 0 ]
  [[ "$output" == *"Could not update $REPO; continuing with aaaaaaa"* ]]
  [[ "$output" == *"Upgrading signal-desktop 7.0.0 -> 7.1.0"* ]]
}

@test "APPBOX_SELF_UPDATE=0 in the settings file skips the pull" {
  host_env "APPBOX_SELF_UPDATE=0"
  run_update
  [ "$status" -eq 0 ]
  [[ "$(calls)" != *"pull --ff-only"* ]]
}

@test "a re-executed run does not pull again" {
  export APPBOX_REEXECED=1
  run_update
  [ "$status" -eq 0 ]
  [[ "$(calls)" != *"pull --ff-only"* ]]
}

# --- the box --------------------------------------------------------------

@test "a missing box is not created: the run says how and exits 0" {
  export STUB_BOX_EXISTS=0
  run_update --force
  [ "$status" -eq 0 ]
  [[ "$output" == *"Box 'apps' does not exist; create it once with:"* ]]
  [[ "$output" == *"distrobox assemble create --file $REPO/distrobox.ini"* ]]
  [[ "$(calls)" != *"distrobox "* ]]
  [[ "$(calls)" != *"podman pull"* ]]
}

# --- age check and --force --------------------------------------------------

@test "a box younger than APPBOX_MAX_AGE_DAYS is not rebuilt" {
  box_age_days 6
  run_update
  [ "$status" -eq 0 ]
  [[ "$output" == *"Box 'apps' is 6 day(s) old; rebuild due at 7."* ]]
  assert_no_rebuild
  [[ "$output" == *"Checking for app updates in 'apps'"* ]]
}

@test "a box at APPBOX_MAX_AGE_DAYS is rebuilt from the verified digest" {
  box_age_days 7
  run_update
  assert_rebuild_exit
  local pinned="ghcr.io/danathar/appbox@$STUB_DIGEST"
  [[ "$(calls)" == *"podman pull -q ghcr.io/danathar/appbox:latest"* ]]
  [[ "$(calls)" == *"cosign verify --key $REPO/cosign.pub $pinned"* ]]
  [[ "$output" == *"Rebuilding 'apps' from $pinned (was 7 day(s) old)"* ]]
  # The box is recreated from the pinned digest, with no second pull.
  grep -Fxq "image=$pinned" "$STATE/assembled.ini"
  grep -Fxq "pull=false" "$STATE/assembled.ini"
  grep -Fxq "init_hooks=/usr/libexec/appbox/claude-desktop-sync" "$STATE/assembled.ini"
  [[ "$(calls)" == *"notify-send -a appbox -i system-software-update Updating the apps box"* ]]
  [[ "$(calls)" == *"notify-send -a appbox -i system-software-update apps box updated Claude and Signal are ready."* ]]
}

@test "a successful rebuild exits 0 and removes its temporary ini" {
  box_age_days 7
  run_update
  [ "$status" -eq 0 ]
  [ -z "$(ls -A "$SCRIPT_TMP")" ]
}

@test "the order is pull, verify, then replace the box" {
  box_age_days 8
  run_update
  assert_rebuild_exit
  local pull verify assemble
  pull=$(grep -n 'podman pull' "$CALLS" | cut -d: -f1)
  verify=$(grep -n 'cosign verify' "$CALLS" | cut -d: -f1)
  assemble=$(grep -n 'distrobox assemble' "$CALLS" | cut -d: -f1)
  [ "$pull" -lt "$verify" ]
  [ "$verify" -lt "$assemble" ]
}

@test "after a rebuild there is no in-place upgrade in the same run" {
  box_age_days 7
  candidate signal-desktop 7.1.0
  run_update
  assert_rebuild_exit
  [[ "$output" != *"Checking for app updates"* ]]
  [[ "$(calls)" != *"--only-upgrade"* ]]
}

@test "APPBOX_MAX_AGE_DAYS from the settings file sets when the rebuild is due" {
  host_env "APPBOX_MAX_AGE_DAYS=3"
  box_age_days 3
  run_update
  assert_rebuild_exit
  [[ "$(calls)" == *"distrobox assemble create --replace"* ]]
}

@test "--force rebuilds a box that is not due yet" {
  box_age_days 0
  run_update --force
  assert_rebuild_exit
  [[ "$(calls)" == *"distrobox assemble create --replace"* ]]
}

@test "a failed signature check aborts before the box is touched" {
  box_age_days 7
  export STUB_COSIGN_EXIT=1
  run_update
  [ "$status" -ne 0 ]
  [[ "$(calls)" != *"distrobox assemble"* ]]
  [[ "$output" != *"apps box updated"* ]]
}

@test "a failed pull aborts before the box is touched" {
  box_age_days 7
  export STUB_PULL_EXIT=125
  run_update
  [ "$status" -ne 0 ]
  [[ "$(calls)" != *"cosign verify"* ]]
  [[ "$(calls)" != *"distrobox assemble"* ]]
}

@test "the previous image is removed when the rebuild changed it" {
  box_age_days 7
  run_update
  assert_rebuild_exit
  [[ "$(calls)" == *"podman rmi oldimage"* ]]
}

@test "the image is kept when the rebuild did not change it" {
  box_age_days 7
  export STUB_NEW_IMAGE=oldimage
  run_update
  assert_rebuild_exit
  [[ "$(calls)" != *"podman rmi"* ]]
}

@test "a rebuild clears the nudge and offer markers" {
  box_age_days 7
  mkdir -p "$(state_dir)"
  touch "$(state_dir)/nudged-0123456789ab" "$(state_dir)/offered-signal-desktop-7.1.0"
  run_update
  assert_rebuild_exit
  [ -z "$(ls -A "$(state_dir)")" ]
}

@test "a launcher missing after the rebuild is reinstalled and re-exported" {
  box_age_days 7
  export STUB_ASSEMBLE_MISSING="com.anthropic.Claude.desktop"
  run_update
  assert_rebuild_exit
  [[ "$output" == *"Launcher for /usr/share/applications/com.anthropic.Claude.desktop is missing; retrying install and export"* ]]
  [[ "$(calls)" == *"distrobox enter apps -- sudo /usr/libexec/appbox/claude-desktop-sync"* ]]
  [[ "$(calls)" == *"distrobox enter apps -- distrobox-export --app /usr/share/applications/com.anthropic.Claude.desktop"* ]]
  [[ "$(calls)" != *"--app /usr/share/applications/signal-desktop.desktop"* ]]
  [ -e "$HOME/.local/share/applications/apps-com.anthropic.Claude.desktop" ]
  [[ "$(calls)" == *"apps box updated Claude and Signal are ready."* ]]
}

@test "a launcher that still cannot be exported fails the run with a critical notification" {
  box_age_days 7
  export STUB_ASSEMBLE_MISSING="com.anthropic.Claude.desktop" STUB_EXPORT_FAIL=1
  run_update
  [ "$status" -eq 1 ]
  [[ "$(calls)" == *"notify-send -a appbox -i system-software-update -u critical apps box updated, but a launcher is missing"* ]]
  [[ "$(calls)" != *"Claude and Signal are ready."* ]]
}

# --- guarded apps block the rebuild ---------------------------------------

@test "the running-app check looks for exactly the guarded apps" {
  box_age_days 7
  run_update
  [[ "$(calls)" == *"pgrep -x claude-desktop|signal-desktop"* ]]
}

@test "a due rebuild is skipped while Signal runs in the box" {
  box_age_days 7
  export STUB_RUNNING="signal-desktop"
  run_update
  [ "$status" -eq 0 ]
  [[ "$output" == *"(pid $STUB_APP_PID) is running in 'apps'. Will retry next run."* ]]
  assert_no_rebuild
}

@test "a due rebuild is skipped while Claude runs in the box" {
  box_age_days 7
  export STUB_RUNNING="claude-desktop"
  run_update
  [ "$status" -eq 0 ]
  [[ "$output" == *"Skipping rebuild: "*"(pid $STUB_APP_PID) is running in 'apps'"* ]]
  assert_no_rebuild
}

@test "--force does not override the running-app check" {
  box_age_days 0
  export STUB_RUNNING="signal-desktop"
  run_update --force
  [ "$status" -eq 0 ]
  [[ "$output" == *"Skipping rebuild:"* ]]
  assert_no_rebuild
}

@test "an app running in another box does not block the rebuild" {
  box_age_days 7
  export STUB_RUNNING_ELSEWHERE="signal-desktop claude-desktop"
  run_update
  assert_rebuild_exit
  [[ "$(calls)" == *"distrobox assemble create --replace"* ]]
}

@test "an app in this box blocks even when another box runs one too" {
  box_age_days 7
  export STUB_RUNNING_ELSEWHERE="signal-desktop" STUB_RUNNING="claude-desktop"
  run_update
  [ "$status" -eq 0 ]
  [[ "$output" == *"Skipping rebuild:"* ]]
  assert_no_rebuild
}

@test "a stopped box is rebuilt without looking for apps" {
  box_age_days 7
  export STUB_BOX_PID=0 STUB_RUNNING="signal-desktop"
  run_update
  assert_rebuild_exit
  [[ "$(calls)" != *"pgrep"* ]]
  [[ "$(calls)" == *"distrobox assemble create --replace"* ]]
}

@test "if podman cannot say whether the box runs, an app is assumed open" {
  box_age_days 7
  export STUB_INSPECT_PID_FAIL=1
  run_update
  [ "$status" -eq 0 ]
  [[ "$output" == *"Skipping rebuild: unknown (could not inspect 'apps') is running in 'apps'"* ]]
  assert_no_rebuild
}

@test "a non-numeric pid from podman also counts as an app open" {
  box_age_days 7
  export STUB_BOX_PID="<no value>"
  run_update
  [ "$status" -eq 0 ]
  [[ "$output" == *"unknown (could not inspect 'apps')"* ]]
  assert_no_rebuild
}

@test "an app opened during the pull cancels the rebuild and falls back to in-place upgrades" {
  box_age_days 7
  export STUB_RUNNING_AFTER_PULL="signal-desktop"
  candidate claude-desktop 1.1.0
  run_update
  [ "$status" -eq 0 ]
  [[ "$output" == *"started in 'apps' during the pull."* ]]
  [[ "$(calls)" == *"podman pull"* ]]
  [[ "$(calls)" != *"distrobox assemble"* ]]
  [[ "$output" == *"Upgrading claude-desktop 1.0.0 -> 1.1.0"* ]]
  [[ "$(calls)" != *"--only-upgrade signal-desktop"* ]]
}

# --- the 7-day and 14-day notifications -------------------------------------

@test "the first skipped rebuild notifies once and leaves a marker" {
  box_age_days 7
  export STUB_RUNNING="signal-desktop"
  run_update
  [ "$status" -eq 0 ]
  [ "$(count_calls 'Weekly apps update is waiting')" -eq 1 ]
  [ -e "$(state_dir)/nudged-0123456789ab" ]
  run_update
  [ "$status" -eq 0 ]
  [ "$(count_calls 'Weekly apps update is waiting')" -eq 1 ]
}

@test "a new box id gets its own first notification" {
  box_age_days 7
  export STUB_RUNNING="signal-desktop"
  mkdir -p "$(state_dir)"
  touch "$(state_dir)/nudged-ffffffffffff"
  run_update
  [ "$(count_calls 'Weekly apps update is waiting')" -eq 1 ]
}

@test "just under twice the maximum age there is no repeat notification" {
  box_age_days 13
  export STUB_RUNNING="signal-desktop"
  mkdir -p "$(state_dir)"
  touch "$(state_dir)/nudged-0123456789ab"
  run_update
  [ "$status" -eq 0 ]
  [[ "$(calls)" != *"notify-send"* ]]
}

@test "at twice the maximum age every skipped run notifies" {
  box_age_days 14
  export STUB_RUNNING="signal-desktop"
  run_update
  run_update
  [ "$status" -eq 0 ]
  [ "$(count_calls 'notify-send .*apps box is 14 days old')" -eq 2 ]
}

@test "twice the maximum age follows APPBOX_MAX_AGE_DAYS" {
  host_env "APPBOX_MAX_AGE_DAYS=3"
  box_age_days 6
  export STUB_RUNNING="claude-desktop"
  run_update
  [ "$status" -eq 0 ]
  [ "$(count_calls 'apps box is 6 days old')" -eq 1 ]
}

@test "markers go under XDG_STATE_HOME when it is set" {
  box_age_days 7
  export STUB_RUNNING="signal-desktop" XDG_STATE_HOME="$SANDBOX/xdg-state"
  run_update
  [ -e "$SANDBOX/xdg-state/appbox/nudged-0123456789ab" ]
}

@test "a failing notify-send (no desktop session) does not fail the run" {
  box_age_days 7
  export STUB_RUNNING="signal-desktop" STUB_NOTIFY_FAIL=1
  run_update
  [ "$status" -eq 0 ]
  [[ "$(calls)" == *"notify-send"* ]]
  [[ "$output" == *"Skipping rebuild:"* ]]
}

# --- in-place upgrades of closed apps ---------------------------------------

@test "apt lists are refreshed in the box before checking versions" {
  run_update
  [ "$status" -eq 0 ]
  [[ "$(calls)" == *"distrobox enter apps -- sudo apt-get -qq -o Acquire::Retries=2 update"* ]]
}

@test "apps already at the candidate version are left alone" {
  run_update
  [ "$status" -eq 0 ]
  [[ "$output" == *"claude-desktop 1.0.0 is up to date"* ]]
  [[ "$output" == *"signal-desktop 7.0.0 is up to date"* ]]
  [[ "$(calls)" != *"--only-upgrade"* ]]
}

@test "an app with no install candidate is treated as up to date" {
  candidate signal-desktop "(none)"
  run_update
  [ "$status" -eq 0 ]
  [[ "$output" == *"signal-desktop 7.0.0 is up to date"* ]]
  [[ "$(calls)" != *"--only-upgrade"* ]]
}

@test "a closed app with an update is upgraded in place, non-interactively" {
  candidate signal-desktop 7.1.0
  run_update
  [ "$status" -eq 0 ]
  [[ "$output" == *"Upgrading signal-desktop 7.0.0 -> 7.1.0"* ]]
  [[ "$(calls)" == *"distrobox enter apps -- sudo env DEBIAN_FRONTEND=noninteractive apt-get -y -q install --only-upgrade signal-desktop"* ]]
  [ "$(cat "$STATE/installed/signal-desktop")" = "7.1.0" ]
}

@test "an open app with an update is left alone and gets one notification per version" {
  candidate signal-desktop 7.1.0
  export STUB_RUNNING="signal-desktop"
  run_update
  [ "$status" -eq 0 ]
  [[ "$output" == *"signal-desktop 7.1.0 is available, but "*"(pid $STUB_APP_PID) is running; leaving 7.0.0"* ]]
  [[ "$(calls)" != *"--only-upgrade"* ]]
  [[ "$(calls)" == *"notify-send -a appbox -i system-software-update Signal 7.1.0 is ready Quit Signal (tray > Quit)"* ]]
  [ -e "$(state_dir)/offered-signal-desktop-7.1.0" ]
  run_update
  [ "$(count_calls 'Signal 7.1.0 is ready')" -eq 1 ]
  candidate signal-desktop 7.2.0
  run_update
  [ "$(count_calls 'Signal 7.2.0 is ready')" -eq 1 ]
}

@test "only the open app is held back; the closed one is upgraded" {
  candidate signal-desktop 7.1.0
  candidate claude-desktop 1.1.0
  export STUB_RUNNING="claude-desktop"
  run_update
  [ "$status" -eq 0 ]
  [[ "$output" == *"Upgrading signal-desktop 7.0.0 -> 7.1.0"* ]]
  [[ "$output" == *"claude-desktop 1.1.0 is available, but "*"is running; leaving 1.0.0"* ]]
  [[ "$(calls)" != *"--only-upgrade claude-desktop"* ]]
  [[ "$(calls)" == *"Claude 1.1.0 is ready"* ]]
  # The per-app check asks about that one app only.
  [[ "$(calls)" == *"pgrep -x claude-desktop"$'\n'* ]]
}

@test "an app open in another box does not hold back the upgrade" {
  candidate signal-desktop 7.1.0
  export STUB_RUNNING_ELSEWHERE="signal-desktop"
  run_update
  [ "$status" -eq 0 ]
  [[ "$output" == *"Upgrading signal-desktop 7.0.0 -> 7.1.0"* ]]
}

@test "an upgrade clears that app's offer markers" {
  candidate signal-desktop 7.2.0
  mkdir -p "$(state_dir)"
  touch "$(state_dir)/offered-signal-desktop-7.1.0" "$(state_dir)/offered-claude-desktop-1.1.0"
  run_update
  [ "$status" -eq 0 ]
  [ ! -e "$(state_dir)/offered-signal-desktop-7.1.0" ]
  [ -e "$(state_dir)/offered-claude-desktop-1.1.0" ]
}

@test "an app that is not installed in the box is skipped" {
  not_installed claude-desktop
  candidate claude-desktop 1.1.0
  run_update
  [ "$status" -eq 0 ]
  [[ "$(calls)" != *"apt-cache policy claude-desktop"* ]]
  [[ "$(calls)" != *"--only-upgrade claude-desktop"* ]]
  [[ "$output" == *"signal-desktop 7.0.0 is up to date"* ]]
}

@test "a failed upgrade fails the run" {
  candidate signal-desktop 7.1.0
  export STUB_APT_INSTALL_EXIT=100
  run_update
  [ "$status" -ne 0 ]
}

# --- waiting for the network ------------------------------------------------

@test "a network that comes up after a few tries is waited for" {
  export STUB_NET_DOWN_FOR=3
  run_update
  [ "$status" -eq 0 ]
  [ "$(count_calls '^curl ')" -eq 4 ]
  [ "$(count_calls '^sleep 5')" -eq 3 ]
  [[ "$output" == *"Checking for app updates"* ]]
}

@test "no network after 24 tries fails the run so systemd retries it" {
  export STUB_NET_DOWN_FOR=1000
  run_update
  [ "$status" -eq 1 ]
  [[ "$output" == *"Network not reachable after 2 minutes"* ]]
  [ "$(count_calls '^curl ')" -eq 24 ]
  [ "$(count_calls '^sleep 5')" -eq 23 ]
  [[ "$(calls)" != *"distrobox enter"* ]]
}

@test "no network blocks a due rebuild before the pull" {
  box_age_days 7
  export STUB_NET_DOWN_FOR=1000
  run_update
  [ "$status" -eq 1 ]
  assert_no_rebuild
}

# --- one box per ini, init hook retry, notification texts -------------------

@test "an ini with more than one section is refused before any podman or network call" {
  printf '[apps]\nimage=ghcr.io/danathar/appbox:latest\n[work]\nimage=ghcr.io/example/other:latest\n' >"$REPO/hosts/testbox.ini"
  host_env "APPBOX_INI=hosts/testbox.ini"
  box_age_days 7
  run_update --force
  [ "$status" -eq 1 ]
  [[ "$output" == *"$REPO/hosts/testbox.ini has 2 [sections]; appbox-update manages one box per ini"* ]]
  [[ "$(calls)" != *"podman"* ]]
  [[ "$(calls)" != *"distrobox"* ]]
  [[ "$(calls)" != *"curl"* ]]
}

@test "a launcher missing after the rebuild retries the ini's own init hook" {
  printf '%s\n' '[apps]' 'image=ghcr.io/danathar/appbox:latest' 'init_hooks=/usr/libexec/appbox/other-sync' \
    'exported_apps=/usr/share/applications/other.desktop' >"$REPO/hosts/testbox.ini"
  host_env "APPBOX_INI=hosts/testbox.ini"
  box_age_days 7
  export STUB_ASSEMBLE_MISSING="other.desktop"
  run_update
  assert_rebuild_exit
  [[ "$(calls)" == *"distrobox enter apps -- sudo sh -c /usr/libexec/appbox/other-sync"* ]]
  [[ "$(calls)" != *"claude-desktop-sync"* ]]
  [[ "$(calls)" == *"distrobox-export --app /usr/share/applications/other.desktop"* ]]
}

@test "an ini without init_hooks only re-exports a missing launcher" {
  printf '%s\n' '[apps]' 'image=ghcr.io/danathar/appbox:latest' \
    'exported_apps=/usr/share/applications/signal-desktop.desktop' >"$REPO/hosts/testbox.ini"
  host_env "APPBOX_INI=hosts/testbox.ini"
  box_age_days 7
  export STUB_ASSEMBLE_MISSING="signal-desktop.desktop"
  run_update
  assert_rebuild_exit
  [[ "$(calls)" != *"sudo sh -c"* ]]
  [[ "$(calls)" != *"claude-desktop-sync"* ]]
  [[ "$(calls)" == *"distrobox-export --app /usr/share/applications/signal-desktop.desktop"* ]]
}

@test "the notification texts name the apps from guarded_apps" {
  sed -i 's/^guarded_apps=.*/guarded_apps="signal-desktop claude-desktop foo-app"/' "$REPO/host/appbox-update"
  box_age_days 14
  export STUB_RUNNING="signal-desktop"
  run_update --force
  [[ "$(calls)" == *"Quit Signal, Claude and foo-app (tray > Quit)"* ]]
  box_age_days 7
  export STUB_RUNNING=""
  run_update --force
  [[ "$(calls)" == *"Updating the apps box Signal, Claude and foo-app will be back"* ]]
  [[ "$(calls)" == *"apps box updated Signal, Claude and foo-app are ready."* ]]
}
