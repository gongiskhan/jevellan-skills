// The redactor: masks every secret jv knows about before text is written to events, reports or logs.
//
// It loads the contents of every file in ~/.jv/secrets and of every keyFile / tokenFile that providers.json names
// (including jev.keyFile), and replaces each value with [redacted]. Values are never printed, logged or returned;
// only the masked text leaves this module. A secret file may hold one value, or several lines (each line is masked
// on its own, and so is the value part of a NAME=value line).
//
// It also loads the OAuth logins that live in provider homes (<home>/.claude/.credentials.json and
// <home>/.codex/auth.json) and the copies jv archived under ~/.jv/archive/credentials/: those are JSON, so every
// string value of 20 characters or more (the token fields) is masked on its own; whole lines would never match.

import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { paths, resolveConfigPath } from './paths.js';

export const REDACTED = '[redacted]';

/** Values shorter than this are not masked: a one or two letter "secret" would mangle every text. */
const MIN_SECRET_LENGTH = 6;

/** String values of a JSON login file at least this long are masked (tokens; not "Bearer", plan names or scopes). */
const MIN_JSON_SECRET_LENGTH = 20;

/** Where jv moves login files it no longer uses (archive, never delete); the redactor masks what is there. */
export const ARCHIVED_CREDENTIALS_DIR = 'credentials';

export interface RedactorSources {
  secretsDir?: string;
  providersFile?: string;
  /** Folder of archived login files, default ~/.jv/archive/credentials. */
  archivedCredentialsDir?: string;
}

function readIfFile(file: string): string | undefined {
  try {
    const st = statSync(file);
    if (!st.isFile()) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function valuesOf(content: string): string[] {
  const out = new Set<string>();
  const whole = content.trim();
  if (whole) out.add(whole);
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    out.add(line);
    const eq = line.indexOf('=');
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, eq).replace(/^export\s+/, ''))) {
      out.add(line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2'));
    }
  }
  return [...out].filter((v) => v.length >= MIN_SECRET_LENGTH);
}

/** Every string value of a JSON document that is long enough to be a token. Not JSON: the line rules. */
export function jsonSecretValues(content: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return valuesOf(content);
  }
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.trim().length >= MIN_JSON_SECRET_LENGTH) out.add(v.trim());
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(doc);
  return [...out];
}

function readProvidersRaw(providersFile: string): { jev?: unknown; providers?: unknown } | undefined {
  const text = readIfFile(providersFile);
  if (text === undefined) return undefined;
  try {
    const config = JSON.parse(text) as unknown;
    return config && typeof config === 'object' ? (config as { jev?: unknown; providers?: unknown }) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The login files in the provider homes providers.json names: <home>/.claude/.credentials.json for the Claude kinds
 * (a claude-endpoint without a home uses ~/.jv/homes/<name>, as parseProviders does) and <home>/.codex/auth.json
 * for Codex. Read raw, so a providers.json that does not validate still has its logins masked.
 */
export function credentialFilesFromProviders(providersFile: string): string[] {
  const c = readProvidersRaw(providersFile);
  if (!c || !Array.isArray(c.providers)) return [];
  const files: string[] = [];
  for (const entry of c.providers) {
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as Record<string, unknown>;
    let home: string | undefined;
    if (typeof p.home === 'string' && p.home.trim() !== '') home = resolveConfigPath(p.home);
    else if (p.kind === 'claude-endpoint' && typeof p.name === 'string') {
      try {
        home = paths.providerHome(p.name);
      } catch {
        home = undefined;
      }
    }
    if (home === undefined) continue;
    if (p.kind === 'claude-subscription' || p.kind === 'claude-endpoint') files.push(join(home, '.claude', '.credentials.json'));
    if (p.kind === 'codex-subscription') files.push(join(home, '.codex', 'auth.json'));
  }
  return files;
}

function filesIn(dir: string): string[] {
  try {
    return readdirSync(dir).map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/** The key and token files providers.json names. Missing or unreadable providers.json gives none. */
export function secretFilesFromProviders(providersFile: string): string[] {
  const config = readProvidersRaw(providersFile);
  if (config === undefined) return [];
  const files: string[] = [];
  const take = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return;
    for (const key of ['keyFile', 'tokenFile'] as const) {
      const v = (entry as Record<string, unknown>)[key];
      if (typeof v === 'string' && v.trim() !== '') files.push(resolveConfigPath(v));
    }
  };
  const c = config as { jev?: unknown; providers?: unknown };
  take(c.jev);
  if (Array.isArray(c.providers)) for (const p of c.providers) take(p);
  return files;
}

export class Redactor {
  private values: string[] = [];

  constructor(values: Iterable<string> = []) {
    this.setValues(values);
  }

  private setValues(values: Iterable<string>): void {
    // Longest first, so a value that contains another is masked whole.
    this.values = [...new Set(values)].filter((v) => v.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
  }

  /** Loads every secret from the secrets folder and the files providers.json names. */
  static load(sources: RedactorSources = {}): Redactor {
    const secretsDir = sources.secretsDir ?? paths.secretsDir;
    const providersFile = sources.providersFile ?? paths.providersFile;
    const files = new Set<string>();
    try {
      for (const name of readdirSync(secretsDir)) files.add(join(secretsDir, name));
    } catch {
      // no secrets folder yet
    }
    for (const f of secretFilesFromProviders(providersFile)) files.add(f);
    const values: string[] = [];
    for (const f of files) {
      const content = readIfFile(f);
      if (content !== undefined) values.push(...valuesOf(content));
    }
    const archived = sources.archivedCredentialsDir ?? join(paths.archiveDir, ARCHIVED_CREDENTIALS_DIR);
    for (const f of [...credentialFilesFromProviders(providersFile), ...filesIn(archived)]) {
      const content = readIfFile(f);
      if (content !== undefined) values.push(...jsonSecretValues(content));
    }
    return new Redactor(values);
  }

  /** How many distinct values are masked (never the values themselves). */
  get size(): number {
    return this.values.length;
  }

  /** The text with every known secret replaced by [redacted]. */
  redact(text: string): string {
    let out = text;
    for (const v of this.values) if (out.includes(v)) out = out.split(v).join(REDACTED);
    return out;
  }

  /** A deep copy of a JSON-like value with every string (and key) redacted. */
  redactValue<T>(value: T): T {
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return this.redact(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[this.redact(k)] = walk(x);
        return out;
      }
      return v;
    };
    return walk(value) as T;
  }

  /** True when the text contains a known secret. */
  leaks(text: string): boolean {
    return this.values.some((v) => text.includes(v));
  }
}

// A process-wide redactor that reloads when the secrets folder or providers.json changes, so a long running
// process (the launcher, the viewer) picks up a key file added after it started.

let cached: { redactor: Redactor; stamp: string } | undefined;

function stampOf(): string {
  const parts: string[] = [];
  const stat = (p: string): Stats | undefined => {
    try {
      return statSync(p);
    } catch {
      return undefined;
    }
  };
  for (const p of [paths.secretsDir, paths.providersFile]) {
    const st = stat(p);
    parts.push(st ? `${st.mtimeMs}:${st.size}` : '-');
  }
  const archived = join(paths.archiveDir, ARCHIVED_CREDENTIALS_DIR);
  for (const f of [
    ...secretFilesFromProviders(paths.providersFile),
    ...credentialFilesFromProviders(paths.providersFile),
    archived,
    ...filesIn(archived),
  ]) {
    const st = stat(f);
    parts.push(st ? `${f}:${st.mtimeMs}:${st.size}` : `${f}:-`);
  }
  try {
    for (const name of readdirSync(paths.secretsDir)) {
      const st = stat(join(paths.secretsDir, name));
      parts.push(st ? `${name}:${st.mtimeMs}:${st.size}` : `${name}:-`);
    }
  } catch {
    // no secrets folder
  }
  return parts.join('|');
}

/** The process-wide redactor for this JV_HOME, reloaded when the secret files change. */
export function defaultRedactor(): Redactor {
  const stamp = stampOf();
  if (!cached || cached.stamp !== stamp) cached = { redactor: Redactor.load(), stamp };
  return cached.redactor;
}

/** Masks every known secret in text. */
export function redact(text: string): string {
  return defaultRedactor().redact(text);
}

/** Masks every known secret in a JSON-like value. */
export function redactValue<T>(value: T): T {
  return defaultRedactor().redactValue(value);
}
