import http from 'node:http';
import { Readable } from 'node:stream';
http
  .createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/index/config.json') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            dl: 'http://127.0.0.1:18574/crates/{crate}/{version}/download',
            api: 'https://crates.io',
          }),
        );
        return;
      }
      const match = path.match(/^\/crates\/([^/]+)\/([^/]+)\/download$/);
      const upstream = match
        ? `https://static.crates.io/crates/${match[1]}/${match[1]}-${match[2]}.crate`
        : 'https://index.crates.io/' + path.replace(/^\/index\//, '');
      const response = await fetch(upstream);
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') || 'application/octet-stream',
      });
      Readable.fromWeb(response.body).pipe(res);
    } catch (e) {
      res.writeHead(502);
      res.end(String(e));
    }
  })
  .listen(18574, '127.0.0.1', () => console.log('Cargo TLS adapter on 127.0.0.1:18574'));
