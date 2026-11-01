// jv ui [--port 7071] [--bind ADDRESS]: the read-only viewer (section 10). Serves until Ctrl-C (SIGINT or SIGTERM).
// Loopback by default; for the phone over Tailscale, `jv ui --bind <tailnet address>` (one address, never a
// wildcard). Prints the URL once (with --json: {url, port, bind, readOnly}) and keeps running.

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagInt, flagString } from '../command.js';
import { DEFAULT_BIND, DEFAULT_PORT, isLoopback, startUiServer, tailnetAddresses } from '../ui/server.js';

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const port = flagInt(args, 'port') ?? DEFAULT_PORT;
  const bind = flagString(args, 'bind') ?? DEFAULT_BIND;
  const ui = await startUiServer({ port, bind });
  io.result({ url: ui.url, port: ui.port, bind: ui.bind, readOnly: true }, `jv ui: ${ui.url} (read-only; Ctrl-C stops it)`);
  if (isLoopback(ui.bind)) {
    const tailnet = tailnetAddresses()[0];
    io.info(`Loopback only. For the phone over Tailscale: jv ui --bind ${tailnet ?? '<tailnet address>'}`);
  } else {
    io.info(`Serving on ${ui.bind}: anyone who can reach this address can read the page.`);
  }
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  await ui.close();
  return 0;
}
