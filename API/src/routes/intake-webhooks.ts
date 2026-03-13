import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';

import { loadConfig } from '../../../src/config/loader.js';
import { getIntakeReport, upsertIntakeReport } from '../../../src/database/intake-queries.js';
import type {
  GitHubIntakeConnectorConfig,
  IntakeReport,
  IntakeSource,
  SentryIntakeConnectorConfig,
} from '../../../src/intake/types.js';
import { isIntakeSource, openProjectDatabase, parseReportPayload } from './intake-support.js';

const router = Router();

type RawRequest = Request & { body: Buffer };

interface WebhookBodyShape {
  project?: unknown;
  report?: unknown;
  linkedTaskId?: unknown;
}

function parseWebhookJson(req: RawRequest, res: Response): WebhookBodyShape | null {
  if (!Buffer.isBuffer(req.body)) {
    res.status(400).json({
      success: false,
      error: 'Webhook body must be sent as raw JSON',
    });
    return null;
  }

  if (req.body.length === 0) {
    res.status(400).json({
      success: false,
      error: 'Webhook body is required',
    });
    return null;
  }

  try {
    return JSON.parse(req.body.toString('utf-8')) as WebhookBodyShape;
  } catch {
    res.status(400).json({
      success: false,
      error: 'Webhook body must be valid JSON',
    });
    return null;
  }
}

function normalizeSignature(value: string | undefined): Buffer | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().replace(/^sha256=/i, '');
  if (!/^[a-f0-9]{64}$/i.test(normalized)) {
    return null;
  }

  return Buffer.from(normalized.toLowerCase(), 'hex');
}

function readSignatureHeader(req: Request, connector: IntakeSource): Buffer | null {
  const generic = req.header('x-steroids-signature-256');
  if (generic) {
    return normalizeSignature(generic);
  }

  if (connector === 'github') {
    return normalizeSignature(req.header('x-hub-signature-256') ?? undefined);
  }

  if (connector === 'sentry') {
    return normalizeSignature(req.header('sentry-hook-signature') ?? undefined);
  }

  return null;
}

function computeSignature(secret: string, body: Buffer): Buffer {
  return Buffer.from(createHmac('sha256', secret).update(body).digest('hex'), 'hex');
}

function parseLinkedTaskId(value: unknown): string | null | undefined | { error: string } {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return { error: 'linkedTaskId must be a non-empty string or null when provided' };
  }

  return value.trim();
}

function getConnectorConfig(
  source: IntakeSource,
  config: ReturnType<typeof loadConfig>['intake']
): GitHubIntakeConnectorConfig | SentryIntakeConnectorConfig | undefined {
  if (source === 'github') {
    return config?.connectors?.github;
  }

  return config?.connectors?.sentry;
}

function getWebhookSecretEnvVar(
  source: IntakeSource,
  config: GitHubIntakeConnectorConfig | SentryIntakeConnectorConfig | undefined
): string | null {
  if (!config?.enabled) {
    return null;
  }

  const envVar = source === 'github' ? config.webhookSecretEnvVar : config.webhookSecretEnvVar;
  if (!envVar || envVar.trim() === '') {
    return null;
  }

  return envVar.trim();
}

function validateSignature(req: RawRequest, source: IntakeSource, secret: string): boolean {
  const provided = readSignatureHeader(req, source);
  if (!provided) {
    return false;
  }

  const expected = computeSignature(secret, req.body);
  if (provided.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(provided, expected);
}

function parseWebhookReport(payload: WebhookBodyShape): IntakeReport | { error: string } {
  if (payload.report !== undefined) {
    return parseReportPayload(payload.report);
  }

  const { project: _project, linkedTaskId: _linkedTaskId, ...reportPayload } = payload;
  return parseReportPayload(reportPayload);
}

router.post(
  '/intake/:connector',
  express.raw({ type: ['application/json', 'application/*+json'], limit: '1mb' }),
  (req: Request, res: Response) => {
    const connector = req.params.connector;
    if (!isIntakeSource(connector)) {
      res.status(400).json({
        success: false,
        error: `Unsupported intake source: ${connector}`,
      });
      return;
    }

    const rawReq = req as RawRequest;
    const payload = parseWebhookJson(rawReq, res);
    if (!payload) {
      return;
    }

    if (typeof payload.project !== 'string' || payload.project.trim() === '') {
      res.status(400).json({
        success: false,
        error: 'Webhook body must include a non-empty project field',
      });
      return;
    }

    const projectPath = payload.project.trim();
    const config = loadConfig(projectPath);
    const connectorConfig = getConnectorConfig(connector, config.intake);
    const secretEnvVar = getWebhookSecretEnvVar(connector, connectorConfig);
    if (!secretEnvVar) {
      res.status(503).json({
        success: false,
        error: `Intake webhook secret is not configured for connector: ${connector}`,
      });
      return;
    }

    const secret = process.env[secretEnvVar];
    if (!secret || secret.trim() === '') {
      res.status(503).json({
        success: false,
        error: `Intake webhook secret env var is empty or missing: ${secretEnvVar}`,
      });
      return;
    }

    if (!validateSignature(rawReq, connector, secret)) {
      res.status(401).json({
        success: false,
        error: 'Invalid webhook signature',
      });
      return;
    }

    const parsedReport = parseWebhookReport(payload);
    if ('error' in parsedReport) {
      res.status(400).json({
        success: false,
        error: parsedReport.error,
      });
      return;
    }

    if (parsedReport.source !== connector) {
      res.status(400).json({
        success: false,
        error: `Webhook report source mismatch: expected ${connector}, got ${parsedReport.source}`,
      });
      return;
    }

    const linkedTaskId = parseLinkedTaskId(payload.linkedTaskId);
    if (linkedTaskId && typeof linkedTaskId === 'object' && 'error' in linkedTaskId) {
      res.status(400).json({
        success: false,
        error: linkedTaskId.error,
      });
      return;
    }

    const db = openProjectDatabase(projectPath, false);
    if (!db) {
      res.status(404).json({
        success: false,
        error: 'Project database not found at .steroids/steroids.db',
        project: projectPath,
      });
      return;
    }

    try {
      const existing = getIntakeReport(db, parsedReport.source, parsedReport.externalId);
      const report = upsertIntakeReport(db, parsedReport, {
        linkedTaskId,
      });

      res.status(existing ? 200 : 201).json({
        success: true,
        project: projectPath,
        report,
        created: !existing,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to persist intake report from webhook',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      db.close();
    }
  }
);

export default router;
