import type { NotificationAction } from 'expo-notifications';

import { createFetchEventStreamTransport, type RemoteFetch } from '@shared/remoteClient';
import type { NotifyRemoteCommand } from '@shared/types/notify';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';
import { boundary, decodeOptionalBoundary } from '@shared/validation/boundaryDecoder';

import type { NotifyPush } from '@/features/links/links';

/**
 * D-13: when answering from an iPhone alert in the background proves unreliable, set this to
 * true. Each iPhone button then opens Pane, which sends the same answer from the foreground.
 * Android always answers in the background. The notification service extension copies this
 * choice from the approve category, so this is the only switch.
 */
export const IOS_BUTTONS_OPEN_APP = false;

/** Categories the host names in `aps.category` (main/src/daemon/mobilePushSender.ts). */
export const NOTIFY_CATEGORY = { approve: 'pane.notify.approve', ask: 'pane.notify.ask', options: 'pane.notify.options' } as const;

/** Action identifiers; `choice.<n>` indexes the alert's `notifyChoices`. targets/notify-service uses the same ones. */
const ACTION = { approve: 'approve', deny: 'deny', reply: 'reply', choice: 'choice.' } as const;

export interface NotifyCategory {
  identifier: string;
  actions: NotificationAction[];
}

/**
 * The fixed button sets, registered when the app starts. No action asks to unlock first: answering
 * from the lock screen is allowed (D-12).
 */
export function notifyCategories(opensApp: boolean): NotifyCategory[] {
  const options = { opensAppToForeground: opensApp, isAuthenticationRequired: false };
  return [
    {
      identifier: NOTIFY_CATEGORY.approve,
      actions: [
        { identifier: ACTION.approve, buttonTitle: 'Approve', options },
        { identifier: ACTION.deny, buttonTitle: 'Deny', options: { ...options, isDestructive: true } },
      ],
    },
    {
      identifier: NOTIFY_CATEGORY.ask,
      actions: [{ identifier: ACTION.reply, buttonTitle: 'Reply', textInput: { submitButtonTitle: 'Send', placeholder: 'Your answer' }, options }],
    },
  ];
}

/** One question's choice buttons, under a category of its own so two alerts never share labels. */
export function optionsCategory(notifyId: string, labels: string[], opensApp: boolean): NotifyCategory {
  return {
    identifier: `${NOTIFY_CATEGORY.options}.${notifyId}`,
    actions: labels.slice(0, 3).map((label, index) => ({
      identifier: `${ACTION.choice}${index}`,
      buttonTitle: label,
      options: { opensAppToForeground: opensApp, isAuthenticationRequired: false },
    })),
  };
}

/** The answer a button or Reply sends, or null for a press that isn't one (a tap, an empty reply). */
export function commandForAction(push: NotifyPush, actionIdentifier: string, userText?: string | null): NotifyRemoteCommand | null {
  const id = push.notifyId;
  if (actionIdentifier === ACTION.approve) return { type: 'answer', id, answer: { approved: true } };
  if (actionIdentifier === ACTION.deny) return { type: 'answer', id, answer: { approved: false } };
  if (actionIdentifier === ACTION.reply) {
    const text = userText?.trim();
    return text ? { type: 'answer', id, answer: { text } } : null;
  }
  if (actionIdentifier.startsWith(ACTION.choice)) {
    const choice = push.choices[Number(actionIdentifier.slice(ACTION.choice.length))];
    return choice ? { type: 'answer', id, answer: { choice } } : null;
  }
  return null;
}

/** Who is sending: the same identity the app's live connection uses, so the host names this phone. */
export interface NotifySender {
  fetch: RemoteFetch;
  runtimeId: string;
  clientLabel: string;
  deviceLabel?: string;
}

export type NotifySendResult =
  | { status: 'sent' }
  /** Not sent, and the question may still be waiting: its alert stays, so it can be pressed again. */
  | { status: 'retry'; message: string }
  /** Not sent, and pressing again won't help: the host refused it, or this phone can't send to it. */
  | { status: 'refused'; message: string }
  /** The host may have applied it, but its reply was lost: check the question before answering again. */
  | { status: 'unconfirmed'; message: string };

const SEND_TIMEOUT_MS = 15_000;

const responseSchema = boundary.object({
  ok: boundary.boolean,
  result: boundary.optional(boundary.json),
  error: boundary.optional(boundary.object({ message: boundary.optional(boundary.string) })),
});

/**
 * Sends one `notify:remote-command` straight to `/invoke`, without opening the event stream, so a
 * button pressed while Pane isn't running still answers.
 */
export async function sendNotifyCommand(sender: NotifySender, profile: RemotePaneConnectionProfile, command: NotifyRemoteCommand): Promise<NotifySendResult> {
  const sent = await sendDirect(sender, profile, 'notify:remote-command', [command], {
    unconfirmed: `Your answer may have reached ${profile.label}. Open the question to check before answering again.`,
    refused: `Not sent: ${profile.label} refused the answer. Open Pane to answer there.`,
  });
  return sent.status === 'sent' ? { status: 'sent' } : sent;
}

export type DirectSendResult = { status: 'sent'; result: unknown } | Exclude<NotifySendResult, { status: 'sent' }>;

/**
 * Sends one command straight to a machine's `/invoke`, without opening its event stream: alert
 * buttons, and answers and creates aimed at a machine the phone isn't on. The token travels only
 * in a header. It never retries: once the host may have the request, a lost reply is
 * `unconfirmed`, as with `RemoteUnconfirmedResultError` in the app's live connection. `options`
 * says what to check then, what to do when the host refuses without saying why, and how long to
 * wait for the reply (15 seconds unless `timeoutMs` says otherwise).
 */
export async function sendDirect(
  sender: NotifySender,
  profile: RemotePaneConnectionProfile,
  channel: string,
  args: unknown[],
  options: { unconfirmed: string; refused: string; timeoutMs?: number },
): Promise<DirectSendResult> {
  const unconfirmed = { status: 'unconfirmed' as const, message: options.unconfirmed };
  const { headers, body } = createFetchEventStreamTransport(sender.fetch).invokeRequest({
    baseUrl: profile.baseUrl,
    token: profile.token,
    runtimeId: sender.runtimeId,
    clientLabel: sender.clientLabel,
    deviceLabel: sender.deviceLabel,
  }, channel, args);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? SEND_TIMEOUT_MS);
  try {
    const response = await sender.fetch(`${profile.baseUrl.replace(/\/+$/, '')}/invoke`, { method: 'POST', headers, body, signal: abort.signal })
      .catch(() => null);
    if (!response) {
      // A timeout may leave the request with a slow host; a failed connection is most often a host that is unreachable.
      if (abort.signal.aborted) return unconfirmed;
      return { status: 'retry', message: `Not sent: can't reach ${profile.label}. Try again when it reconnects.` };
    }
    if (response.status === 401 || response.status === 403) {
      return { status: 'refused', message: `Not sent: ${profile.label} no longer accepts this phone. Open Pane and connect to it again.` };
    }
    const payload = decodeOptionalBoundary(await response.json().catch(() => undefined), responseSchema);
    if (!payload) return unconfirmed;
    if (payload.ok) return { status: 'sent', result: payload.result };
    // The host's own words, such as "Already answered on Parsa's MacBook. Nothing was sent."
    return { status: 'refused', message: payload.error?.message ?? options.refused };
  } finally {
    clearTimeout(timer);
  }
}
