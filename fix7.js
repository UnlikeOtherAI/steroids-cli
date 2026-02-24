import fs from 'fs';
import { globSync } from 'glob';

const testFiles = globSync('tests/**/*.ts');
for (const file of testFiles) {
  let content = fs.readFileSync(file, 'utf-8');
  let changed = false;

  const lines = content.split('\\n');
  const newLines = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    newLines.push(line);
    
    if (line.includes('openGlobalDatabase:') && !content.includes('withGlobalDatabase:')) {
       newLines.push(`  withGlobalDatabase: jest.fn().mockImplementation(async (cb: any) => { const { db } = typeof mockOpenGlobalDatabase !== 'undefined' ? mockOpenGlobalDatabase() : (typeof mockGlobalDb !== 'undefined' ? { db: mockGlobalDb } : { db: null as any }); return await cb(db); }),`);
       changed = true;
    }
    
    if (line.includes('openDatabase:') && !content.includes('withDatabase:')) {
       newLines.push(`  withDatabase: jest.fn().mockImplementation(async (path: any, cb: any) => { const { db } = typeof mockOpenDatabase !== 'undefined' ? mockOpenDatabase(path) : (typeof mockDb !== 'undefined' ? { db: mockDb } : { db: null as any }); return await cb(db); }),`);
       changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(file, newLines.join('\\n'));
  }
}
