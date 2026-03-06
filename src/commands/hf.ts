import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { generateHelp } from '../cli/help.js';
import { HuggingFaceTokenAuth } from '../huggingface/auth.js';
import { HuggingFaceModelRegistry } from '../huggingface/model-registry.js';

const HELP = generateHelp({
  command: 'hf',
  description: 'Hugging Face integration utilities',
  usage: [
    'steroids hf refresh',
  ],
  subcommands: [
    { name: 'refresh', description: 'Rebuild cached curated Hugging Face model list' },
  ],
  examples: [
    { command: 'steroids hf refresh', description: 'Refresh cached curated model registry' },
  ],
});

interface HFCommandDeps {
  auth?: Pick<HuggingFaceTokenAuth, 'getToken'>;
  registry?: Pick<HuggingFaceModelRegistry, 'refreshCuratedModels'>;
}

export async function hfCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'hf', flags });
  if (flags.help || args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    out.log(HELP);
    return;
  }

  const subcommand = args[0];
  switch (subcommand) {
    case 'refresh':
      await hfRefreshCommand(flags);
      break;
    default:
      out.error('INVALID_ARGUMENTS', `Unknown subcommand: ${subcommand}`);
      process.exit(2);
  }
}

export async function hfRefreshCommand(flags: GlobalFlags, deps: HFCommandDeps = {}): Promise<void> {
  const out = createOutput({ command: 'hf', subcommand: 'refresh', flags });
  const auth = deps.auth ?? new HuggingFaceTokenAuth();
  const registry = deps.registry ?? new HuggingFaceModelRegistry();
  const token = auth.getToken() ?? undefined;
  const models = await registry.refreshCuratedModels({ token });

  const result = { refreshedModels: models.length };
  if (flags.json) {
    out.success(result);
    return;
  }

  out.log(`Refreshed Hugging Face model cache: ${models.length} models.`);
}
