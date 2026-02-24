import fs from 'fs';
import { globSync } from 'glob';

const testFiles = globSync('tests/**/*.ts');
for (const file of testFiles) {
  let content = fs.readFileSync(file, 'utf-8');
  let changed = false;

  if (content.includes("mockOpenGlobalDatabase")) {
    content = content.replace(/withGlobalDatabase: jest\.fn\(\)\.mockImplementation\(async\s*\(cb:\s*any\)\s*=>\s*\{[\s\S]*?\}\),/g, 
      "withGlobalDatabase: jest.fn().mockImplementation(async (cb: any) => { const { db } = mockOpenGlobalDatabase(); return await cb(db); }),");
    changed = true;
  } else if (content.includes("withGlobalDatabase: jest.fn().mockImplementation")) {
    content = content.replace(/withGlobalDatabase: jest\.fn\(\)\.mockImplementation\(async\s*\(cb:\s*any\)\s*=>\s*\{[\s\S]*?\}\),/g, 
      "withGlobalDatabase: jest.fn().mockImplementation(async (cb: any) => { return await cb({ prepare: () => ({ get: () => ({}), all: () => [], run: () => ({}) }), close: () => {}, exec: () => {} } as any); }),");
    changed = true;
  }
  
  if (content.includes("mockOpenDatabase")) {
    content = content.replace(/withDatabase: jest\.fn\(\)\.mockImplementation\(async\s*\(path:\s*any,\s*cb:\s*any\)\s*=>\s*\{[\s\S]*?\}\),/g, 
      "withDatabase: jest.fn().mockImplementation(async (path: any, cb: any) => { const { db } = mockOpenDatabase(path); return await cb(db); }),");
    changed = true;
  } else if (content.includes("withDatabase: jest.fn().mockImplementation")) {
    content = content.replace(/withDatabase: jest\.fn\(\)\.mockImplementation\(async\s*\(path:\s*any,\s*cb:\s*any\)\s*=>\s*\{[\s\S]*?\}\),/g, 
      "withDatabase: jest.fn().mockImplementation(async (path: any, cb: any) => { return await cb({ prepare: () => ({ get: () => ({}), all: () => [], run: () => ({}) }), close: () => {}, exec: () => {} } as any); }),");
    changed = true;
  }

  // merge.test.ts special case where it just fails with "require is not defined" or similar
  // tests/parallel/merge.test.ts might not have openGlobalDatabase mocked this way, or it has it differently. Let's let the script replace it.

  if (changed) {
    fs.writeFileSync(file, content);
  }
}
