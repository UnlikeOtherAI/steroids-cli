import fs from 'fs';
import { globSync } from 'glob';

// Fix wakeup-checks.ts
const wakeupChecksFile = 'src/runners/wakeup-checks.ts';
if (fs.existsSync(wakeupChecksFile)) {
  let content = fs.readFileSync(wakeupChecksFile, 'utf-8');
  if (content.includes('withGlobalDatabase') && !content.includes('import { withGlobalDatabase }') && !content.includes('withGlobalDatabase,')) {
    content = `import { withGlobalDatabase } from './global-db.js';
` + content;
  }
  if (content.includes('withDatabase') && !content.includes('import { withDatabase }') && !content.includes('withDatabase,')) {
    content = `import { withDatabase } from '../database/connection.js';
` + content;
  }
  content = content.replace(/withDatabase\(([^,]+),\s*\{[^\}]+\},\s*\(db\)\s*=>/g, 'withDatabase($1, (db: any) =>');
  content = content.replace(/withGlobalDatabase\(\(db\)\s*=>/g, 'withGlobalDatabase((db: any) =>');
  
  // also fix the async returns for projectHasPendingWork
  content = content.replace(/export async function projectHasPendingWork([^\{]+)\{([\s\S]*?withDatabase[^\{]+\{)([\s\S]*?)\}\);?\s*\}/, (match, p1, p2, p3) => {
     return `export async function projectHasPendingWork${p1}{ return ${p2.replace('withDatabase', 'withDatabase')}${p3}}); }`;
  });
  
  fs.writeFileSync(wakeupChecksFile, content);
}

// Fix test mocks require
const testFiles = globSync('tests/**/*.ts');
for (const file of testFiles) {
  let content = fs.readFileSync(file, 'utf-8');
  let changed = false;

  if (content.includes("require('better-sqlite3')")) {
    content = content.replace(/require\\('better-sqlite3'\\)/g, "(await import('better-sqlite3')).default");
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(file, content);
  }
}
