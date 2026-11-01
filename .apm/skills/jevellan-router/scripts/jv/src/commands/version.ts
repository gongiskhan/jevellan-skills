// jv --version: the package version and the store schema version.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandIo, ParsedArgs } from '../command.js';
import { paths, RUNTIME_ROOT } from '../paths.js';
import { readStoreSchemaVersion, SCHEMA_VERSION } from '../store.js';

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(RUNTIME_ROOT, 'package.json'), 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

export async function run(_args: ParsedArgs, io: CommandIo): Promise<number> {
  const version = packageVersion();
  const storeSchemaVersion = readStoreSchemaVersion(paths.store) ?? null;
  io.result({ version, schemaVersion: SCHEMA_VERSION, storeSchemaVersion, store: paths.store }, () => {
    let line = `jv ${version}\nstore schema ${SCHEMA_VERSION}`;
    if (storeSchemaVersion === null) line += ` (no store yet at ${paths.store})`;
    else if (storeSchemaVersion !== SCHEMA_VERSION) line += ` (the store at ${paths.store} has ${storeSchemaVersion})`;
    return line;
  });
  return 0;
}
