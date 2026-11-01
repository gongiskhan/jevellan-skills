// Shared fixture of the phase 2 tests: a temporary JV_HOME with a providers.json, made-up secrets, duty skills, a
// worker rules template, and a project/task/step in the store. Every value here is made up; no real secret is read.
// Callers set process.env.JV_HOME before importing anything from src/ (paths.ts resolves it at load).

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from '../../src/store.js';

export const FAKE_TOKEN = 'fake-oauth-token-ABCDEF0123456789';
export const FAKE_KEY = 'fake-endpoint-key-9876543210zyx';

export const RULES_TEMPLATE = [
  'You are working on one step of one task for this project\'s coordinator. Work the way you normally would, in the project "{{project}}" at {{cwd}}.',
  '',
  'Isolation: your own git worktree on branch {{branch}}, based on {{base}}. This session is {{visible}}.',
  '',
  '- Keep the coordinator informed. End every turn with exactly one jv_report.',
].join('\n');

export function makeHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'secrets', 'claude-main.token'), `${FAKE_TOKEN}\n`, { mode: 0o600 });
  writeFileSync(join(home, 'secrets', 'glm.key'), `${FAKE_KEY}\n`, { mode: 0o600 });
  mkdirSync(join(home, 'homes', 'claude-main'), { recursive: true });
  mkdirSync(join(home, 'homes', 'glm'), { recursive: true });
  writeFileSync(
    join(home, 'providers.json'),
    JSON.stringify(
      {
        jev: { keyFile: '~/.jv/secrets/jev.key', model: 'jev-test' },
        providers: [
          {
            name: 'claude-main',
            kind: 'claude-subscription',
            home: '~/.jv/homes/claude-main',
            tokenFile: '~/.jv/secrets/claude-main.token',
            models: [
              { id: 'model-strong', label: 'Strong', efforts: ['low', 'medium', 'high', 'max'] },
              { id: 'model-small', label: 'Small', efforts: ['low'] },
            ],
          },
          {
            name: 'glm',
            kind: 'claude-endpoint',
            baseUrl: 'https://endpoint.example.test/api/anthropic',
            keyFile: '~/.jv/secrets/glm.key',
            models: [
              { id: 'glm-big', label: 'Big', efforts: ['high'] },
              { id: 'glm-mid', label: 'Mid', efforts: ['medium'] },
              { id: 'glm-tiny', label: 'Tiny', efforts: ['low'] },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
  writeSkill(home, 'investigate', ['repo-read'], 'Read the code the task names and answer with file paths.');
  writeSkill(home, 'plan', ['repo-read'], 'Write plan.md.');
  writeSkill(home, 'implement', ['repo-write', 'shell'], 'Follow plan.md.');
  const rules = join(home, 'worker-rules.md');
  writeFileSync(rules, RULES_TEMPLATE);
  return home;
}

export function writeSkill(home: string, duty: string, needs: string[], body: string): void {
  const dir = join(home, 'skills', `jevellan-duty-${duty}`);
  mkdirSync(dir, { recursive: true });
  const needsYaml = needs.length ? `jv-needs:\n${needs.map((n) => `  - ${n}`).join('\n')}` : 'jv-needs: []';
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: jevellan-duty-${duty}\ndescription: "Jevellan internal. Not for direct use."\ndisable-model-invocation: true\n${needsYaml}\njv-version: 0.1.0\n---\n\n${body}\n`,
  );
}

/** A project (with a repo folder holding AGENTS.md), a task of `kind` and its steps (duties in order). */
export function seedTask(
  store: Store,
  home: string,
  options: { kind?: string; duties?: string[]; name?: string; agents?: string } = {},
): { projectId: string; projectName: string; repo: string; taskId: string; stepIds: string[] } {
  const repo = join(home, 'repos', options.name ?? 'sandbox');
  mkdirSync(repo, { recursive: true });
  if (options.agents !== undefined) writeFileSync(join(repo, 'AGENTS.md'), options.agents);
  const project = store.createProject({ name: options.name ?? 'sandbox', path: repo, default_branch: 'main' }).row;
  const task = store.createTask({
    project_id: project.id,
    request_id: `req-task-${Math.random()}`,
    kind: (options.kind ?? 'single') as 'single',
    title: 'Find the entry point',
    task_text: 'Where does the app start? Name the file and line.',
    workflow_json: '{"steps":[]}',
  }).row;
  const stepIds = (options.duties ?? ['investigate']).map(
    (duty, i) => store.createStep({ task_id: task.id, ordinal: i + 1, duty, instructions: i === 0 ? 'Answer with paths.' : '' }).row.id,
  );
  return { projectId: project.id, projectName: project.name, repo, taskId: task.id, stepIds };
}
