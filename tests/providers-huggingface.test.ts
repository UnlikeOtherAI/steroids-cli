import { describe, expect, it } from '@jest/globals';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HuggingFaceProvider } from '../src/providers/huggingface.js';
import { openGlobalDatabase } from '../src/runners/global-db.js';

function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe('HuggingFaceProvider', () => {
  it('returns metadata and default models', () => {
    const provider = new HuggingFaceProvider({
      auth: { getToken: () => 'hf_test' },
    });

    expect(provider.name).toBe('hf');
    expect(provider.displayName).toBe('Hugging Face Router');
    expect(provider.listModels()).toContain('deepseek-ai/DeepSeek-V3');
  });

  it('appends :fastest routing suffix when no suffix is provided', async () => {
    let capturedModel = '';
    const provider = new HuggingFaceProvider({
      auth: { getToken: () => 'hf_test' },
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        capturedModel = body.model;
        return new Response(
          createSSEStream([
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
            'data: [DONE]\n\n',
          ]),
          { status: 200 }
        );
      },
    });

    const result = await provider.invoke('hello', {
      model: 'meta-llama/Llama-3.3-70B-Instruct',
      streamOutput: false,
    });

    expect(result.success).toBe(true);
    expect(result.stdout).toBe('ok');
    expect(capturedModel).toBe('meta-llama/Llama-3.3-70B-Instruct:fastest');
  });

  it('preserves explicit routing policy suffix', async () => {
    let capturedModel = '';
    const provider = new HuggingFaceProvider({
      auth: { getToken: () => 'hf_test' },
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        capturedModel = body.model;
        return new Response(
          createSSEStream([
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
            'data: [DONE]\n\n',
          ]),
          { status: 200 }
        );
      },
    });

    await provider.invoke('hello', {
      model: 'meta-llama/Llama-3.3-70B-Instruct:cheapest',
      streamOutput: false,
    });

    expect(capturedModel).toBe('meta-llama/Llama-3.3-70B-Instruct:cheapest');
  });

  it('classifies SSE error events as failed invocation', async () => {
    const provider = new HuggingFaceProvider({
      auth: { getToken: () => 'hf_test' },
      fetchImpl: async () =>
        new Response(
          createSSEStream([
            'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
            'event: error\ndata: {"error":{"message":"insufficient credits"}}\n\n',
          ]),
          { status: 200 }
        ),
    });

    const result = await provider.invoke('hello', {
      model: 'deepseek-ai/DeepSeek-V3',
      streamOutput: false,
    });

    expect(result.success).toBe(false);
    expect(result.stdout).toBe('partial');
    expect(result.stderr).toContain('credits exhausted');
  });

  it('returns explicit rate-limit errors for HTTP 429 responses', async () => {
    const provider = new HuggingFaceProvider({
      auth: { getToken: () => 'hf_test' },
      fetchImpl: async () => new Response('too many requests', { status: 429, statusText: 'Too Many Requests' }),
    });

    const result = await provider.invoke('hello', {
      model: 'deepseek-ai/DeepSeek-V3',
      streamOutput: false,
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(429);
    expect(result.stderr).toContain('rate limit exceeded');
  });

  it('returns explicit gated-model errors for SSE access-denied events', async () => {
    const provider = new HuggingFaceProvider({
      auth: { getToken: () => 'hf_test' },
      fetchImpl: async () =>
        new Response(
          createSSEStream([
            'event: error\ndata: {"error":{"code":403,"message":"This model is gated. Request access first."}}\n\n',
          ]),
          { status: 200 }
        ),
    });

    const result = await provider.invoke('hello', {
      model: 'deepseek-ai/DeepSeek-V3',
      streamOutput: false,
    });

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('gated model access denied');
  });

  it('fails when stream closes without [DONE] sentinel', async () => {
    const provider = new HuggingFaceProvider({
      auth: { getToken: () => 'hf_test' },
      fetchImpl: async () =>
        new Response(
          createSSEStream([
            'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
          ]),
          { status: 200 }
        ),
    });

    const result = await provider.invoke('hello', {
      model: 'deepseek-ai/DeepSeek-V3',
      streamOutput: false,
    });

    expect(result.success).toBe(false);
    expect(result.stdout).toBe('partial');
    expect(result.stderr).toContain('before [DONE]');
  });

  it('records hf usage metrics for successful streamed responses', async () => {
    const originalHome = process.env.STEROIDS_HOME;
    const homeDir = join('/tmp', `hf-provider-metrics-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    process.env.STEROIDS_HOME = homeDir;
    mkdirSync(join(homeDir, 'huggingface'), { recursive: true });

    const provider = new HuggingFaceProvider({
      auth: { getToken: () => 'hf_test' },
      registry: {
        getCuratedModels: async () => [],
        getCachedModel: () => ({
          id: 'meta-llama/Llama-3.3-70B-Instruct',
          pipelineTag: 'text-generation',
          downloads: 0,
          likes: 0,
          tags: [],
          providers: ['novita'],
          pricing: {
            novita: { input: 0.1, output: 0.4 },
          },
          addedAt: Date.now(),
          source: 'search',
        }),
      },
      fetchImpl: async () =>
        new Response(
          createSSEStream([
            'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
            'data: {"usage":{"prompt_tokens":1000,"completion_tokens":250}}\n\n',
            'data: [DONE]\n\n',
          ]),
          {
            status: 200,
            headers: {
              'x-hf-inference-provider': 'novita',
            },
          }
        ),
    });

    const result = await provider.invoke('hello', {
      model: 'meta-llama/Llama-3.3-70B-Instruct:novita',
      role: 'coder',
      streamOutput: false,
    });
    expect(result.success).toBe(true);

    const { db, close } = openGlobalDatabase();
    try {
      const row = db.prepare(
        `SELECT model, provider, routing_policy, role, prompt_tokens, completion_tokens, estimated_cost_usd
         FROM hf_usage
         ORDER BY id DESC
         LIMIT 1`
      ).get() as {
        model: string;
        provider: string | null;
        routing_policy: string;
        role: string;
        prompt_tokens: number;
        completion_tokens: number;
        estimated_cost_usd: number;
      };

      expect(row.model).toBe('meta-llama/Llama-3.3-70B-Instruct');
      expect(row.provider).toBe('novita');
      expect(row.routing_policy).toBe('novita');
      expect(row.role).toBe('coder');
      expect(row.prompt_tokens).toBe(1000);
      expect(row.completion_tokens).toBe(250);
      expect(row.estimated_cost_usd).toBeCloseTo(0.0002, 8);
    } finally {
      close();
      await rm(homeDir, { recursive: true, force: true });
      if (originalHome === undefined) {
        delete process.env.STEROIDS_HOME;
      } else {
        process.env.STEROIDS_HOME = originalHome;
      }
    }
  });
});
