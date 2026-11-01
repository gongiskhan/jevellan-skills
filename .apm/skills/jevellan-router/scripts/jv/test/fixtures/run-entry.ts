// The jv entry for detached runs in the launcher tests: the compiled CLI of this build (the installed runtime under
// $JV_HOME/runtime does not exist in a test home).

import { main } from '../../src/cli.js';

process.exitCode = await main(process.argv.slice(2));
