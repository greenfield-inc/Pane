// A TCP proxy that holds every chunk for DELAY ms in each direction, in order, so a loopback
// host answers like one a round trip of 2 × DELAY away.
//
//   node delay-proxy.mjs <listen-port> <target-port> <delay-ms>
import net from 'node:net';

const [listen, target, delay] = process.argv.slice(2).map(Number);
if (!listen || !target || Number.isNaN(delay)) {
  console.error('Usage: node delay-proxy.mjs <listen-port> <target-port> <delay-ms>');
  process.exit(1);
}

net.createServer(client => {
  const upstream = net.connect(target, '127.0.0.1');
  const pipe = (from, to) => {
    from.on('data', chunk => setTimeout(() => { if (!to.destroyed) to.write(chunk); }, delay));
    from.on('end', () => setTimeout(() => to.end(), delay));
    from.on('error', () => to.destroy());
    from.on('close', () => setTimeout(() => to.destroy(), delay + 5));
  };
  pipe(client, upstream);
  pipe(upstream, client);
}).listen(listen, '127.0.0.1');
