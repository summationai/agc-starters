import { health } from './health.ts';

type Handler = () => unknown;
export const routes = new Map<string, Handler>();
const app = { get: (path: string, h: Handler) => routes.set(`GET ${path}`, h) };
app.get('/api/health', () => health());
