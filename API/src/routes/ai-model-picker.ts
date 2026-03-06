import { Router, type Request, type Response } from 'express';
import { execSync } from 'node:child_process';
import { openGlobalDatabase } from '../../../dist/runners/global-db.js';

const router = Router();

type HFRuntime = 'claude-code' | 'opencode';

interface HFPairedModelRow {
  model_id: string;
  runtime: HFRuntime;
}

interface AIModelResponse {
  id: string;
  name: string;
  runtime?: HFRuntime;
  groupLabel?: string;
}

const RUNTIME_LABELS: Record<HFRuntime, string> = {
  'claude-code': 'Claude Code (Hugging Face)',
  opencode: 'OpenCode (Hugging Face)',
};

function isCliInstalled(command: string): boolean {
  try {
    execSync(`which ${command}`, { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function toGroupedHFModel(row: HFPairedModelRow): AIModelResponse {
  return {
    id: row.model_id,
    name: row.model_id,
    runtime: row.runtime,
    groupLabel: RUNTIME_LABELS[row.runtime],
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

export default router;
