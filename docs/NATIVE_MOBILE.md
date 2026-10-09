# Native Pane mobile companion

`mobile/` is a Capacitor companion that bundles `frontend/remote.html`; it never navigates a WebView to a remote host. Remote hosts are ordinary authenticated HTTP/SSE endpoints, so an arbitrary host never receives a privileged native bridge.

## Development

Use Node 22.18 or newer and pnpm:

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

Voice dictation uses the transcription provider configured on the host. In the Expo app (`native/`), tapping the mic on a host without voice keys opens a sheet that asks for the one key the mode needs (live: Deepgram; recorded: fal), with OpenRouter as an optional key that cleans up the transcript. It saves them to the host through `remote:settings:update`, then starts recording. Saved keys show only as "Set", and Settings › Voice replaces them; see `native/README.md` (The composer). iOS declares its microphone purpose in `Info.plist`; Android declares `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`, which Capacitor requests when recording starts. Test both allowing and denying microphone access on a device before distributing a mobile build. The launcher icons reuse the existing opaque 1024px Pane artwork in `main/assets/icon.png`.

## Push delivery operator setup

Push is host-originated: killed-app delivery is an APNs alert (iOS) or FCM notification payload (Android), not a local notification or background JavaScript claim. The host sends the Pane or Session name and routing metadata; see the payload details below.

For iOS, register `com.dcouple.pane.mobile` (or your signed bundle identifier), enable Push Notifications, and add the capability in Xcode. Then give one host the APNs key in Settings → Integrations → iPhone notifications: choose the `.p8` file and enter the team ID. Pane shares it with your other hosts through your paired devices ([Shared integration keys](SHARED_CREDENTIALS.md)). A host can instead read it from its service environment, which wins over the shared key and is never shared:

```bash
PANE_APNS_TEAM_ID=... PANE_APNS_KEY_ID=... PANE_APNS_KEY_PATH=/secure/path/AuthKey.p8 PANE_APNS_TOPIC=com.dcouple.pane.mobile PANE_APNS_ENVIRONMENT=sandbox
```

Use `PANE_APNS_ENVIRONMENT=production` only for a production/TestFlight-signed build. The checked-in Debug entitlement uses the APNs sandbox and the Release entitlement uses production. Never place the `.p8` key in this repository, the app bundle, or a mobile build setting.

### Dcouple's credentials

These are the provider credentials Dcouple uses for `com.dcouple.pane.mobile`. Only paths and IDs are listed here; the files stay outside git.

- **APNs:** team `FBM5YSF467`, key ID `DGM25BV23X` (team scoped, sandbox and production). The key file is `AuthKey_DGM25BV23X.p8`, kept at `~/.config/pane/apns/` (mode 600) on the machine that created it. Load it once in Settings → Integrations on one host, or copy it to a host outside the repo and set:

  ```bash
  PANE_APNS_TEAM_ID=FBM5YSF467
  PANE_APNS_KEY_ID=DGM25BV23X
  PANE_APNS_KEY_PATH=/secure/path/AuthKey_DGM25BV23X.p8
  PANE_APNS_TOPIC=com.dcouple.pane.mobile
  PANE_APNS_ENVIRONMENT=production   # TestFlight and App Store builds; use sandbox for Expo dev-client builds
  ```

  A host launched as a service reads these from its service environment (systemd unit, launchd plist, or the shell that runs `pnpm daemon:headless`). `mobile:push-status` reports `APNs delivery is configured.` once they're valid.
For Android, create a Firebase Android app with the same application ID and download its real `google-services.json` (to `native/google-services.json` for the Expo app, or `mobile/android/app/google-services.json` for Capacitor; the checked-in `.example` is only a shape guide). The host then needs a way to call FCM as a sender service account. It supports two ways to do that:

**Keyless (recommended).** The host impersonates a sender service account with the operator's own gcloud login, so no key file exists anywhere. This is the only option where the organization policy `iam.disableServiceAccountKeyCreation` is on. For the Pane project (`pane-pwa-preview`) the sender account already exists and has the Firebase Cloud Messaging API Admin role. Each operator needs two things:

```bash
SENDER=pane-push-sender@pane-pwa-preview.iam.gserviceaccount.com
# Once, by a project owner: let this operator mint tokens for the sender, and nothing else.
gcloud iam service-accounts add-iam-policy-binding "$SENDER" --project pane-pwa-preview \
  --member=user:you@example.com --role=roles/iam.serviceAccountTokenCreator
# On the host machine, as that operator: writes ~/.config/gcloud/application_default_credentials.json
gcloud auth application-default login
```

Then set these in the host service environment:

```bash
PANE_FCM_IMPERSONATE_SERVICE_ACCOUNT=pane-push-sender@pane-pwa-preview.iam.gserviceaccount.com PANE_FCM_PROJECT_ID=pane-pwa-preview
```

For each send, the host exchanges the refresh token from that login for a user access token, then calls the IAM Credentials API `generateAccessToken` for the sender with the `firebase.messaging` scope. It sends the message with that one-hour token. The login file is read from `GOOGLE_APPLICATION_CREDENTIALS` if that is set, otherwise from gcloud's default location. It must be an `authorized_user` login. Revoking the Token Creator binding, or running `gcloud auth application-default revoke`, stops delivery. Pane reports FCM as not configured when the login file is missing or unreadable.

For your own Firebase project, create a sender service account with `roles/firebasecloudmessaging.admin` on that project. Then grant Token Creator on that service account only, never at the project level.

**Service-account key.** Where key creation is allowed, `PANE_FCM_SERVICE_ACCOUNT_PATH=/secure/path/service-account.json` still works and takes precedence over impersonation.

Do not commit any provider credential. CI gets the Firebase app config from the `PANE_ANDROID_GOOGLE_SERVICES_JSON` secret (see `native/README.md`); that file identifies the app and is not a sending credential.

The app asks notification permission after a successful paired connection. Notification setup runs independently of the terminal connection, so permission or provider errors leave remote terminal use available. Registration renewals preserve the installation's alert preferences and deduplication history. OS token registration and each provider network request time out after 15 seconds.

Push-state writes merge with the latest host configuration inside the serialized config-write queue, so they cannot restore a concurrently revoked pairing. Hosts without registered mobile clients do not persist push state on every agent transition.

Only agent panels send alerts, never plain shells. The name is the Session's for a Session's orchestrator, "<Session> › <Pane>" for a Pane associated with a Session, and the Pane's otherwise. A newly blocked agent sends "<name> is blocked" at once. A finished turn sends "<name> needs your attention" only for a turn a person started and only once: input ending in Enter through `terminal:input` (desktop, phone, remote web) or `runpane panels submit|input --source user` arms the panel, and the next finished turn disarms it. Turns an agent starts by itself (watchers, timers, `runpane` input without `--source user`) finish silently. A turn counts as finished when the agent showed its own working signal (title spinner or working chrome) and then stayed idle for 10 s; terminal output alone, such as typing or a redraw, never counts. Each Pane has one APNs collapse id and one FCM `tag`, so a newer alert replaces the older one. iOS stacks alerts by `thread-id`, the Session's workspace pane id (`sessionPaneId` in the payload) or the Pane's own id. Opening a Pane in the app removes its delivered alerts, and opening a Session also removes its workers'. Every send logs `[Pane mobile push]` with the platform, the kind and, on failure, the provider's status and reason. Tap metadata contains the client-local profile ID (including its host label, URL, and token suffix) and pane/panel IDs; no terminal output or full bearer token is sent. A tap is held in encrypted native storage until saved profiles load, then reconnects only to the matching saved profile, including when switching panels inside the selected pane. An unknown/deleted profile or pane produces an error without connecting to an unrecognized host. Push commands derive client identity from the authenticated request, ignoring caller-supplied identity arguments.

The Expo app in `native/` uses the same host commands and payload. It registers the raw APNs/FCM device token, not an Expo push token, and routes taps and `pane-remote://` / `pane://pane/…` links as described in `native/README.md` (Notifications and links).

Provider credentials, Apple signing, Firebase setup, and physical-device delivery cannot be validated by this repository alone. In Apple Developer, create an App ID matching the final bundle ID, enable Push Notifications, create an APNs auth key, and configure an App Store Connect record/signing team before TestFlight upload. In Google Play/Firebase, create the Android app and give the host a sender identity as described above. iOS Simulator builds do not prove APNs delivery; A Google Play system image in the Android emulator does receive real FCM messages, so the Android path can be checked end to end without a device. Missing host delivery configuration produces an actionable registration error while ordinary remote terminal use continues.
