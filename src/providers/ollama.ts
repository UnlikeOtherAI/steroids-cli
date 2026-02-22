/**
 * Ollama Provider
 * Implementation for Ollama local API
 * http://localhost:11434
 */

import { request } from 'node:http';
import {
  BaseAIProvider,
  type InvokeOptions,
  type InvokeResult,
  type ModelInfo,
  type TokenUsage,
} from './interface.js';

/**
 * Static list of common Ollama models (fallback if local Ollama not reachable)
 */
const OLLAMA_FALLBACK_MODELS: ModelInfo[] = [
  {
    id: 'llama3',
    name: 'Llama 3',
    recommendedFor: ['coder', 'reviewer'],
    supportsStreaming: true,
  },
  {
    id: 'codellama',
    name: 'CodeLlama',
    recommendedFor: ['coder'],
    supportsStreaming: true,
  },
  {
    id: 'deepseek-coder-v2',
    name: 'DeepSeek Coder V2',
    recommendedFor: ['coder'],
    supportsStreaming: true,
  },
];

/**
 * Default models per role
 */
const DEFAULT_MODELS: Record<'orchestrator' | 'coder' | 'reviewer', string> = {
  orchestrator: 'llama3',
  coder: 'deepseek-coder-v2',
  reviewer: 'llama3',
};

/**
 * Ollama AI Provider implementation
 */
export class OllamaProvider extends BaseAIProvider {
  readonly name = 'ollama';
  readonly displayName = 'Ollama (local)';

  private host: string;
  private port: number;
  private dynamicModels: ModelInfo[] = [];

  constructor() {
    super();
    this.host = process.env.STEROIDS_OLLAMA_HOST || 'localhost';
    this.port = parseInt(process.env.STEROIDS_OLLAMA_PORT || '11434', 10);
  }

  /**
   * Check if Ollama is running by calling its API
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const options = {
        hostname: this.host,
        port: this.port,
        path: '/api/tags',
        method: 'GET',
      };

      const req = request(options, (res) => {
        if (res.statusCode === 200) {
          resolve(true);
        } else {
          resolve(false);
        }
      });

      req.on('error', () => resolve(false));
      req.end();

      // Short timeout for availability check
      setTimeout(() => {
        req.destroy();
        resolve(false);
      }, 2000);
    });
  }

  /**
   * Fetch available models from local Ollama service
   */
  async initialize(): Promise<void> {
    return new Promise((resolve) => {
      const options = {
        hostname: this.host,
        port: this.port,
        path: '/api/tags',
        method: 'GET',
      };

      const req = request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.models && Array.isArray(data.models)) {
              this.dynamicModels = data.models.map((m: any) => ({
                id: m.name,
                name: m.name,
                recommendedFor: m.name.toLowerCase().includes('coder') ? ['coder'] : [],
                supportsStreaming: true,
              }));
            }
            resolve();
          } catch {
            resolve();
          }
        });
      });

      req.on('error', () => resolve());
      req.end();

      // Timeout for initialization
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 5000);
    });
  }

  /**
   * Invoke Ollama chat API
   */
  async invoke(prompt: string, options: InvokeOptions): Promise<InvokeResult> {
    const startTime = Date.now();
    const model = options.model;
    const onActivity = options.onActivity;

    return new Promise((resolve) => {
      const postData = JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        stream: false, // For simplicity initially, can implement streaming later
      });

      const requestOptions = {
        hostname: this.host,
        port: this.port,
        path: '/api/chat',
        method: 'POST',
        headers: {
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
              const content = result.message?.content || '';
              // Ollama usually returns token counts in response
              const usage: TokenUsage | undefined = result.prompt_eval_count ? {
                inputTokens: result.prompt_eval_count,
                outputTokens: result.eval_count,
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
                stderr: responseBody,
                duration,
                timedOut: false,
              });
            }
          } catch (e) {
            resolve({
              success: false,
              exitCode: 1,
              stdout: '',
              stderr: `Failed to parse Ollama response: ${e}

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
          stderr: `Ollama request error: ${e.message}`,
          duration: Date.now() - startTime,
          timedOut: false,
        });
      });

      req.write(postData);
      req.end();

      if (options.timeout) {
        setTimeout(() => {
          req.destroy();
          resolve({
            success: false,
            exitCode: 1,
            stdout: '',
            stderr: 'Ollama request timed out',
            duration: Date.now() - startTime,
            timedOut: true,
          });
        }, options.timeout);
      }
    });
  }

  /**
   * List models (prefers dynamic, fallbacks to static)
   */
  listModels(): string[] {
    const models = this.dynamicModels.length > 0 ? this.dynamicModels : OLLAMA_FALLBACK_MODELS;
    return models.map((m) => m.id);
  }

  /**
   * Get model info
   */
  getModelInfo(): ModelInfo[] {
    return this.dynamicModels.length > 0 ? [...this.dynamicModels] : [...OLLAMA_FALLBACK_MODELS];
  }

  /**
   * Get default model
   */
  getDefaultModel(role: 'orchestrator' | 'coder' | 'reviewer'): string {
    return DEFAULT_MODELS[role];
  }

  /**
   * API-only provider
   */
  getDefaultInvocationTemplate(): string {
    return '';
  }
}

/**
 * Create an Ollama provider instance
 */
export function createOllamaProvider(): OllamaProvider {
  return new OllamaProvider();
}
