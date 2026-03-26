import {
  BaseAIProvider,
  type InvokeOptions,
  type InvokeResult,
  type ModelInfo,
} from '../../src/providers/interface.js';

class HarnessClassifierProvider extends BaseAIProvider {
  readonly name = 'mock';
  readonly displayName = 'Mock';

  async invoke(_prompt: string, _options: InvokeOptions): Promise<InvokeResult> {
    throw new Error('Harness classifier provider should never invoke a real provider.');
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  listModels(): string[] {
    return [];
  }

  getModelInfo(): ModelInfo[] {
    return [];
  }

  getDefaultModel(): string | undefined {
    return undefined;
  }

  getDefaultInvocationTemplate(): string {
    return '';
  }
}

const classifierProvider = new HarnessClassifierProvider();

type ClassifiableResult = Pick<InvokeResult, 'success' | 'stderr' | 'stdout' | 'exitCode'> &
  Partial<Pick<InvokeResult, 'duration' | 'timedOut'>>;

export function classifyMockResult(result: ClassifiableResult) {
  return classifierProvider.classifyResult({
    ...result,
    duration: 0,
    timedOut: false,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode ?? 1,
    success: result.success ?? false,
  });
}
