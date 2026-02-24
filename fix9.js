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
       // Check if mockOpenGlobalDatabase is used
       if (line.includes('mockOpenGlobalDatabase')) {
         newLines.push(`  withGlobalDatabase: async (cb: any) => { const { db } = typeof mockOpenGlobalDatabase !== 'undefined' ? mockOpenGlobalDatabase() : (global as any).mockGlobalDb; return await cb(db); },`);
       } else {
         newLines.push(`  withGlobalDatabase: async (cb: any) => { return await cb((global as any).mockGlobalDb); },`);
       }
       changed = true;
    }
    
    if (line.includes('openDatabase:') && !content.includes('withDatabase:')) {
       if (line.includes('mockOpenDatabase')) {
         newLines.push(`  withDatabase: async (path: any, cb: any) => { const { db } = typeof mockOpenDatabase !== 'undefined' ? mockOpenDatabase(path) : (global as any).mockDb; return await cb(db); },`);
       } else {
         newLines.push(`  withDatabase: async (path: any, cb: any) => { return await cb((global as any).mockDb); },`);
       }
       changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(file, newLines.join('\\n'));
  }
}
