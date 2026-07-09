import http from 'node:http';
import { config } from './config.js';

// Railway applies the repo's railway.json to every service built from it, so the
// api and worker services share one start command and pick their role from env.
const role = process.env.ROLE ?? 'api';

if (role === 'worker') {
  await import('./worker.js');

  // The worker has no HTTP surface, but Railway health-checks every service.
  http
    .createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } else {
        res.writeHead(404);
        res.end();
      }
    })
    .listen(config.port, () => console.log(`[worker] health endpoint on :${config.port}`));
} else {
  await import('./server.js');
}
