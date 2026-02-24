import fs from 'fs';

const files = [
  'src/commands/loop-phases.ts',
  'src/parallel/merge-sealing.ts',
  'src/commands/health.ts',
  'src/commands/runners-parallel.ts',
  'src/runners/daemon.ts',
  'src/runners/wakeup.ts'
];

for (const file of files) {
  if (fs.existsSync(file)) {
    let content = fs.readFileSync(file, 'utf-8');
    if (content.includes('withGlobalDatabase') && !content.includes('import { withGlobalDatabase }') && !content.includes('withGlobalDatabase,')) {
      content = content.replace(/openGlobalDatabase,/, 'openGlobalDatabase,\\n  withGlobalDatabase,');
      if (!content.includes('withGlobalDatabase,')) {
         content = `import { withGlobalDatabase } from '../runners/global-db.js';
` + content;
      }
    }
    if (content.includes('withDatabase') && !content.includes('import { withDatabase }') && !content.includes('withDatabase,')) {
      content = content.replace(/openDatabase,/, 'openDatabase,\\n  withDatabase,');
      if (!content.includes('withDatabase,')) {
         content = `import { withDatabase } from '../database/connection.js';
` + content;
      }
    }
    
    // Fix async issues for withGlobalDatabase and withDatabase
    content = content.replace(/withGlobalDatabase\(\(db\)\s*=>\s*\{([\s\S]*?)\}\);/g, (match, inner) => {
      return inner.includes('await ') ? match.replace('((db)', '(async (db)') : match;
    });
    content = content.replace(/return withGlobalDatabase\(\(db\)\s*=>\s*\{([\s\S]*?)\}\);/g, (match, inner) => {
      return inner.includes('await ') ? match.replace('((db)', '(async (db)') : match;
    });
    
    fs.writeFileSync(file, content);
  }
}
