import fs from 'fs';
import { globSync } from 'glob';

// Fix reviewer.ts
const reviewerFile = 'src/orchestrator/reviewer.ts';
let reviewerContent = fs.readFileSync(reviewerFile, 'utf-8');
reviewerContent = reviewerContent.replace(/resumeSessionId\?\.substring/g, '(resumeSessionId as string | null)?.substring');
fs.writeFileSync(reviewerFile, reviewerContent);

// Fix missing imports in src files
const srcFiles = ['src/git/submission-resolution.ts', 'src/parallel/merge-conflict.ts'];
for (const file of srcFiles) {
  let content = fs.readFileSync(file, 'utf-8');
  if (content.includes('withGlobalDatabase') && !content.includes('import { withGlobalDatabase }') && !content.includes('withGlobalDatabase,')) {
    content = content.replace(/openGlobalDatabase,/, 'openGlobalDatabase,\\n  withGlobalDatabase,');
    if (!content.includes('withGlobalDatabase,')) {
       content = `import { withGlobalDatabase } from '../runners/global-db.js';\\n` + content;
    }
    fs.writeFileSync(file, content);
  }
}

// Fix test mocks
const testFiles = globSync('tests/**/*.ts');
for (const file of testFiles) {
  let content = fs.readFileSync(file, 'utf-8');
  let changed = false;

  content = content.replace(/async\s*\(cb\)\s*=>/g, 'async (cb: any) =>');
  content = content.replace(/async\s*\(path,\s*cb\)\s*=>/g, 'async (path: any, cb: any) =>');
  content = content.replace(/typeof globalDb !== "undefined" \? globalDb : mockDb/g, '(global as any).globalDb || mockDb');
  content = content.replace(/typeof db !== "undefined" \? db : mockDb/g, '(global as any).db || mockDb');

  if (content !== fs.readFileSync(file, 'utf-8')) {
    fs.writeFileSync(file, content);
  }
}
