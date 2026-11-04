/** Separate xterm's protocol replies from keystrokes without inspecting a
 * terminal screen. Unknown sequences remain input, never evidence of idleness.
 * Incomplete replies block handoff until their final byte arrives. */
export class NativeInput {
  private pending = '';
  private paste = false;

  incomplete(): boolean { return !!this.pending || this.paste; }

  take(data: string): string {
    const input = this.pending + data;
    this.pending = '';
    let text = '';
    for (let index = 0; index < input.length;) {
      const rest = input.slice(index);
      if (rest.startsWith('\x1b[201~') && this.paste) { this.paste = false; index += 6; continue; }
      if (input[index] !== '\x1b') { text += this.paste && input[index] === '\r' ? '\n' : input[index]; index++; continue; }
      if (rest === '\x1b' || rest === '\x1b[') { this.pending = rest; break; }
      if (!this.paste && ['\x1bP', '\x1b_', '\x1b]'].some(prefix => rest.startsWith(prefix))) {
        const st = rest.indexOf('\x1b\\', 2);
        const bell = rest.indexOf('\x07', 2);
        const end = st < 0 ? bell : bell < 0 ? st : Math.min(st, bell);
        if (end === -1 && rest.length < 4096) { this.pending = rest; break; }
        if (end !== -1) {
          const sequence = rest.slice(0, end + (end === st ? 2 : 1));
          const body = rest.slice(2, end);
          index += sequence.length;
          // Captured xterm version, graphics and color-query responses. Unknown
          // control strings remain input; pasted lookalikes never reach here.
          if ((rest.startsWith('\x1bP') && end === st && /^>\|xterm\.js\([\w.+-]+\)$/.test(body))
            || (rest.startsWith('\x1b_') && end === st && /^Gi=\d+;OK$/.test(body))
            || (rest.startsWith('\x1b]') && /^(?:10|11|12);rgb:[\da-f]{1,4}\/[\da-f]{1,4}\/[\da-f]{1,4}$/i.test(body))) continue;
          text += sequence;
          continue;
        }
      }
      if (rest.startsWith('\x1b[')) {
        const body = /^[0-?]*[ -/]*[@-~]/.exec(rest.slice(2))?.[0];
        const sequence = body === undefined ? undefined : `\x1b[${body}`;
        if (!sequence && rest.length < 128) { this.pending = rest; break; }
        if (sequence) {
          index += sequence.length;
          if (sequence === '\x1b[200~' && !this.paste) { this.paste = true; continue; }
          // Focus, device attributes, window reports and terminal mode
          // reports. Arrow/function keys and bracketed paste text are retained.
          if (!this.paste && /^(?:[IO]|[?>]?[\d;]+c|[\d;]+t|\?[\d;]+\$y|\?\d+u)$/.test(sequence.slice(2))) continue;
          text += sequence;
          continue;
        }
      }
      text += input[index];
      index++;
    }
    return text;
  }
}
