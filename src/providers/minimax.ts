/**
 * MiniMax Provider
 * Implementation for MiniMax API
 * https://api.minimax.chat/v1/text/chat_completion_v2
 */

import { request } from 'node:https';
import {
  BaseAIProvider,
  type InvokeOptions,
  type InvokeResult,
  type ModelInfo,
  type TokenUsage,
} from './interface.js';

/**
 * Static list of common MiniMax models
 */
const MINIMAX_MODELS: ModelInfo[] = [
  {
    id: 'abab6.5-chat',
    name: 'abab6.5-chat',
    recommendedFor: ['coder', 'reviewer'],
    supportsStreaming: true,
  },
  {
    id: 'abab6.5s-chat',
    name: 'abab6.5s-chat',
    recommendedFor: ['coder'],
    supportsStreaming: true,
  },
  {
    id: 'abab6-chat',
    name: 'abab6-chat',
    recommendedFor: [],
    supportsStreaming: true,
  },
];

/**
 * Default models per role
 */
const DEFAULT_MODELS: Record<'orchestrator' | 'coder' | 'reviewer', string> = {
  orchestrator: 'abab6.5-chat',
  coder: 'abab6.5-chat',
  reviewer: 'abab6.5-chat',
};

/**
 * MiniMax AI Provider implementation
 */
export class MiniMaxProvider extends BaseAIProvider {
  readonly name = 'minimax';
  readonly displayName = 'MiniMax';

  private apiKey: string | undefined;
  private groupId: string | undefined;

  constructor() {
    super();
    this.apiKey = process.env.STEROIDS_MINIMAX_API_KEY || process.env.MINIMAX_API_KEY;
    this.groupId = process.env.STEROIDS_MINIMAX_GROUP_ID || process.env.MINIMAX_GROUP_ID;
  }

  /**
   * MiniMax is API-only, so isAvailable checks for API key
   */
  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  /**
   * Invoke MiniMax API
   */
  async invoke(prompt: string, options: InvokeOptions): Promise<InvokeResult> {
    if (!this.apiKey) {
      throw new Error('MiniMax API key not found. Set STEROIDS_MINIMAX_API_KEY environment variable.');
    }

    const startTime = Date.now();
    const model = options.model;
    const onActivity = options.onActivity;

    return new Promise((resolve) => {
      const postData = JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        // tokens_to_generate is optional, default is usually enough
      });

      const requestOptions = {
        hostname: 'api.minimax.chat',
        port: 443,
        path: '/v1/text/chat_completion_v2',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      };

      const req = request(requestOptions, (res) => {
        let responseBody = '';

        res.on('data', (chunk) => {
          responseBody += chunk;
        });

        res.on('end', () => {
          const duration = Date.now() - startTime;
          try {
            const result = JSON.parse(responseBody);

            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              const content = result.choices?.[0]?.message?.content || '';
              const usage: TokenUsage | undefined = result.usage ? {
                inputTokens: result.usage.prompt_tokens,
                outputTokens: result.usage.completion_tokens,
              } : undefined;

              resolve({
                success: true,
                exitCode: 0,
                stdout: content,
                stderr: '',
                duration,
                timedOut: false,
                tokenUsage: usage,
              });
            } else {
              resolve({
                success: false,
                exitCode: res.statusCode || 1,
                stdout: '',
                stderr: result.base_resp?.status_msg || responseBody,
                duration,
                timedOut: false,
              });
            }
          } catch (e) {
            resolve({
              success: false,
              exitCode: 1,
              stdout: '',
              stderr: `Failed to parse MiniMax response: ${e}

Raw response: ${responseBody}`,
              duration,
              timedOut: false,
            });
          }
        });
      });

      req.on('error', (e) => {
        resolve({
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: `MiniMax request error: ${e.message}`,
          duration: Date.now() - startTime,
          timedOut: false,
        });
      });

      req.write(postData);
      req.end();

      // Implement timeout
      if (options.timeout) {
        setTimeout(() => {
          req.destroy();
          resolve({
            success: false,
            exitCode: 1,
            stdout: '',
            stderr: 'MiniMax request timed out',
            duration: Date.now() - startTime,
            timedOut: true,
          });
        }, options.timeout);
      }
    });
  }

  /**
   * List models
   */
  listModels(): string[] {
    return MINIMAX_MODELS.map((m) => m.id);
  }

  /**
   * Get model info
   */
  getModelInfo(): ModelInfo[] {
    return [...MINIMAX_MODELS];
  }

  /**
   * Get default model
   */
  getDefaultModel(role: 'orchestrator' | 'coder' | 'reviewer'): string {
    return DEFAULT_MODELS[role];
  }

  /**
   * API-only provider doesn't use CLI templates
   */
  getDefaultInvocationTemplate(): string {
    return '';
  }
}

/**
 * Create a MiniMax provider instance
 */
export function createMiniMaxProvider(): MiniMaxProvider {
  return new MiniMaxProvider();
}
