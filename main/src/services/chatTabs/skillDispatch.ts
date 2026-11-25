/*
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code, commit 2808e878d), apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts.
 *
 * MIT License
 *
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { ContentBlock } from '@agentclientprotocol/sdk';
import { skillName, skillNames, skillReferences } from '../../../../shared/composerMentions';
import type { ChatTabCommand } from '../../../../shared/types/chatTab';

export interface PromptBody { text?: string; images?: Array<{ mimeType: string; data: string }> }

/** A queued message as ACP prompt content, as typed. */
export function promptContent(body: PromptBody): ContentBlock[] {
  return [...textBlocks(body.text ? [body.text] : []), ...imageBlocks(body)];
}

/**
 * The content an agent is sent. Claude expands one skill per message, only where `/name` starts the last
 * text part, and everything after the name is its arguments
 * (https://github.com/anthropics/claude-code/issues/87113). So a message that names a skill goes whole, with
 * its skills as `/name`, then its last skill and the text after it as a part of its own, after the images.
 */
export function agentContent(body: PromptBody, commands: readonly ChatTabCommand[], skills: 'meta' | 'dollar' | undefined): ContentBlock[] {
  const parts = skills === 'meta' ? skillParts(body.text ?? '', commands) : undefined;
  return parts ? [...imageBlocks(body), ...textBlocks(parts)] : promptContent(body);
}

function skillParts(text: string, commands: readonly ChatTabCommand[]): string[] | undefined {
  const first = /^\/(\S+)/.exec(text)?.[1];
  // A message that starts with an agent command is that command's.
  if (first && commands.some(command => skillName(command) === first)) return undefined;
  const mentions = skillReferences(text, skillNames(commands));
  const last = mentions.at(-1);
  if (!last) return undefined;
  const rest = text.slice(last.end);
  const command = `/${last.name}${!rest || /^\s/.test(rest) ? rest : ` ${rest}`}`.trimEnd();
  if (!text.slice(0, last.start).trim()) return [command];
  // The whole message comes first, so the request around the skill keeps its sense. A first part that
  // starts with `/skill` would run that skill instead of the last one, so then every skill stays `$name`.
  if (!text.slice(0, mentions[0].start).trim()) return [text.trimEnd(), command];
  let whole = '';
  let at = 0;
  for (const mention of mentions) {
    whole += `${text.slice(at, mention.start)}/${mention.name}`;
    at = mention.end;
  }
  return [`${whole}${text.slice(at)}`.trimEnd(), command];
}

function textBlocks(parts: readonly string[]): ContentBlock[] {
  return parts.map(text => ({ type: 'text', text }));
}

function imageBlocks(body: PromptBody): ContentBlock[] {
  return (body.images ?? []).map(image => ({ type: 'image', mimeType: image.mimeType, data: image.data }));
}

export function contentTexts(content: readonly ContentBlock[]): string[] {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []);
}
