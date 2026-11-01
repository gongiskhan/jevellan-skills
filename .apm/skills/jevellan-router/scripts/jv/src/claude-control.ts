// The models a Claude login offers, through the agent SDK's supportedModels(): ported from jevellan
// runtimes/claude/src/control.ts at 8e2788ec (listClaudeModels).
//
// An open input stream that never yields performs the SDK handshake without submitting a model turn, so the probe
// costs no usage. The child environment is the provider's (doctor's probeEnvironment: HOME, the token, the
// endpoint variables), never the whole process environment. Endpoint providers are not probed: Claude Code lists
// Anthropic's aliases there, not the endpoint's models (Jevellan returned the configured list for them too).

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const ModelsSchema = z.array(
  z.object({
    value: z.string(),
    resolvedModel: z.string().optional(),
    displayName: z.string(),
    supportedEffortLevels: z.array(z.enum(EFFORTS)).optional(),
  }),
);

export interface OfferedModel {
  /** The canonical model id (resolvedModel, else value). */
  id: string;
  label: string;
  efforts: string[];
}

export interface ListClaudeModelsOptions {
  env: Record<string, string>;
  cwd: string;
  timeoutMs?: number;
  executable?: string;
}

/** The models the login offers, deduplicated by canonical id, in the SDK's order. Throws when the probe fails. */
export async function listClaudeModels(options: ListClaudeModelsOptions): Promise<OfferedModel[]> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  let release: (() => void) | undefined;
  const input: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
            release = () => resolve({ done: true, value: undefined });
          }),
      };
    },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  const runtime = query({
    prompt: input,
    options: {
      cwd: options.cwd,
      env: options.env,
      abortController: controller,
      settingSources: ['user'],
      permissionMode: 'dontAsk',
      stderr: () => {},
      ...(options.executable ? { pathToClaudeCodeExecutable: options.executable } : {}),
    },
  });
  try {
    const timedOut = new Promise<never>((_, reject) =>
      controller.signal.addEventListener('abort', () => reject(new Error('supportedModels() did not answer in time')), { once: true }),
    );
    const models = ModelsSchema.parse(await Promise.race([runtime.supportedModels(), timedOut]));
    const out = new Map<string, OfferedModel>();
    for (const m of models) {
      const id = m.resolvedModel ?? m.value;
      if (!out.has(id)) out.set(id, { id, label: m.displayName, efforts: [...(m.supportedEffortLevels ?? [])] });
    }
    return [...out.values()];
  } finally {
    clearTimeout(timer);
    release?.();
    runtime.close();
  }
}
