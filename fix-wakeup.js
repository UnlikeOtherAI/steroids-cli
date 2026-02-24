import fs from 'fs';

let content = fs.readFileSync('src/runners/wakeup.ts', 'utf-8');

// Replace the hibernation block
const hibernationRegex = /\s*\/\/ Check if project is hibernating[\s\S]*?if\s*\([^\{]+pingSuccess\)\s*\{[\s\S]*?continue;\s*\}\s*\}/;

const newBlock = `
      // Check global provider backoffs
      const coderProvider = projectConfig.ai?.coder?.provider;
      const reviewerProvider = projectConfig.ai?.reviewer?.provider;
      const providersToCheck = [coderProvider, reviewerProvider].filter(Boolean) as string[];
      let isBackedOff = false;
      let backedOffProvider = '';
      let remainingMs = 0;

      for (const provider of providersToCheck) {
        const ms = getProviderBackoffRemainingMs(provider);
        if (ms > 0) {
          isBackedOff = true;
          backedOffProvider = provider;
          remainingMs = ms;
          break;
        }
      }

      if (isBackedOff) {
        const remainingMinutes = Math.ceil(remainingMs / 60000);
        log(`Skipping \${project.path}: Provider '\${backedOffProvider}' is in backoff for \${remainingMinutes}m`);
        results.push({
          action: 'skipped',
          reason: `Provider '\${backedOffProvider}' backed off for \${remainingMinutes}m`,
          projectPath: project.path,
        });
        continue;
      }
`;

content = content.replace(hibernationRegex, newBlock);
content = content.replace(/import \{ clearProjectHibernation \} from '.\/projects.js';
/, '');

// Need to import getProviderBackoffRemainingMs if not already imported
if (content.includes('import { openGlobalDatabase,
  withGlobalDatabase, getDaemonActiveStatus } from './global-db.js';')) {
  content = content.replace('getDaemonActiveStatus } from './global-db.js';', 'getDaemonActiveStatus, getProviderBackoffRemainingMs } from './global-db.js';');
} else if (!content.includes('getProviderBackoffRemainingMs')) {
  content = content.replace(/from '\.\/global-db\.js';/, ', getProviderBackoffRemainingMs } from './global-db.js';');
}

fs.writeFileSync('src/runners/wakeup.ts', content);
