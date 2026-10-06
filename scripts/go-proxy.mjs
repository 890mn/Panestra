// Local TLS transport adapter for Windows environments where Go's TLS transport fails.
// Node validates upstream HTTPS; Go still verifies modules with the checksum database.
import http from 'node:http';
import { Readable } from 'node:stream';
const server = http.createServer(async (req, res) => {
  try {
    const response = await fetch(`https://proxy.golang.org${req.url}`);
    res.writeHead(response.status, {
      'content-type': response.headers.get('content-type') || 'application/octet-stream',
    });
    Readable.fromWeb(response.body).pipe(res);
  } catch (e) {
    res.writeHead(502);
    res.end(String(e));
  }
});
server.listen(18573, '127.0.0.1', () => console.log('Go TLS adapter on 127.0.0.1:18573'));
