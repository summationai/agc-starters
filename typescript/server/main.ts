// Production: the API (app.ts) and the built UI (web/dist) on one port. On SIGTERM it stops taking connections,
// finishes the requests in flight, and exits well inside the 30 seconds agent.cloud gives it.
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync } from 'node:fs';
import { app } from './app.ts';
import { pool } from './db.ts';
import { required } from './env.ts';
import { log } from './log.ts';

const { PORT } = required('PORT');
const index = readFileSync('web/dist/index.html', 'utf8');

app.use('/*', serveStatic({ root: 'web/dist' }));
// Any other path is a page of the UI: it routes on the client, so a reload anywhere still loads the app. PROC-2: except an
// admin-looking path (agent.cloud's review files admin-route-answers for one that answers 2xx), which is no page until the
// app adds one: a route in app.ts, or, for a UI page there, its name taken out of this list (and an admin guard on its API).
const NOT_PAGES = /^\/(admin|internal|debug|_debug|manage|dashboard)(\/|$)/i;
app.get('*', (c) => NOT_PAGES.test(c.req.path) ? c.json({ error: { code: 'not_found', message: 'No such page.' } }, 404) : c.html(index));

const server = serve({ fetch: app.fetch, port: Number(PORT), hostname: '0.0.0.0' }, () => log.info('listening', { port: Number(PORT) }));

process.on('SIGTERM', () => {
  log.info('shutting down');
  setTimeout(() => process.exit(0), 20_000).unref(); // never outlive the platform's grace period
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  if ('closeIdleConnections' in server) (server as { closeIdleConnections: () => void }).closeIdleConnections();
});
