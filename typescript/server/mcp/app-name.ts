// The app's name, from its manifest, read once: what agents see, and the audience of the gate's x-agc-identity (EDGE-15).
import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';

export const APP_NAME = (() => { try { return (parse(readFileSync('agentcloud.toml', 'utf8')) as { app?: { name?: string } }).app?.name || 'This app'; } catch { return 'This app'; } })();
