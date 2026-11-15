#!/bin/bash
# Gradle task buildPaneDirect (android/build.gradle): builds libpane_direct.so
# from the direct/ crate for each ABI given, into build/android/jniLibs. Needs
# cargo-ndk and the Rust targets aarch64-linux-android / x86_64-linux-android;
# without them it warns and the app builds without direct connections.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
crate="$(cd "$here/../../../direct" && pwd)"
out="$here/build/android/jniLibs"
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"

if ! command -v cargo-ndk > /dev/null; then
  echo "warning: pane-direct: cargo-ndk is not installed, so this build reaches computers only through the relay. Install Rust, then: cargo install cargo-ndk; rustup target add aarch64-linux-android x86_64-linux-android" >&2
  exit 0
fi

target_dir="${CARGO_TARGET_DIR:-$crate/target}"
cd "$crate"
for abi in "$@"; do
  case "$abi" in
    arm64-v8a) target=aarch64-linux-android ;;
    x86_64) target=x86_64-linux-android ;;
    *) echo "error: pane-direct: no Rust target for $abi" >&2; exit 1 ;;
  esac
  cargo ndk -t "$abi" --platform "${PANE_DIRECT_MIN_SDK:-24}" \
    rustc --lib --crate-type cdylib --profile mobile
  # cargo-ndk's -o would also copy dependencies' unused .so files.
  mkdir -p "$out/$abi"
  cp "$target_dir/$target/mobile/libpane_direct.so" "$out/$abi/"
done
