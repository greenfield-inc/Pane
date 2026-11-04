/** What the OS did with Settings → Notifications' test notification. */
export type TestNotificationResult =
  | { status: 'shown' }
  | { status: 'blocked'; canOpenSettings: boolean }
  | { status: 'failed'; error: string; canOpenSettings: boolean }
  | { status: 'unconfirmed'; canOpenSettings: boolean }
  | { status: 'unsupported' };
