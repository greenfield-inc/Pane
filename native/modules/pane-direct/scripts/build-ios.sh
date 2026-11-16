#!/bin/bash
# Xcode script phase (ios/PaneDirect.podspec): builds libpane_direct.a from
# the direct/ crate for the platform Xcode is building, into
# build/ios/$PLATFORM_NAME. Needs rustup with aarch64-apple-ios and
# aarch64-apple-ios-sim.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
crate="$(cd "$here/../../../direct" && pwd)"
out="$here/build/ios/$PLATFORM_NAME"

case "$PLATFORM_NAME" in
  iphoneos) target=aarch64-apple-ios ;;
  iphonesimulator) target=aarch64-apple-ios-sim ;;
  *) echo "error: pane-direct: no Rust target for $PLATFORM_NAME" >&2; exit 1 ;;
esac
if [ "$ARCHS" != arm64 ]; then
  echo "error: pane-direct builds arm64 only; Xcode asked for '$ARCHS'. Build for an Apple silicon simulator or a device." >&2
  exit 1
fi

# Xcode's environment (SDKROOT and friends) points host build scripts at the
# iOS SDK, so cargo runs with a clean one.
path="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
if ! PATH="$path" command -v cargo > /dev/null; then
  echo "error: pane-direct needs Rust: install rustup, then rustup target add $target" >&2
  exit 1
fi
target_dir="${CARGO_TARGET_DIR:-$crate/target}"
env -i HOME="$HOME" PATH="$path" DEVELOPER_DIR="${DEVELOPER_DIR:-}" CARGO_TARGET_DIR="$target_dir" \
  IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-16.4}" \
  cargo rustc --manifest-path "$crate/Cargo.toml" --lib --crate-type staticlib \
  --profile mobile --target "$target"

mkdir -p "$out"
# Copy only a changed library, so an unchanged one does not relink the app.
built="$target_dir/$target/mobile/libpane_direct.a"
cmp -s "$built" "$out/libpane_direct.a" || cp "$built" "$out/libpane_direct.a"
