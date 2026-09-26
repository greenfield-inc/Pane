# Native Pane mobile companion

`mobile/` is a Capacitor companion that bundles `frontend/remote.html`; it never navigates a WebView to a remote host. Remote hosts are ordinary authenticated HTTP/SSE endpoints, so an arbitrary host never receives a privileged native bridge.

## Development

Use Node 22 and pnpm:

```bash
pnpm mobile:sync
pnpm mobile:build:ios
pnpm mobile:build:android
```

The first command builds the Remote Pane entrypoint and copies it to `mobile/www/` before syncing checked-in iOS and Android projects. iOS Simulator builds need Xcode. Android builds need `ANDROID_HOME` plus a JDK (Android Studio's bundled JBR is suitable).

For a first local Android build on macOS:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
# Install the complete API 36 platform (including android.jar), build tools,
# and accept its licenses in Android Studio's SDK Manager before this command.
# Equivalent command-line setup when cmdline-tools is installed:
# "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "platforms;android-36" "build-tools;36.0.0"
pnpm mobile:build:android
```

`mobile:build:ios` is a non-signing Simulator build. To run it, select a booted simulator in Xcode or use `xcrun simctl boot <device-udid>` first. It is not a substitute for a signed-device push test.

Profiles and bearer tokens are in Keychain on iOS and EncryptedSharedPreferences on Android. Native profile removal makes a best-effort authenticated per-installation revoke before deleting the local bearer token; if the host is unreachable, rotate that host's pairing credential to revoke it server-side. Browser PWA storage remains browser `localStorage`.

Voice dictation uses the transcription provider configured on the host. iOS declares its microphone purpose in `Info.plist`; Android declares `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`, which Capacitor requests when recording starts. Test both allowing and denying microphone access on a device before distributing a mobile build. The launcher icons reuse the existing opaque 1024px Pane artwork in `main/assets/icon.png`.

## Push delivery operator setup

Push is host-originated: killed-app delivery is an APNs alert (iOS) or FCM notification payload (Android), not a local notification or background JavaScript claim. The host sends generic text and routing metadata; see the payload details below.

For iOS, register `com.dcouple.pane.mobile` (or your signed bundle identifier), enable Push Notifications, add the capability in Xcode, and set these only in the host service environment:

```bash
PANE_APNS_TEAM_ID=... PANE_APNS_KEY_ID=... PANE_APNS_KEY_PATH=/secure/path/AuthKey.p8 PANE_APNS_TOPIC=com.dcouple.pane.mobile PANE_APNS_ENVIRONMENT=sandbox
```

Use `PANE_APNS_ENVIRONMENT=production` only for a production/TestFlight-signed build. The checked-in Debug entitlement uses the APNs sandbox and the Release entitlement uses production. Never place the `.p8` key in this repository, the app bundle, or a mobile build setting.

For Android, create a Firebase Android app with the same application ID, download its real `google-services.json` to `mobile/android/app/google-services.json` (the checked-in `.example` is only a shape guide), and create a narrowly scoped service account with Firebase Cloud Messaging send permission. Set `PANE_FCM_SERVICE_ACCOUNT_PATH=/secure/path/service-account.json` in the host service environment. Do not commit either provider credential.

The app asks notification permission after a successful paired connection. Notification setup runs independently of the terminal connection, so permission or provider errors leave remote terminal use available. Registration renewals preserve the installation's alert preferences and deduplication history. OS token registration and each provider network request time out after 15 seconds.

Push-state writes merge with the latest host configuration inside the serialized config-write queue, so they cannot restore a concurrently revoked pairing. Hosts without registered mobile clients do not persist push state on every agent transition.

The daemon sends generic APNs/FCM alert text for both a newly blocked turn and a `working → idle` completion. Tap metadata contains the client-local profile ID (including its host label, URL, and token suffix) and pane/panel IDs; no terminal output or full bearer token is sent. A tap is held in encrypted native storage until saved profiles load, then reconnects only to the matching saved profile, including when switching panels inside the selected pane. An unknown/deleted profile or pane produces an error without connecting to an unrecognized host. Push commands derive client identity from the authenticated request, ignoring caller-supplied identity arguments.

The host reuses APNs authentication for 50 minutes and keeps an HTTP/2 connection per APNs environment. FCM access tokens are reused until shortly before their reported expiry; changing provider credentials invalidates the matching cache. Routine panel status changes remain in bounded memory. Registration settings and recent delivery receipts are persisted, and provider requests run outside the registration mutation queue so a slow delivery does not block token rotation or notification controls.

Provider credentials, Apple signing, Firebase setup, and physical-device delivery cannot be validated by this repository alone. In Apple Developer, create an App ID matching the final bundle ID, enable Push Notifications, create an APNs auth key, and configure an App Store Connect record/signing team before TestFlight upload. In Google Play/Firebase, create the Android app and protect the service-account file outside the app build. iOS Simulator builds do not prove APNs delivery; Android emulators similarly do not prove a real FCM token path. Missing host delivery configuration produces an actionable registration error while ordinary remote terminal use continues.
