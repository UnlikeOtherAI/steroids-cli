import { describe, expect, it } from '@jest/globals';
import { HuggingFaceProvider } from '../src/providers/huggingface.js';

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
    expect(result.stderr).toContain('insufficient credits');
  });
});
