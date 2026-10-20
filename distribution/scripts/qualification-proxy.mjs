// Outbound TLS tunnels for a private-network qualification guest. The host
// listens on an owned Unix socket only; the guest relay exposes loopback only.
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { connect, createServer } from 'node:net';
import { chmod } from 'node:fs/promises';

assert.equal(process.env.ZELAVIS_QUALIFY_DISPOSABLE, '1');
const [mode, socket] = process.argv.slice(2);
assert.ok(['host', 'relay'].includes(mode));
assert.ok(socket?.startsWith('/'));
const connections = new Set();
function own(connection) {
  connections.add(connection);
  connection.once('close', () => connections.delete(connection));
  connection.setTimeout(120_000, () => connection.destroy());
  return connection;
}
function pair(client, upstream) {
  own(client); own(upstream);
  client.once('error', () => upstream.destroy());
  upstream.once('error', () => client.destroy());
  client.once('close', () => upstream.destroy());
  upstream.once('close', () => client.destroy());
  client.pipe(upstream).pipe(client);
}
let server;
if (mode === 'host') {
  const origins = new Set(['nodejs.org', 'registry.npmjs.org', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'zelavis.com', 'www.zelavis.com']);
  server = httpServer({ maxHeaderSize: 16_384 }, (_request, response) => { response.writeHead(405); response.end(); });
  server.on('connect', (request, client, head) => {
    const destination = new URL(`http://${request.url}`);
    if (connections.size >= 64 || destination.port !== '443' || !origins.has(destination.hostname)) {
      console.error(`Refused qualification destination: ${destination.hostname}:${destination.port}`);
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = connect({ host: destination.hostname, port: 443 });
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      pair(client, upstream);
    });
    upstream.once('error', () => client.destroy());
    client.once('error', () => upstream.destroy());
  });
  server.listen(socket, async () => { await chmod(socket, 0o600); console.log('Qualification TLS tunnel ready.'); });
} else {
  server = createServer(client => {
    if (connections.size >= 64) { client.destroy(); return; }
    pair(client, connect(socket));
  });
  server.listen(3128, '127.0.0.1', () => console.log('Qualification loopback relay ready.'));
}
const stop = () => { server.close(); for (const connection of connections) connection.destroy(); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
