import { Router, type Request, type Response } from 'express';
import { execSync } from 'node:child_process';
import { openGlobalDatabase } from '../../../dist/runners/global-db.js';
import { loadConfig } from '../../../dist/config/loader.js';

const router = Router();

type Runtime = 'claude-code' | 'opencode';

interface HFPairedModelRow {
  model_id: string;
  runtime: Runtime;
}

interface OllamaPairedModelRow {
  model_name: string;
  runtime: Runtime;
}

interface AIModelResponse {
  id: string;
  name: string;
  runtime?: Runtime;
  groupLabel?: string;
  mappedProvider?: string;
}

const HF_RUNTIME_LABELS: Record<Runtime, string> = {
  'claude-code': 'Claude Code (Hugging Face)',
  opencode: 'OpenCode (Hugging Face)',
};

const OLLAMA_RUNTIME_LABELS: Record<Runtime, string> = {
  'claude-code': 'Claude Code (Ollama)',
  opencode: 'OpenCode (Ollama)',
};

function isCliInstalled(command: string): boolean {
  try {
    execSync(`which ${command}`, { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function runtimeToProvider(runtime: Runtime): string {
  return runtime === 'opencode' ? 'opencode' : 'claude';
}

function toGroupedHFModel(row: HFPairedModelRow): AIModelResponse {
  return {
    id: row.runtime === 'opencode' ? `huggingface/${row.model_id}` : row.model_id,
    name: row.model_id,
    runtime: row.runtime,
    groupLabel: HF_RUNTIME_LABELS[row.runtime],
    mappedProvider: runtimeToProvider(row.runtime),
  };
}

function toGroupedOllamaModel(row: OllamaPairedModelRow): AIModelResponse {
  return {
    id: row.runtime === 'opencode' ? `ollama/${row.model_name}` : row.model_name,
    name: row.model_name,
    runtime: row.runtime,
    groupLabel: OLLAMA_RUNTIME_LABELS[row.runtime],
    mappedProvider: runtimeToProvider(row.runtime),
  };
}

router.get('/ai/providers', (_req: Request, res: Response) => {
  const providers = [
    {
      id: 'claude',
      name: 'Anthropic (claude)',
      installed: isCliInstalled('claude'),
    },
    {
      id: 'gemini',
      name: 'Google (gemini)',
      installed: isCliInstalled('gemini'),
    },
    {
      id: 'mistral',
      name: 'Mistral (vibe)',
      installed: isCliInstalled('vibe'),
    },
    {
      id: 'codex',
      name: 'OpenAI (codex)',
      installed: isCliInstalled('codex'),
    },
    {
      id: 'hf',
      name: 'Hugging Face',
      installed: true,
    },
    {
      id: 'ollama',
      name: 'Ollama',
      installed: true,
    },
    {
      id: 'custom',
      name: 'Custom Endpoints',
      installed: true,
    },
  ];

  res.json({
    success: true,
    providers,
  });
});

router.get('/ai/models/hf', (_req: Request, res: Response) => {
  const { db, close } = openGlobalDatabase();
  try {
    const rows = db.prepare(
      `SELECT model_id, runtime
       FROM hf_paired_models
       WHERE available = 1
       ORDER BY
         CASE runtime
           WHEN 'claude-code' THEN 0
           WHEN 'opencode' THEN 1
           ELSE 2
         END,
         added_at DESC,
         model_id ASC`
    ).all() as HFPairedModelRow[];

    const models = rows.map(toGroupedHFModel);
    res.json({
      success: true,
      provider: 'hf',
      source: 'ready-models',
      models,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to load Hugging Face ready models',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    close();
  }
});

router.get('/ai/models/ollama', (_req: Request, res: Response) => {
  const { db, close } = openGlobalDatabase();
  try {
    const rows = db.prepare(
      `SELECT model_name, runtime
       FROM ollama_paired_models
       WHERE available = 1
       ORDER BY
         CASE runtime
           WHEN 'claude-code' THEN 0
           WHEN 'opencode' THEN 1
           ELSE 2
         END,
         added_at DESC,
         model_name ASC`
    ).all() as OllamaPairedModelRow[];

    const models = rows.map(toGroupedOllamaModel);
    res.json({
      success: true,
      provider: 'ollama',
      source: 'ready-models',
      models,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to load Ollama ready models',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    close();
  }
});

router.get('/ai/models/custom', (_req: Request, res: Response) => {
  try {
    const config = loadConfig();
    const models = (config.ai?.custom?.models ?? []).map((m) => ({
      id: m.name,
      name: m.name,
      runtime: m.cli === 'opencode' ? 'opencode' : 'claude-code',
      groupLabel: `${m.cli} — custom`,
      mappedProvider: 'custom',
    }));
    res.json({
      success: true,
      provider: 'custom',
      source: 'config',
      models,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to load custom models',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
