# App Privacy answers

**Answer: Data Not Collected.** Tracking: **No**.

Apple counts data as "collected" when it leaves the device in a way that the developer (Dcouple) or its partners can access. Pane sends data only to a Pane host that the user runs on their own computer. Dcouple runs no server that the app talks to.

Evidence comes from `compliance.md` (the compliance research for this listing, 2026-09-25), which cites the `rn-pane-expo-app` branch, and was re-checked against that branch at `c391631c`.

## Data type by data type

| Data type | Leaves the device? | Where it goes | Collected by Dcouple? | Evidence |
| --- | --- | --- | --- | --- |
| Contact info (name, email, phone, address) | No | The app has no accounts or sign-in. | No | compliance.md §2 "Sign-in for review" |
| Audio (voice dictation) | Yes, while dictating | The user's own host, which transcribes it with the provider the user configured on that host (for example their own Deepgram key) | No | `src/features/voice/useVoiceDictation.ts:155`, `liveTranscript.ts` (`/voice/deepgram-stream` on the host's base URL) |
| Other user content (prompts, terminal input) | Yes | The user's own host | No | compliance.md §2, `native/README.md` "Pane has no relay" |
| Device ID (push token) | Yes | The user's own host, which sends the push to Apple (APNs) or Google (FCM) itself | No | `main/src/daemon/mobilePushSender.ts`, native/README.md "Notifications and links" |
| Photos or videos | No | The camera only reads the pairing QR code on the device. No image is sent anywhere. | No | `expo-camera` usage for `scan.tsx` |
| Usage data, analytics | No | No analytics SDK in the app | No | compliance.md: no PostHog, Sentry, Crashlytics or Firebase Analytics in `native/package.json` |
| Diagnostics (crash, performance) | No | No crash SDK in the app | No | same |
| Location, contacts, health, financial, browsing, search history | No | Not accessed | No | compliance.md §2 |
| Identifiers for tracking (IDFA) | No | Not accessed. No ATT prompt. | No | compliance.md intro |

## UNSURE

- **UNSURE: push delivery path.** Today each host sends pushes itself, so Dcouple never receives the device token. The `rn-pane-push-keyless` branch has hosts send Android pushes through Dcouple's Firebase project by impersonating its `pane-push-sender` service account, and iOS hosts use Dcouple's APNs key. The token still goes only from the phone to the user's host, but the push travels under Dcouple's Apple and Google credentials. If a hosted push relay ships (PR #742, tracked in Pane#744) and receives device tokens, change **Device ID** to "Collected, linked to the user: No, used for App Functionality". Confirm with whoever owns push before submitting.
- **UNSURE: transcription provider.** The user's host chooses the speech-to-text service with its own key. If Dcouple ever supplies a shared transcription key or proxy, **Audio Data** becomes collected by a partner. That is not the case on `c391631c`.

## Privacy policy URL

`https://runpane.com/privacy`, the page that exists today. It covers the desktop app and doesn't mention the iOS app. [Pane#744](https://github.com/greenfield-inc/Pane/issues/744) tracks a policy that covers the app.
