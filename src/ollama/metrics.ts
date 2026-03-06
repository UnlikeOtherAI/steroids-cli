import { openGlobalDatabase } from '../runners/global-db-connection.js';

interface OllamaMetricsChunk {
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  eval_count?: number;
}

export interface OllamaTokenMetrics {
  endpoint: string;
  totalDurationNs?: number;
  loadDurationNs?: number;
  promptEvalDurationNs?: number;
  evalDurationNs?: number;
  tokensPerSecond?: number;
}

interface RecordOllamaUsageInput {
  model: string;
  endpoint: string;
  role: 'orchestrator' | 'coder' | 'reviewer';
  promptTokens?: number;
  completionTokens?: number;
  totalDurationNs?: number;
  loadDurationNs?: number;
  promptEvalDurationNs?: number;
  evalDurationNs?: number;
  tokensPerSecond?: number;
}

export function computeTokensPerSecond(
  outputTokens?: number,
  evalDurationNs?: number,
): number | undefined {
  if (!isFinitePositiveInt(outputTokens) || !isFinitePositiveInt(evalDurationNs)) {
    return undefined;
  }
  return (outputTokens / evalDurationNs) * 1_000_000_000;
}

export function buildOllamaTokenMetrics(
  chunk: OllamaMetricsChunk | undefined,
  endpoint: string,
): OllamaTokenMetrics | undefined {
  if (!endpoint) {
    return undefined;
  }

  const totalDurationNs = sanitizeNullableInt(chunk?.total_duration);
  const loadDurationNs = sanitizeNullableInt(chunk?.load_duration);
  const promptEvalDurationNs = sanitizeNullableInt(chunk?.prompt_eval_duration);
  const evalDurationNs = sanitizeNullableInt(chunk?.eval_duration);
  const evalCount = sanitizeNullableInt(chunk?.eval_count);

  return {
    endpoint,
    totalDurationNs: totalDurationNs ?? undefined,
    loadDurationNs: loadDurationNs ?? undefined,
    promptEvalDurationNs: promptEvalDurationNs ?? undefined,
    evalDurationNs: evalDurationNs ?? undefined,
    tokensPerSecond: computeTokensPerSecond(evalCount ?? undefined, evalDurationNs ?? undefined),
  };
}

export function recordOllamaUsage(input: RecordOllamaUsageInput): boolean {
  if (!input.endpoint) {
    return false;
  }

  const promptTokens = sanitizeNullableInt(input.promptTokens);
  const completionTokens = sanitizeNullableInt(input.completionTokens);
  const totalDurationNs = sanitizeNullableInt(input.totalDurationNs);
  const loadDurationNs = sanitizeNullableInt(input.loadDurationNs);
  const promptEvalDurationNs = sanitizeNullableInt(input.promptEvalDurationNs);
  const evalDurationNs = sanitizeNullableInt(input.evalDurationNs);
  const tokensPerSecond = sanitizeNullableFloat(
    input.tokensPerSecond ?? computeTokensPerSecond(completionTokens ?? undefined, evalDurationNs ?? undefined),
  );

  const createdAt = Date.now();
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(
      `INSERT INTO ollama_usage (
         model, endpoint, role, prompt_tokens, completion_tokens, total_duration_ns,
         load_duration_ns, prompt_eval_duration_ns, eval_duration_ns, tokens_per_second, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.model,
      input.endpoint,
      input.role,
      promptTokens,
      completionTokens,
      totalDurationNs,
      loadDurationNs,
      promptEvalDurationNs,
      evalDurationNs,
      tokensPerSecond,
      createdAt,
    );

    return true;
  } finally {
    close();
  }
}

function isFinitePositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function sanitizeNullableInt(value: unknown): number | null {
  if (!isFinitePositiveInt(value) && value !== 0) {
    return null;
  }
  return Number(value);
}

function sanitizeNullableFloat(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}
