import fs from 'fs';
import { globSync } from 'glob';

const testFiles = globSync('tests/**/*.ts');
for (const file of testFiles) {
  let content = fs.readFileSync(file, 'utf-8');
  let changed = false;

  if (content.includes('
  withGlobalDatabase:')) {
    content = content.replace(/
\s+withGlobalDatabase:/g, '
  withGlobalDatabase:');
    changed = true;
  }
  if (content.includes('
  withDatabase:')) {
    content = content.replace(/
\s+withDatabase:/g, '
  withDatabase:');
    changed = true;
  }
  // There's also `tests/task-selector-parallel.test.ts:390:274 - error TS2304: Cannot find name 'n'.`
  // It's probably because it says `...return await cb(db); }),
  withDatabase:`
  if (content.includes('}),
  withDatabase:')) {
    content = content.replace(/\}\),
\s+withDatabase:/g, '}),
  withDatabase:');
    changed = true;
  }
  // And `mockOpenGlobalDatabase` missing error
  // If a file doesn't have `mockOpenGlobalDatabase` defined but the mock tries to use it, it fails typechecking because of `typeof mockOpenGlobalDatabase` but TS still checks if it's declared in the file unless it's on `global` or `any`.
  // Wait! `typeof mockOpenGlobalDatabase` is evaluated by TS, and if it's never declared, TS throws "Cannot find name 'mockOpenGlobalDatabase'"!
  // To avoid TS errors for undeclared variables, we MUST use `(global as any).mockOpenGlobalDatabase` or `eval('typeof mockOpenGlobalDatabase')` or similar.
  // Actually, we can just replace `mockOpenGlobalDatabase` with `(global as any).mockOpenGlobalDatabase`.
  
  if (content.includes('typeof mockOpenGlobalDatabase')) {
    content = content.replace(/typeof mockOpenGlobalDatabase !== 'undefined' \? mockOpenGlobalDatabase\(\)/g, "typeof (global as any).mockOpenGlobalDatabase !== 'undefined' ? (global as any).mockOpenGlobalDatabase()");
    changed = true;
  }
  if (content.includes('typeof mockGlobalDb')) {
    content = content.replace(/typeof mockGlobalDb !== 'undefined' \? \{ db: mockGlobalDb \}/g, "typeof (global as any).mockGlobalDb !== 'undefined' ? { db: (global as any).mockGlobalDb }");
    changed = true;
  }
  if (content.includes('typeof mockOpenDatabase')) {
    content = content.replace(/typeof mockOpenDatabase !== 'undefined' \? mockOpenDatabase\(path\)/g, "typeof (global as any).mockOpenDatabase !== 'undefined' ? (global as any).mockOpenDatabase(path)");
    changed = true;
  }
  if (content.includes('typeof mockDb')) {
    content = content.replace(/typeof mockDb !== 'undefined' \? \{ db: mockDb \}/g, "typeof (global as any).mockDb !== 'undefined' ? { db: (global as any).mockDb }");
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(file, content);
  }
}
