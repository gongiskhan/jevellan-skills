// jv project add <path> [--name N] | jv project list

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagString, requirePositional } from '../command.js';
import { refused } from '../errors.js';
import { addProject, listProjectRows } from '../project.js';

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const sub = args.positionals[0];
  if (sub === 'add') {
    const path = requirePositional(args, 1, 'the project path');
    const name = flagString(args, 'name');
    const r = addProject(path, name === undefined ? {} : { name });
    io.result(r, () => {
      const lines = [
        `${r.created ? 'registered' : 'already registered'}: ${r.project.name} (${r.project.id}) at ${r.project.path}, default branch ${r.project.default_branch}` +
          (r.branchChangedFrom !== undefined ? ` (updated from ${r.branchChangedFrom}: the repository default branch changed)` : ''),
        `folder ${r.folder}: ${Object.entries(r.files).map(([f, s]) => `${f} ${s}`).join(', ')}`,
        r.exclude.added.length ? `added to ${r.exclude.file}: ${r.exclude.added.join(' ')}` : `${r.exclude.file} already has the jv lines`,
      ];
      if ('skipped' in r.skills) lines.push(`skills not installed: ${r.skills.skipped}`);
      else {
        for (const h of r.skills.homes) {
          lines.push(`skills in ${h.home}/.claude: ${h.skills} skills, ${h.agents} agent(s), ${h.written} file(s) written`);
        }
      }
      return lines.join('\n');
    });
    return 0;
  }
  if (sub === 'list') {
    const rows = listProjectRows();
    io.result(rows, () =>
      rows.length === 0
        ? 'no projects; add one with jv project add <path>'
        : rows.map((p) => `${p.name}  ${p.id}  ${p.default_branch}  ${p.path}`).join('\n'),
    );
    return 0;
  }
  throw refused(sub === undefined ? 'jv project add <path> [--name N] | jv project list' : `unknown subcommand "project ${sub}"`);
}
