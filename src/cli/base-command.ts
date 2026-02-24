import { parseArgs } from 'node:util';
import type { GlobalFlags } from './flags.js';
import { isInitialized } from '../database/connection.js';

export interface CommandConfig<T extends Record<string, any>> {
  name: string;
  description: string;
  helpText: string;
  options?: Record<string, { type: 'boolean' | 'string'; default?: any; short?: string }>;
  allowPositionals?: boolean;
  requireInit?: boolean;
  handler: (args: string[], flags: GlobalFlags, parsedOptions: T, positionals: string[]) => Promise<void> | void;
}

export function defineCommand<T extends Record<string, any>>(config: CommandConfig<T>) {
  return async (args: string[], flags: GlobalFlags): Promise<void> => {
    try {
      if (flags.help) {
        console.log(config.helpText);
        return;
      }

      const { values, positionals } = parseArgs({
        args,
        options: config.options || {},
        allowPositionals: config.allowPositionals ?? true,
      });

      if (config.requireInit) {
        const projectPath = process.cwd();
        if (!isInitialized(projectPath)) {
          console.error('Steroids not initialized. Run "steroids init" first.');
          process.exit(1);
        }
      }

      await config.handler(args, flags, values as unknown as T, positionals);
    } catch (error: any) {
      if (error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
        console.error(`Error: ${error.message}`);
        console.log(`Run 'steroids ${config.name} --help' for usage information.`);
      } else {
        console.error(`Command execution failed: ${error.message || error}`);
        if (flags.verbose) {
           console.error(error.stack);
        }
      }
      process.exit(1);
    }
  };
}
