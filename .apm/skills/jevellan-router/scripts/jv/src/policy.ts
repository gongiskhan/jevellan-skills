// Policy skills (section 7.8): a SKILL.md whose body holds level-2 heading sections the runtime parses. Everything
// else in the body (prose for people, other headings) is ignored by the script. The body is hashed (sha256) so each
// decision row names the exact policy text it was made with.
//
// Section rules:
// - A section starts at a line "## <name>" (exactly two #, outside fenced code blocks) and runs to the next level-1
//   or level-2 heading. Names are compared case-insensitively with spaces collapsed.
// - A required section that is missing, empty or present twice fails with exit 2 naming it.
// - Line sections ("model descriptions", "effort guide", "questions", "routes") hold one "<id>: <text>" line per
//   entry. The id ends at the first colon followed by whitespace, so ids with a colon ("qwen3:8b") parse. A line
//   that does not have that shape, and an id written twice, fail with exit 2: a policy never drifts silently.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { refused } from './errors.js';
import { paths } from './paths.js';

export const ROUTER_POLICY = 'jevellan-router';
export const LANDING_POLICY = 'jevellan-landing';

/** The sections the router script reads (section 7.8). */
export const ROUTER_SECTIONS = ['model', 'model descriptions', 'effort', 'effort guide', 'questions', 'rules'] as const;

export interface Policy {
  /** Skill name, e.g. jevellan-router. */
  name: string;
  /** The file it was read from. */
  file: string;
  /** Everything after the frontmatter, exactly as in the file. */
  body: string;
  /** sha256 of the body, hex. */
  hash: string;
  /** Section name (normalized) to its text, trimmed. Duplicate names are listed in `duplicates`. */
  sections: Map<string, string>;
  duplicates: string[];
}

export interface PolicyQuestion {
  /** The question, used as the noul question's instructions. */
  question: string;
  /** Criterion for true. */
  true: string;
  /** Criterion for false. */
  false: string;
}

export interface RouterPolicy {
  policy: Policy;
  /** ## model: instructions of the model question. */
  modelInstructions: string;
  /** ## model descriptions: model id to description. */
  modelDescriptions: Map<string, string>;
  /** ## effort: instructions of the effort question. */
  effortInstructions: string;
  /** ## effort guide: effort to criterion. */
  effortGuide: Map<string, string>;
  /** ## questions: workflow question id to its question and criteria. */
  questions: Map<string, PolicyQuestion>;
  /** ## rules: sent verbatim as state.rules. */
  rules: string;
}

/** Normalized section name: lower case, inner whitespace collapsed. */
export function sectionKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Splits a SKILL.md into its frontmatter (without the --- lines) and its body (everything after the closing ---). */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { frontmatter: '', body: text };
  return { frontmatter: m[1]!, body: text.slice(m[0].length) };
}

/** sha256 hex of a text (UTF-8). */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The level-2 sections of a body. Headings inside fenced code blocks (``` or ~~~) are not headings. A level-1 heading
 * ends the current section without starting one; a level-3 or deeper heading is part of the section's text.
 */
export function parseSections(body: string): { sections: Map<string, string>; duplicates: string[] } {
  const sections = new Map<string, string>();
  const duplicates: string[] = [];
  let current: string | undefined;
  let lines: string[] = [];
  let fence: string | undefined;
  const close = () => {
    if (current === undefined) return;
    if (sections.has(current)) duplicates.push(current);
    else sections.set(current, lines.join('\n').trim());
    current = undefined;
    lines = [];
  };
  for (const line of body.split(/\r?\n/)) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === undefined) fence = f[1]!;
      else if (f[1]!.startsWith(fence)) fence = undefined;
    } else if (fence === undefined) {
      const h2 = /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
      if (h2) {
        close();
        current = sectionKey(h2[1]!);
        continue;
      }
      if (/^#[ \t]+/.test(line)) {
        close();
        continue;
      }
    }
    if (current !== undefined) lines.push(line);
  }
  close();
  return { sections, duplicates: [...new Set(duplicates)] };
}

/** Parses a policy's text (the whole SKILL.md). */
export function parsePolicy(name: string, text: string, file: string = paths.skillFile(name)): Policy {
  const { body } = splitFrontmatter(text);
  const { sections, duplicates } = parseSections(body);
  return { name, file, body, hash: sha256(body), sections, duplicates };
}

/** Loads ~/.jv/skills/<name>/SKILL.md (or `file`). Exit 2 when it cannot be read. */
export function loadPolicy(name: string, file: string = paths.skillFile(name)): Policy {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw refused(`the policy ${name} is not installed (no ${file}); run jv update`);
  }
  return parsePolicy(name, text, file);
}

/** The text of a required section. Exit 2 naming the section when it is missing, empty or written twice. */
export function requireSection(policy: Policy, name: string): string {
  const key = sectionKey(name);
  if (policy.duplicates.includes(key)) {
    throw refused(`the policy ${policy.name} (${policy.file}) has the section "## ${key}" more than once`);
  }
  const text = policy.sections.get(key);
  if (text === undefined) throw refused(`the policy ${policy.name} (${policy.file}) has no "## ${key}" section`);
  if (text === '') throw refused(`the policy ${policy.name} (${policy.file}) has an empty "## ${key}" section`);
  return text;
}

/** Checks every required section at once; the error names the first missing one. */
export function requireSections(policy: Policy, names: readonly string[]): void {
  for (const n of names) requireSection(policy, n);
}

const ID_LINE = /^(\S+?):\s+(\S.*)$/;

/**
 * "<id>: <text>" lines of a section, in order. Blank lines are skipped; any other line that is not of that shape,
 * and an id written twice, fail with exit 2 naming the section.
 */
export function parseIdLines(text: string, where = 'section'): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const m = ID_LINE.exec(line);
    if (!m) throw refused(`${where}: the line "${line.slice(0, 120)}" is not "<id>: <text>"`);
    const id = m[1]!;
    if (out.has(id)) throw refused(`${where}: ${id} has more than one line`);
    out.set(id, m[2]!.trim());
  }
  return out;
}

const QUESTION_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/** "<id>: <question> true: <criterion> false: <criterion>" lines (section 7.8 "## questions"). */
export function parseQuestionLines(text: string, where = 'section'): Map<string, PolicyQuestion> {
  const out = new Map<string, PolicyQuestion>();
  for (const [id, rest] of parseIdLines(text, where)) {
    if (!QUESTION_ID.test(id)) throw refused(`${where}: "${id}" is not a valid question id (letters, digits, _ . : -)`);
    const m = /^(.+?)\s+true:\s+(.+?)\s+false:\s+(.+)$/.exec(rest);
    if (!m) throw refused(`${where}: the question ${id} needs the form "<question> true: <text> false: <text>"`);
    out.set(id, { question: m[1]!.trim(), true: m[2]!.trim(), false: m[3]!.trim() });
  }
  return out;
}

/** Reads the router policy's sections (7.8); exit 2 naming the first missing section. */
export function routerPolicy(policy: Policy): RouterPolicy {
  requireSections(policy, ROUTER_SECTIONS);
  const where = (s: string) => `the policy ${policy.name} (${policy.file}), "## ${s}"`;
  return {
    policy,
    modelInstructions: requireSection(policy, 'model'),
    modelDescriptions: parseIdLines(requireSection(policy, 'model descriptions'), where('model descriptions')),
    effortInstructions: requireSection(policy, 'effort'),
    effortGuide: parseIdLines(requireSection(policy, 'effort guide'), where('effort guide')),
    questions: parseQuestionLines(requireSection(policy, 'questions'), where('questions')),
    rules: requireSection(policy, 'rules'),
  };
}

/** Loads and reads the router policy from ~/.jv/skills/jevellan-router/SKILL.md (or `file`). */
export function loadRouterPolicy(file?: string): RouterPolicy {
  return routerPolicy(file === undefined ? loadPolicy(ROUTER_POLICY) : loadPolicy(ROUTER_POLICY, file));
}

/** "<route>: <criterion>" lines of a section such as the landing policy's "## routes". */
export function parseRoutes(policy: Policy, section = 'routes'): Map<string, string> {
  return parseIdLines(requireSection(policy, section), `the policy ${policy.name} (${policy.file}), "## ${section}"`);
}

/**
 * A frontmatter value that is a list: `key: []`, `key: [a, b]`, or a block of "  - item" lines. undefined when the
 * key is absent. Used for the duty skills' jv-needs.
 */
export function frontmatterList(text: string, key: string): string[] | undefined {
  const { frontmatter } = splitFrontmatter(text);
  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!m || m[1] !== key) continue;
    const inline = m[2]!.trim();
    const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (inline.startsWith('[')) {
      if (!inline.endsWith(']')) throw refused(`frontmatter ${key}: "${inline}" is not a list`);
      const inner = inline.slice(1, -1).trim();
      return inner === '' ? [] : inner.split(',').map(unquote).filter((v) => v !== '');
    }
    if (inline !== '') return [unquote(inline)];
    const out: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s+-\s+(.+)$/.exec(lines[j]!);
      if (item) out.push(unquote(item[1]!));
      else if (/^\s*$/.test(lines[j]!)) continue;
      else break;
    }
    return out;
  }
  return undefined;
}
