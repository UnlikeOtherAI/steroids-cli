/**
 * About Command - Alias for llm command
 */

import type { GlobalFlags } from '../cli/flags.js';
import { llmCommand } from './llm.js';

export async function aboutCommand(args: string[], flags: GlobalFlags): Promise<void> {
  await llmCommand(args, flags);
}
