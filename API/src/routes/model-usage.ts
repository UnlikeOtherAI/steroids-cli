/**
 * Model Usage API routes
 * Aggregates token usage by model and project across one or more Steroids projects.
 */
import { Router, Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getRegisteredProjects } from '../../../dist/runners/projects.js';
import { createOllamaApiClient, getResolvedConnectionConfig } from '../../../src/ollama/connection.js';
import { openGlobalDatabase } from '../../../src/runners/global-db-connection.js';
import { openSqliteForRead } from '../utils/sqlite.js';

const router = Router();

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  totalTokens: number;
  invocations: number;
}

interface InvocationRow {
  provider: string;
  model: string;
  token_usage_json: string | null;
}

interface ProjectAggregate {
  projectPath: string;
  projectName: string | null;
  totals: TokenUsage;
  byModel: ModelAggregate[];
}

interface ModelAggregate {
  provider: string;
  model: string;
  stats: TokenUsage;
}

interface OllamaUsageSummary {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  requests: number;
  avg_tokens_per_second: number | null;
}

interface OllamaUsageByModel extends OllamaUsageSummary {
  model: string;
}

interface OllamaRuntimeModelStatus {
  name: string;
  size_bytes: number;
  vram_bytes: number;
  ram_bytes: number;
  context_length: number | null;
  expires_at: string | null;
  unload_in_seconds: number | null;
}

interface OllamaRuntimeStatus {
  connected: boolean;
  endpoint: string;
  mode: 'local' | 'cloud';
  loaded_models: number;
  total_vram_bytes: number;
  total_ram_bytes: number;
  models: OllamaRuntimeModelStatus[];
  error?: string;
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    invocations: 0,
  };
}

function mergeUsage(acc: TokenUsage, next: TokenUsage): void {
  acc.inputTokens += next.inputTokens;
  acc.outputTokens += next.outputTokens;
  acc.cachedInputTokens += next.cachedInputTokens;
  acc.cacheReadTokens += next.cacheReadTokens;
  acc.cacheCreationTokens += next.cacheCreationTokens;
  acc.totalCostUsd += next.totalCostUsd;
  acc.totalTokens += next.totalTokens;
  acc.invocations += next.invocations;
}

function parseUsage(raw: string | null): TokenUsage | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.inputTokens !== 'number' || typeof data.outputTokens !== 'number') {
      return null;
    }

    const inputTokens = data.inputTokens;
    const outputTokens = data.outputTokens;
    const cachedInputTokens = Number(data.cachedInputTokens ?? 0);
    const cacheReadTokens = Number(data.cacheReadTokens ?? 0);
    const cacheCreationTokens = Number(data.cacheCreationTokens ?? 0);
    const totalCostUsd = Number(data.totalCostUsd ?? 0);

    if (
      !Number.isFinite(inputTokens) ||
      !Number.isFinite(outputTokens) ||
      !Number.isFinite(cachedInputTokens) ||
      !Number.isFinite(cacheReadTokens) ||
      !Number.isFinite(cacheCreationTokens) ||
      !Number.isFinite(totalCostUsd)
    ) {
      return null;
    }

    return {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalCostUsd,
      totalTokens: inputTokens + outputTokens,
      invocations: 1,
    };
  } catch {
    return null;
  }
}

function openProjectDb(projectPath: string): Database.Database | null {
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  if (!existsSync(dbPath)) return null;
  try {
    return openSqliteForRead(dbPath);
  } catch {
    return null;
  }
}

function getProjectUsage(projectPath: string, projectName: string | null, hours: number): ProjectAggregate {
  const result: ProjectAggregate = {
    projectPath,
    projectName,
    totals: emptyUsage(),
    byModel: [],
  };

  const db = openProjectDb(projectPath);
  if (!db) return result;

  const byModelMap = new Map<string, ModelAggregate>();
  try {
    const rows = db.prepare(
      `SELECT provider, model, token_usage_json
       FROM task_invocations
       WHERE token_usage_json IS NOT NULL
         AND created_at >= datetime('now', '-' || ? || ' hours')
       ORDER BY created_at DESC`
    ).all(hours) as InvocationRow[];

    for (const row of rows) {
      const usage = parseUsage(row.token_usage_json);
      if (!usage) continue;
      mergeUsage(result.totals, usage);

      const key = `${row.provider}::${row.model}`;
      const existing = byModelMap.get(key);
      if (existing) {
        mergeUsage(existing.stats, usage);
      } else {
        byModelMap.set(key, {
          provider: row.provider,
          model: row.model,
          stats: { ...usage },
        });
      }
    }
  } catch {
    return result;
  } finally {
    db.close();
  }

  result.byModel = Array.from(byModelMap.values()).sort(
    (a, b) => b.stats.totalTokens - a.stats.totalTokens || b.stats.invocations - a.stats.invocations
  );
  return result;
}

function getOllamaUsageSummary(hours: number): {
  summary: OllamaUsageSummary;
  byModel: OllamaUsageByModel[];
} {
  const summary: OllamaUsageSummary = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    requests: 0,
    avg_tokens_per_second: null,
  };

  const { db, close } = openGlobalDatabase();
  try {
    const cutoffMs = Date.now() - (hours * 60 * 60 * 1000);
    const summaryRow = db.prepare(
      `SELECT
         COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
         COUNT(*) AS requests,
         AVG(tokens_per_second) AS avg_tokens_per_second
       FROM ollama_usage
       WHERE created_at >= ?`
    ).get(cutoffMs) as {
      prompt_tokens: number;
      completion_tokens: number;
      requests: number;
      avg_tokens_per_second: number | null;
    };

    summary.prompt_tokens = Number(summaryRow.prompt_tokens ?? 0);
    summary.completion_tokens = Number(summaryRow.completion_tokens ?? 0);
    summary.total_tokens = summary.prompt_tokens + summary.completion_tokens;
    summary.requests = Number(summaryRow.requests ?? 0);
    summary.avg_tokens_per_second =
      typeof summaryRow.avg_tokens_per_second === 'number' && Number.isFinite(summaryRow.avg_tokens_per_second)
      ? summaryRow.avg_tokens_per_second
      : null;

    const byModel = db.prepare(
      `SELECT
         model,
         COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
         COUNT(*) AS requests,
         AVG(tokens_per_second) AS avg_tokens_per_second
       FROM ollama_usage
       WHERE created_at >= ?
       GROUP BY model
       ORDER BY (COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0)) DESC, COUNT(*) DESC`
    ).all(cutoffMs) as Array<{
      model: string;
      prompt_tokens: number;
      completion_tokens: number;
      requests: number;
      avg_tokens_per_second: number | null;
    }>;

    return {
      summary,
      byModel: byModel.map((row) => {
        const promptTokens = Number(row.prompt_tokens ?? 0);
        const completionTokens = Number(row.completion_tokens ?? 0);
        return {
          model: row.model,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          requests: Number(row.requests ?? 0),
          avg_tokens_per_second:
            typeof row.avg_tokens_per_second === 'number' && Number.isFinite(row.avg_tokens_per_second)
            ? row.avg_tokens_per_second
            : null,
        };
      }),
    };
  } catch {
    return {
      summary,
      byModel: [],
    };
  } finally {
    close();
  }
}

async function getOllamaRuntimeStatus(): Promise<OllamaRuntimeStatus> {
  const resolvedConfig = getResolvedConnectionConfig();
  const fallback: OllamaRuntimeStatus = {
    connected: false,
    endpoint: resolvedConfig.endpoint,
    mode: resolvedConfig.mode,
    loaded_models: 0,
    total_vram_bytes: 0,
    total_ram_bytes: 0,
    models: [],
  };

  try {
    const client = createOllamaApiClient(resolvedConfig);
    const response = await client.listRunningModels();
    const now = Date.now();

    const models = response.models.map((model) => {
      const expiresAt = model.expires_at ?? null;
      const unloadEpoch = expiresAt ? Date.parse(expiresAt) : Number.NaN;
      const unloadInSeconds = Number.isFinite(unloadEpoch)
        ? Math.max(0, Math.round((unloadEpoch - now) / 1000))
        : null;
      const sizeBytes = typeof model.size === 'number' && Number.isFinite(model.size) ? model.size : 0;
      const vramBytes = typeof model.size_vram === 'number' && Number.isFinite(model.size_vram) ? model.size_vram : 0;

      return {
        name: model.name,
        size_bytes: sizeBytes,
        vram_bytes: vramBytes,
        ram_bytes: Math.max(0, sizeBytes - vramBytes),
        context_length:
          typeof model.context_length === 'number' && Number.isFinite(model.context_length)
            ? model.context_length
            : null,
        expires_at: expiresAt,
        unload_in_seconds: unloadInSeconds,
      };
    });

    return {
      connected: true,
      endpoint: resolvedConfig.endpoint,
      mode: resolvedConfig.mode,
      loaded_models: models.length,
      total_vram_bytes: models.reduce((sum, model) => sum + model.vram_bytes, 0),
      total_ram_bytes: models.reduce((sum, model) => sum + model.ram_bytes, 0),
      models,
    };
  } catch (error) {
    return {
      ...fallback,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * GET /api/model-usage
 * Query params:
 *   - project: string (optional) - aggregate only one project if provided
 *   - hours: number (optional, default: 24) - lookback window
 */
router.get('/model-usage', async (req: Request, res: Response) => {
  try {
    const projectPath = req.query.project as string | undefined;
    const hoursParam = req.query.hours as string | undefined;

    let hours = 24;
    if (hoursParam !== undefined) {
      const parsed = parseInt(hoursParam, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        res.status(400).json({
          success: false,
          error: 'Invalid hours parameter - must be a positive integer',
        });
        return;
      }
      hours = parsed;
    }

    const projectInputs = projectPath
      ? [{ path: projectPath, name: null }]
      : getRegisteredProjects(false).map((p: { path: string; name: string | null }) => ({
          path: p.path,
          name: p.name ?? null,
        }));

    const projects = projectInputs.map((project) => getProjectUsage(project.path, project.name, hours));
    const totals = emptyUsage();
    const byModelMap = new Map<string, ModelAggregate>();

    for (const project of projects) {
      mergeUsage(totals, project.totals);
      for (const model of project.byModel) {
        const key = `${model.provider}::${model.model}`;
        const existing = byModelMap.get(key);
        if (existing) {
          mergeUsage(existing.stats, model.stats);
        } else {
          byModelMap.set(key, {
            provider: model.provider,
            model: model.model,
            stats: { ...model.stats },
          });
        }
      }
    }

    const byModel = Array.from(byModelMap.values()).sort(
      (a, b) => b.stats.totalTokens - a.stats.totalTokens || b.stats.invocations - a.stats.invocations
    );
    const byProject = projects
      .map((project) => ({
        project_path: project.projectPath,
        project_name: project.projectName,
        ...project.totals,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.invocations - a.invocations);
    const responseBody: Record<string, unknown> = {
      success: true,
      hours,
      stats: totals,
      by_model: byModel.map((m) => ({
        provider: m.provider,
        model: m.model,
        ...m.stats,
      })),
      by_project: byProject,
    };

    // Keep project-scoped responses deterministic: only aggregate global Ollama status
    // when no project filter is requested.
    if (!projectPath) {
      const ollamaUsage = getOllamaUsageSummary(hours);
      const ollamaRuntime = await getOllamaRuntimeStatus();
      responseBody.ollama = {
        usage: ollamaUsage.summary,
        by_model: ollamaUsage.byModel,
        runtime: ollamaRuntime,
      };
    }

    res.json(responseBody);
  } catch (error) {
    console.error('Error getting model usage:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get model usage',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
