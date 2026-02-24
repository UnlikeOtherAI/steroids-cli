import fs from 'fs';
import { globSync } from 'glob';

const testFiles = globSync('tests/**/*.ts');
for (const file of testFiles) {
  let content = fs.readFileSync(file, 'utf-8');
  let changed = false;

  if (content.includes("const mockDb = null as any;")) {
    content = content.replace(/const mockDb = null as any;/g, "const mockDb = { prepare: () => ({ get: () => ({}), all: () => [], run: () => ({}) }), close: () => {}, exec: () => {} } as any;");
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(file, content);
  }
}
