# A stand-in for Claude Code's fullscreen UI, for measure-latency.mjs. Like Claude Code 2.1.x it uses the
# alternate screen with mouse modes 1000/1002/1003/1006, scrolls 3 lines per wheel notch, and redraws the
# whole screen once per read. The status line reports what the measurement needs: TOP=<first line shown>,
# K=<keys received>, W=<wheel notches received>, R=<reads>. Ctrl+C exits. No dependencies (stdlib only).
import os, re, shutil, sys, termios, tty

LINES = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
MOUSE = re.compile(rb'\x1b\[<(\d+);(\d+);(\d+)([Mm])')
fd = sys.stdin.fileno()
saved = termios.tcgetattr(fd)
tty.setraw(fd)
out = sys.stdout.buffer
state = {'top': None, 'keys': 0, 'wheel': 0, 'reads': 0, 'typed': ''}


def render():
    cols, rows = shutil.get_terminal_size((120, 30))
    body = max(1, rows - 1)
    if state['top'] is None:
        state['top'] = max(0, LINES - body)
    state['top'] = min(max(0, state['top']), max(0, LINES - body))
    parts = [b'\x1b[H']
    for i in range(body):
        n = state['top'] + i + 1
        text = ('line %6d ' % n) + ('.' * cols)
        parts.append(b'\x1b[2K\x1b[38;5;%dm%s\x1b[0m\r\n' % (16 + n % 200, text[:cols - 1].encode()))
    status = 'TOP=%d K=%d W=%d R=%d > %s' % (state['top'], state['keys'], state['wheel'], state['reads'], state['typed'][-40:])
    parts.append(b'\x1b[2K\x1b[7m' + status[:cols - 1].encode() + b'\x1b[0m')
    out.write(b''.join(parts))
    out.flush()


out.write(b'\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?25l')
render()
try:
    while True:
        data = os.read(fd, 65536)
        if not data or b'\x03' in data:
            break
        state['reads'] += 1
        for match in MOUSE.finditer(data):
            button = int(match.group(1))
            if button == 64:
                state['wheel'] += 1
                state['top'] -= 3
            elif button == 65:
                state['wheel'] += 1
                state['top'] += 3
        for ch in MOUSE.sub(b'', data).decode('utf-8', 'replace'):
            if ch == '\x15':
                state['typed'] = ''
            elif ch == '\x7f':
                state['typed'] = state['typed'][:-1]
            elif ch.isprintable():
                state['keys'] += 1
                state['typed'] += ch
        render()
finally:
    out.write(b'\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l')
    out.flush()
    termios.tcsetattr(fd, termios.TCSADRAIN, saved)
