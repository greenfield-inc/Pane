import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { boundary } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { invokeDaemon } from './daemonClient';
import { RunpaneError } from './errors';

/** The CLI's copy of `LinkPreview` and `LinkRedeemResult` in shared/types/relay.ts, which this package cannot import. */
const linkPreviewSchema = boundary.object({
  maker: boundary.string,
  makerGroup: boundary.array(boundary.string),
  here: boundary.array(boundary.string),
  needsConfirm: boundary.boolean,
  expiresAt: boundary.string,
});
const linkRedeemSchema = boundary.object({ linked: boundary.array(boundary.string) });

interface Terminal {
  input: Readable & { isTTY?: boolean };
  output: Writable & { isTTY?: boolean };
}

function names(list: readonly string[]): string {
  return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * `runpane link <link>`: redeems a one-time link through this computer's Pane, so this computer and
 * the one that made the link (with everything linked to it) reach each other. When both sides
 * already have linked computers, the two groups join only after the person confirms.
 */
export async function runLink(parsed: ParsedArgs, terminal: Terminal = { input: process.stdin, output: process.stdout }): Promise<number> {
  const link = parsed.pairingLink?.trim();
  if (!link) {
    throw new RunpaneError(
      'ERR_RUNPANE_INVALID_ARGUMENT',
      'runpane link needs the link to redeem. Nothing was linked.',
      'Copy a link in Pane on the other computer (Add a device › Computer), then run: runpane link \'<link>\'',
    );
  }
  const options = { paneDir: parsed.paneDir };
  const preview = await invokeDaemon('relay:link-preview', [{ link }], linkPreviewSchema, options);
  if (preview.needsConfirm && !parsed.yes) {
    const joins = preview.here.length
      ? `This link joins your computers (${names(preview.here)}) with ${preview.maker}'s (${names(preview.makerGroup)}), and each can then run agents on the others.`
      : `This link lets ${preview.maker}'s computers (${names(preview.makerGroup)}) run agents on this computer, and this computer run agents on them.`;
    if (parsed.json || !terminal.input.isTTY || !terminal.output.isTTY) {
      throw new RunpaneError(
        'ERR_LINK_NEEDS_CONFIRM',
        `${joins} This shell cannot ask you to confirm, so nothing was linked and the link is still unused.`,
        'Run it again with --yes to join them: runpane link \'<link>\' --yes',
      );
    }
    const prompt = createInterface({ input: terminal.input, output: terminal.output });
    let answer: string;
    try {
      answer = (await prompt.question(`${joins}\nLink with ${preview.maker}? [y/N] `)).trim().toLowerCase();
    } finally {
      prompt.close();
    }
    if (answer !== 'y' && answer !== 'yes') {
      throw new RunpaneError(
        'ERR_LINK_CANCELLED',
        'You did not confirm, so nothing was linked. The link is still unused.',
        'Run runpane link again to link them, or let another device use the link.',
      );
    }
  }
  const { linked } = await invokeDaemon('relay:redeem-link', [{ link }], linkRedeemSchema, options);
  if (parsed.json) {
    terminal.output.write(`${JSON.stringify({ ok: true, maker: preview.maker, linked }, null, 2)}\n`);
  } else {
    terminal.output.write(`Linked with ${names(linked.length ? linked : [preview.maker])}. List them with: runpane workspace list\n`);
  }
  return 0;
}
