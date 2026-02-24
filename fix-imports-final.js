import fs from 'fs';
import { globSync } from 'glob';

// Fix imports in src/**/*.ts
const srcFiles = globSync('src/**/*.ts');
for (const file of srcFiles) {
  let content = fs.readFileSync(file, 'utf-8');
  let changed = false;

  if (content.includes('withDatabase') && !content.includes('import { withDatabase }') && !content.includes('withDatabase,')) {
    if (content.includes('openDatabase')) {
       content = content.replace(/openDatabase,/, 'openDatabase, withDatabase,');
    } else {
       content = `import { withDatabase } from '../database/connection.js';
` + content;
    }
    changed = true;
  }
  
  if (content.includes('withGlobalDatabase') && !content.includes('import { withGlobalDatabase }') && !content.includes('withGlobalDatabase,')) {
    if (content.includes('openGlobalDatabase')) {
       content = content.replace(/openGlobalDatabase,/, 'openGlobalDatabase, withGlobalDatabase,');
    } else {
       // if we are in runners directory
       if (file.includes('src/runners')) {
          content = `import { withGlobalDatabase } from './global-db.js';
` + content;
       } else {
          content = `import { withGlobalDatabase } from '../runners/global-db.js';
` + content;
       }
    }
    changed = true;
  }
  
  // Fix untyped (db)
  if (content.match(/withDatabase\(([^,]+), \(db\)/)) {
     content = content.replace(/withDatabase\(([^,]+), \(db\)/g, 'withDatabase($1, (db: any)');
     changed = true;
  }
  if (content.match(/withGlobalDatabase\(\(db\)/)) {
     content = content.replace(/withGlobalDatabase\(\(db\)/g, 'withGlobalDatabase((db: any)');
     changed = true;
  }
  
  // Fix missing projectPath
  if (content.match(/withDatabase\(projectPath/)) {
     // If the file doesn't have projectPath defined, we use process.cwd()
     if (!content.includes('const projectPath =') && !content.includes('let projectPath =') && !content.includes('projectPath: string')) {
        content = content.replace(/withDatabase\(projectPath/g, 'withDatabase(process.cwd()');
        changed = true;
     }
  }

  // Remove dangling close() calls
  if (content.match(/^\s*close\(\);\s*$/m)) {
     content = content.replace(/^\s*close\(\);\s*$/gm, '');
     changed = true;
  }

  // Fix await issues (if the function is marked async but it's not actually an async closure)
  if (content.match(/await /)) {
      content = content.replace(/withDatabase\(([^,]+), \(db: any\) => \{([\s\S]*?await[\s\S]*?)\}/g, 'withDatabase($1, async (db: any) => {$2}');
      content = content.replace(/withDatabase\(([^,]+), async \(db: any\) => \{([\s\S]*?await[\s\S]*?)\}/g, 'withDatabase($1, async (db: any) => {$2}');
      content = content.replace(/withGlobalDatabase\(\(db: any\) => \{([\s\S]*?await[\s\S]*?)\}/g, 'withGlobalDatabase(async (db: any) => {$2}');
      changed = true;
  }

  if (changed) {
    fs.writeFileSync(file, content);
  }
}
