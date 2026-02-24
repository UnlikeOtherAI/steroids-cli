import fs from 'fs';
import { globSync } from 'glob';

const testFiles = globSync('tests/**/*.ts');
for (const file of testFiles) {
  let content = fs.readFileSync(file, 'utf-8');
  let changed = false;

  // Add withGlobalDatabase
  if (content.includes('openGlobalDatabase:') && !content.includes('withGlobalDatabase:')) {
    content = content.replace(/(openGlobalDatabase:\\s*.*?,)/g, "$1\\n  withGlobalDatabase: jest.fn().mockImplementation(async (cb: any) => {\\n    const { db } = typeof mockOpenGlobalDatabase !== 'undefined' ? mockOpenGlobalDatabase() : (typeof mockGlobalDb !== 'undefined' ? { db: mockGlobalDb } : { db: null as any });\\n    return await cb(db);\\n  }),");
    changed = true;
  }
  
  // Add withDatabase
  if (content.includes('openDatabase:') && !content.includes('withDatabase:')) {
    content = content.replace(/(openDatabase:\\s*.*?,)/g, "$1\\n  withDatabase: jest.fn().mockImplementation(async (path: any, cb: any) => {\\n    const { db } = typeof mockOpenDatabase !== 'undefined' ? mockOpenDatabase(path) : (typeof mockDb !== 'undefined' ? { db: mockDb } : { db: null as any });\\n    return await cb(db);\\n  }),");
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(file, content);
  }
}
