#!/usr/bin/env bats
# Unit tests for fetch_key in scripts/appbox.sh, the build-time check that a
# vendor's apt signing key is the pinned one. appbox.sh itself is the image
# build and is never run here: only the fetch_key function is read out of it.
# Keys are generated in a scratch GNUPGHOME and served with file:// URLs, so
# nothing touches the network or the user's keyring.

load helpers

setup_file() {
  command -v gpg > /dev/null || return 0
  export GNUPGHOME="$BATS_FILE_TMPDIR/gnupg"
  mkdir -m 700 "$GNUPGHOME"
  local name
  for name in pinned other; do
    gpg --batch --quiet --pinentry-mode loopback --passphrase '' \
      --quick-gen-key "$name <$name@example.invalid>" ed25519 sign never
    gpg --armor --export "$name@example.invalid" > "$BATS_FILE_TMPDIR/$name.asc"
  done
  # The pinned key followed by another, both as two armored blocks and as
  # one block holding both keys.
  cat "$BATS_FILE_TMPDIR/pinned.asc" "$BATS_FILE_TMPDIR/other.asc" > "$BATS_FILE_TMPDIR/appended.asc"
  gpg --armor --export pinned@example.invalid other@example.invalid > "$BATS_FILE_TMPDIR/both.asc"
}

teardown_file() {
  if command -v gpgconf > /dev/null && [ -d "$BATS_FILE_TMPDIR/gnupg" ]; then
    GNUPGHOME="$BATS_FILE_TMPDIR/gnupg" gpgconf --kill gpg-agent || true
  fi
}

setup() {
  # The function only, so the rest of the build script never runs.
  # shellcheck source=/dev/null
  source <(sed -n '/^fetch_key() {$/,/^}$/p' "$SRC/scripts/appbox.sh")
  declare -F fetch_key > /dev/null
  OUT="$BATS_TEST_TMPDIR/keyring.asc"
}

need_gpg() {
  command -v gpg > /dev/null || skip "gpg is not installed"
}

fingerprint_of() {
  gpg --with-colons --list-keys "$1@example.invalid" | awk -F: '/^fpr:/ { print $10; exit }'
}

@test "installs a key file that holds only the pinned key" {
  need_gpg
  run fetch_key "file://$BATS_FILE_TMPDIR/pinned.asc" "$(fingerprint_of pinned)" "$OUT"
  [ "$status" -eq 0 ]
  cmp -s "$OUT" "$BATS_FILE_TMPDIR/pinned.asc"
}

@test "refuses a different key" {
  need_gpg
  run fetch_key "file://$BATS_FILE_TMPDIR/other.asc" "$(fingerprint_of pinned)" "$OUT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Key fingerprint mismatch"* ]]
  [ ! -e "$OUT" ]
}

@test "refuses the pinned key followed by another key in a second armored block" {
  need_gpg
  run fetch_key "file://$BATS_FILE_TMPDIR/appended.asc" "$(fingerprint_of pinned)" "$OUT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Key fingerprint mismatch"* ]]
  [[ "$output" == *"$(fingerprint_of other)"* ]]
  [ ! -e "$OUT" ]
}

@test "refuses one armored block holding the pinned key and another" {
  need_gpg
  run fetch_key "file://$BATS_FILE_TMPDIR/both.asc" "$(fingerprint_of pinned)" "$OUT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Key fingerprint mismatch"* ]]
  [ ! -e "$OUT" ]
}

# A downloaded apt source file names the key apt trusts (its Signed-By line
# can even hold one inline), which would get around fetch_key. Only key files,
# which fetch_key checks, may come from the network.
@test "appbox.sh downloads nothing outside fetch_key" {
  run awk '
    /^fetch_key\(\) \{$/ { inside = 1 }
    inside { if ($0 == "}") inside = 0; next }
    /(^|[^[:alnum:]_-])(curl|wget)([[:space:]]|$)/ { print FILENAME ":" FNR ": " $0 }
  ' "$SRC/scripts/appbox.sh"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
