import fs from 'fs';
import { globSync } from 'glob';

const files = globSync('tests/**/*.ts');

for (const file of files) {
  let content = fs.readFileSync(file, 'utf-8');
  let changed = false;

  // Fix global-db mocks
  if (content.includes('unstable_mockModule') && content.includes('global-db.js')) {
    content = content.replace(/(jest\.unstable_mockModule\(['"].*global-db\.js['"],\s*\(\)\s*=>\s*\({\s*)/g, '$1withGlobalDatabase: jest.fn().mockImplementation(async (cb) => {\n    const mockDb = require(\'better-sqlite3\')(\':memory:\');\n    // try to get globalDb from outer scope if it exists, else use new memory db\n    // actually, most tests define \`globalDb\` or \`mockGlobalDb\`\n    try { return await cb(typeof globalDb !== "undefined" ? globalDb : mockDb); } catch(e) { return await cb(mockDb); }\n  }),\n  ');
    changed = true;
  }
  
  // Fix connection mocks
  if (content.includes('unstable_mockModule') && content.includes('database/connection.js')) {
    content = content.replace(/(jest\.unstable_mockModule\(['"].*database\/connection\.js['"],\s*\(\)\s*=>\s*\({\s*)/g, '$1withDatabase: jest.fn().mockImplementation(async (path, cb) => {\n    const mockDb = require(\'better-sqlite3\')(\':memory:\');\n    try { return await cb(typeof db !== "undefined" ? db : mockDb); } catch(e) { return await cb(mockDb); }\n  }),\n  ');
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(file, content);
  }
}
