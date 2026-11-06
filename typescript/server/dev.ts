// Development (agc up runs this through `npm run dev`): the same API, with the UI served by Vite on the same port.
// Saving a UI file updates the page in place; saving a server file restarts this process (node --watch-path=server).
import { getRequestListener } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { createServer as http } from 'node:http';
import { createServer as vite } from 'vite';
import { app } from './app.ts';
import { required } from './env.ts';
import { log } from './log.ts';

const { PORT } = required('PORT');
const server = http();
const ui = await vite({ root: 'web', appType: 'custom', server: { middlewareMode: true, hmr: { server } }, logLevel: 'warn' });
const api = getRequestListener(app.fetch);

server.on('request', (req, res) => {
  const path = req.url ?? '/';
  // The API, sign-in, and agents over MCP (/mcp, its OAuth and metadata): the server. Everything else: the UI.
  if (['/api/', '/auth/', '/mcp', '/oauth/', '/.well-known/oauth-'].some((p) => path.startsWith(p))) return void api(req, res);
  ui.middlewares(req, res, async () => {
    // Not a file Vite serves: a page of the UI.
    const html = await ui.transformIndexHtml(path, readFileSync('web/index.html', 'utf8'));
    res.writeHead(200, { 'content-type': 'text/html', 'x-content-type-options': 'nosniff', 'content-security-policy': "frame-ancestors 'none'" });
    res.end(html);
  });
});

server.listen(Number(PORT), '0.0.0.0', () => log.info('dev server listening', { port: Number(PORT) }));
// DEV-2: node --watch sends SIGTERM and starts the new process only once this one has ended, so end at once. Waiting on
// server.close() waits on any connection a browser holds open (a preconnected socket), and nothing answers for a minute
// or more, until agc restarts the app while the old process still holds the port: EADDRINUSE.
process.on('SIGTERM', () => process.exit(0));
