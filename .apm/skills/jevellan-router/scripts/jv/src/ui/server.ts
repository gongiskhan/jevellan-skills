// jv ui (section 10): a read-only local web page over the store. node:http, no framework, no build step.
//
// - Pages /, /task/T, /session/R, /decisions and /usage all serve ui/index.html from the runtime folder (not compiled);
//   the page script reads the path and fetches the JSON endpoints under /api/. Static files are the plain names in
//   ui/ (no folders).
// - Live updates: /api/live is a Server-Sent Events stream. One poller per server reads the store every second
//   (PRAGMA data_version, plus the sessions whose process is gone, which turn into lost dots without any write) and
//   sends `change` to every client when either moved; the page then fetches its endpoint again.
// - Read only: the only connection is ReadOnlyStore (SQLite refuses writes on it), there is no route that changes
//   anything, and every method but GET and HEAD is 405. Lost sessions are shown as lost without marking them.
// - Nothing secret is served: the store holds none (every writer redacts), JSON goes through the redactor once more,
//   and the only files served besides ui/ are images under a task worktree's .jv-evidence/ (evidence.ts).
// - Loopback by default. --bind takes one IP address (the tailnet address for the phone); wildcard addresses are
//   refused. The Host header must be an IP literal, localhost, this machine's name or a *.ts.net name, so a page on
//   another site cannot read the viewer through DNS rebinding.

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP, type Socket } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { JvError, refused } from '../errors.js';
import { normalizeId } from '../ids.js';
import { paths, RUNTIME_ROOT } from '../paths.js';
import { defaultRedactor } from '../redact.js';
import type { SessionRow } from '../types.js';
import { checkReadable, ReadOnlyStore, StoreUnavailable } from './db.js';
import { resolveEvidence } from './evidence.js';
import { decisions, lostCandidates, overview, sessionPage, taskDetail, usage, type ViewOptions } from './views.js';

export const DEFAULT_PORT = 7071;
export const DEFAULT_BIND = '127.0.0.1';
export const POLL_MS = 1000;
export const HEARTBEAT_MS = 15_000;

export interface UiServerOptions {
  /** Default 7071; 0 picks a free port. */
  port?: number;
  /** One IP address, default 127.0.0.1. */
  bind?: string;
  /** Store file, default $JV_HOME/store.sqlite. */
  storeFile?: string;
  /** Folder of index.html and its files, default <runtime>/ui. */
  uiDir?: string;
  pollMs?: number;
  heartbeatMs?: number;
  /** Whether a run's process is alive (tests pass a fake). */
  alive?: (s: SessionRow) => boolean;
}

export interface UiServer {
  url: string;
  port: number;
  bind: string;
  server: Server;
  close(): Promise<void>;
}

/** The pages the viewer has; each serves index.html. */
const PAGE_PATTERNS: readonly RegExp[] = [/^\/$/, /^\/task\/[^/]+\/?$/, /^\/session\/[^/]+\/?$/, /^\/decisions\/?$/, /^\/usage\/?$/];
const STATIC_NAME = /^[a-z0-9][a-z0-9.-]*\.(css|js|svg|ico|woff2)$/;
const STATIC_TYPES: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
};

const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Checks a --bind value: one IP address or localhost, never a wildcard. Returns the address to listen on. */
export function validateBind(value: string): string {
  const v = value.trim().replace(/^\[(.*)\]$/, '$1');
  if (v === 'localhost') return '127.0.0.1';
  if (isIP(v) === 0) throw refused(`--bind needs an IP address (for the tailnet: jv ui --bind 100.x.y.z), not "${value}"`);
  if (v === '0.0.0.0' || v === '::' || v === '::0') {
    throw refused('jv ui serves one address, never every interface; pass the tailnet address (jv ui --bind 100.x.y.z)');
  }
  return v;
}

export function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.');
}

/** This machine's Tailscale addresses (100.64.0.0/10), for the hint jv ui prints. */
export function tailnetAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4') continue;
      const [x, y] = a.address.split('.').map(Number);
      if (x === 100 && y !== undefined && y >= 64 && y <= 127) out.push(a.address);
    }
  }
  return out;
}

/** Whether a Host header names this server (see the header: DNS rebinding). */
export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  let name = host.trim().toLowerCase();
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(name);
  if (v6) return isIP(v6[1]!) === 6;
  name = name.replace(/:\d+$/, '');
  if (name === '' ) return false;
  if (isIP(name) !== 0) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  const me = hostname().toLowerCase();
  if (name === me || name.startsWith(`${me}.`)) return true;
  return name.endsWith('.ts.net');
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, head: boolean, extra: Record<string, string> = {}): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': String(buf.length), ...extra });
  res.end(head ? undefined : buf);
}

function sendJson(res: ServerResponse, status: number, data: unknown, head: boolean): void {
  const safe = defaultRedactor().redactValue(data);
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(safe), head, { 'Cache-Control': 'no-store' });
}

function notFoundJson(res: ServerResponse, what: string, head: boolean): void {
  sendJson(res, 404, { error: `no ${what}` }, head);
}

function decoded(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

function query(url: URL, name: string): string | undefined {
  const v = url.searchParams.get(name);
  return v === null || v.trim() === '' ? undefined : v.trim();
}

function intQuery(url: URL, name: string): number | undefined {
  const v = query(url, name);
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
}

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServer> {
  const bind = validateBind(options.bind ?? DEFAULT_BIND);
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw refused(`--port needs a port number, not ${port}`);
  const uiDir = options.uiDir ?? join(RUNTIME_ROOT, 'ui');
  const indexFile = join(uiDir, 'index.html');
  if (!existsSync(indexFile)) throw refused(`the viewer page is missing (${indexFile}); run jv update`);
  const db = new ReadOnlyStore(options.storeFile ?? paths.store);
  checkReadable(db);
  const viewOptions: ViewOptions = options.alive ? { alive: options.alive } : {};
  const pollMs = options.pollMs ?? POLL_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;

  // ---- live stream ----------------------------------------------------------------------------------------------
  const clients = new Set<ServerResponse>();
  let version = 0;
  let token = '';
  const stamp = (): string => {
    const data = db.dataVersion();
    let lost = '';
    try {
      lost = lostCandidates(db, options.alive).join(',');
    } catch {
      lost = '';
    }
    return `${data}|${lost}`;
  };
  const broadcast = (event: string, data: unknown): void => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(frame);
  };
  const poll = (): void => {
    if (clients.size === 0) return;
    const next = stamp();
    if (next === token) return;
    token = next;
    version++;
    broadcast('change', { version, at: new Date().toISOString() });
  };
  const pollTimer = setInterval(poll, pollMs);
  const heartbeatTimer = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, heartbeatMs);
  pollTimer.unref();
  heartbeatTimer.unref();

  function live(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (clients.size === 0) token = stamp();
    clients.add(res);
    res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ version, at: new Date().toISOString() })}\n\n`);
    const drop = (): void => {
      clients.delete(res);
    };
    req.on('close', drop);
    res.on('close', drop);
  }

  // ---- static ---------------------------------------------------------------------------------------------------
  function serveIndex(res: ServerResponse, head: boolean): void {
    const html = readFileSync(indexFile);
    send(res, 200, 'text/html; charset=utf-8', html, head, { 'Cache-Control': 'no-cache', 'Content-Security-Policy': PAGE_CSP });
  }

  function serveStatic(name: string, req: IncomingMessage, res: ServerResponse, head: boolean): void {
    if (!STATIC_NAME.test(name)) return send(res, 404, 'text/plain; charset=utf-8', 'Not found\n', head);
    const file = join(uiDir, name);
    let st;
    try {
      st = statSync(file);
    } catch {
      return send(res, 404, 'text/plain; charset=utf-8', 'Not found\n', head);
    }
    if (!st.isFile()) return send(res, 404, 'text/plain; charset=utf-8', 'Not found\n', head);
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const type = STATIC_TYPES[name.slice(name.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }
    send(res, 200, type, readFileSync(file), head, { ETag: etag, 'Cache-Control': 'no-cache' });
  }

  function serveEvidence(taskId: string, rawPath: string, res: ServerResponse, head: boolean): void {
    const found = resolveEvidence(db, taskId, rawPath);
    if (!found) return send(res, 404, 'text/plain; charset=utf-8', 'Not found\n', head);
    res.writeHead(200, {
      'Content-Type': found.contentType,
      'Content-Length': String(found.size),
      'Cache-Control': 'private, max-age=60',
      'Content-Security-Policy': "default-src 'none'",
    });
    if (head) {
      res.end();
      return;
    }
    const stream = createReadStream(found.file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  // ---- routes -----------------------------------------------------------------------------------------------------
  function handle(req: IncomingMessage, res: ServerResponse): void {
    securityHeaders(res);
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, 405, 'text/plain; charset=utf-8', 'The viewer is read-only.\n', false);
    }
    if (!hostAllowed(req.headers.host)) return send(res, 403, 'text/plain; charset=utf-8', 'Unknown host.\n', false);
    const head = method === 'HEAD';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://viewer.invalid');
    } catch {
      return send(res, 400, 'text/plain; charset=utf-8', 'Bad request\n', head);
    }
    const path = url.pathname;
    try {
      if (path === '/api/live') return live(req, res);
      if (path === '/api/overview') return sendJson(res, 200, overview(db, viewOptions), head);
      let m = /^\/api\/task\/([^/]+)$/.exec(path);
      if (m) {
        const id = normalizeId(decoded(m[1]!) ?? '');
        const view = taskDetail(db, id, viewOptions);
        return view ? sendJson(res, 200, view, head) : notFoundJson(res, `task ${id}`, head);
      }
      m = /^\/api\/session\/([^/]+)$/.exec(path);
      if (m) {
        const id = normalizeId(decoded(m[1]!) ?? '');
        const view = sessionPage(db, id, intQuery(url, 'after') ?? 0, viewOptions);
        return view ? sendJson(res, 200, view, head) : notFoundJson(res, `session ${id}`, head);
      }
      if (path === '/api/decisions') {
        const filter: Parameters<typeof decisions>[1] = {};
        for (const k of ['kind', 'from', 'to', 'project', 'task'] as const) {
          const v = query(url, k);
          if (v !== undefined) filter[k] = k === 'task' ? normalizeId(v) : v;
        }
        const limit = intQuery(url, 'limit');
        if (limit !== undefined) filter.limit = limit;
        return sendJson(res, 200, decisions(db, filter), head);
      }
      if (path === '/api/usage') {
        const weeks = intQuery(url, 'weeks');
        return sendJson(res, 200, usage(db, weeks !== undefined ? { weeks } : {}), head);
      }
      if (path.startsWith('/api/')) return notFoundJson(res, `endpoint ${path}`, head);
      m = /^\/evidence\/([^/]+)\/(.+)$/.exec(path);
      if (m) {
        const taskId = decoded(m[1]!);
        if (taskId === undefined) return send(res, 404, 'text/plain; charset=utf-8', 'Not found\n', head);
        return serveEvidence(normalizeId(taskId), m[2]!, res, head);
      }
      m = /^\/ui\/([^/]+)$/.exec(path);
      if (m) return serveStatic(m[1]!, req, res, head);
      if (path === '/favicon.ico') return serveStatic('favicon.svg', req, res, head);
      if (PAGE_PATTERNS.some((p) => p.test(path))) return serveIndex(res, head);
      return send(res, 404, 'text/plain; charset=utf-8', 'Not found\n', head);
    } catch (error) {
      if (error instanceof StoreUnavailable) {
        if (path.startsWith('/api/')) return sendJson(res, 503, { error: error.message }, head);
        return send(res, 503, 'text/plain; charset=utf-8', `${error.message}\n`, head);
      }
      const message = error instanceof JvError ? error.message : 'internal error';
      if (!(error instanceof JvError)) process.stderr.write(`jv ui: ${defaultRedactor().redact(String((error as Error)?.stack ?? error))}\n`);
      if (res.headersSent) return void res.destroy();
      if (path.startsWith('/api/')) return sendJson(res, 500, { error: message }, head);
      return send(res, 500, 'text/plain; charset=utf-8', `${message}\n`, head);
    }
  }

  const server = createServer(handle);
  server.keepAliveTimeout = 5000;
  const sockets = new Set<Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') reject(refused(`port ${port} on ${bind} is in use; pass another --port`));
      else if (error.code === 'EADDRNOTAVAIL') reject(refused(`${bind} is not an address of this machine`));
      else if (error.code === 'EACCES') reject(refused(`not allowed to listen on ${bind}:${port}`));
      else reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, bind);
  }).catch((error: unknown) => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    db.close();
    throw error;
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const host = bind.includes(':') ? `[${bind}]` : bind;
  let closed = false;
  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    bind,
    server,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      for (const c of clients) c.end();
      clients.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        for (const s of sockets) s.destroy();
      });
      db.close();
    },
  };
}
