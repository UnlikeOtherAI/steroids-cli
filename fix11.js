import fs from 'fs';
import { globSync } from 'glob';

// Fix commands
const commandFiles = globSync('src/commands/*.ts');
for (const file of commandFiles) {
  let content = fs.readFileSync(file, 'utf-8');
  let changed = false;
  if (content.includes('withDatabase(, (db)')) {
    // If the file uses withDatabase without a path, the path is usually `projectPath`
    // Wait, the original code had `openDatabase(projectPath)` or `openDatabase(process.cwd())`.
    // We can just use `projectPath` if it's declared, or `process.cwd()`
    // We will just do `process.cwd()` to be safe, or look for `const projectPath`.
    content = content.replace(/\/\* REFACTOR_MANUAL \*\/ withDatabase\(, \(db\)/g, 'withDatabase(projectPath, (db)');
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(file, content);
  }
}

// Fix prompts
let coder = fs.readFileSync('src/prompts/coder.ts', 'utf-8');
coder = coder.replace(/4\. Include this exact contract block:
   ```
   ## REJECTION_RESPONSE/g, '4. Include this exact contract block:
   ```
   ## REJECTION_RESPONSE');
coder = coder.replace(/   ITEM-2 \| WONT_FIX \| <exceptional reason \+ proof solution still works>
   ```/g, '   ITEM-2 | WONT_FIX | <exceptional reason + proof solution still works>
   ```');
coder = coder.replace(/matching `ITEM-<n>` response\./g, 'matching `ITEM-<n>` response.');
coder = coder.replace(/- `WONT_FIX` is a high/g, '- `WONT_FIX` is a high');
coder = coder.replace(/includes `MUST_IMPLEMENT:`, those/g, 'includes `MUST_IMPLEMENT:`, those');
coder = coder.replace(/marked `WONT_FIX`\./g, 'marked `WONT_FIX`.');
fs.writeFileSync('src/prompts/coder.ts', coder);

let reviewer = fs.readFileSync('src/prompts/reviewer.ts', 'utf-8');
reviewer = reviewer.replace(/- `DECISION: APPROVE`/g, '- `DECISION: APPROVE`');
reviewer = reviewer.replace(/- `DECISION: REJECT`/g, '- `DECISION: REJECT`');
reviewer = reviewer.replace(/- `DECISION: DISPUTE`/g, '- `DECISION: DISPUTE`');
reviewer = reviewer.replace(/- `DECISION: SKIP`/g, '- `DECISION: SKIP`');
reviewer = reviewer.replace(/\*\*Output:\*\*
```
DECISION: APPROVE/g, '**Output:**
```
DECISION: APPROVE');
reviewer = reviewer.replace(/- \*\*Task Title:\*\* Description of what needs to be done later\.
```/g, '- **Task Title:** Description of what needs to be done later.
```');
reviewer = reviewer.replace(/list them under `### Follow Up Tasks`/g, 'list them under `### Follow Up Tasks`');
fs.writeFileSync('src/prompts/reviewer.ts', reviewer);

// Fix projects.ts
let projects = fs.readFileSync('src/runners/projects.ts', 'utf-8');
// remove the trailing syntax error lines
projects = projects.replace(/  \}\);
\}
$/, '');
fs.writeFileSync('src/runners/projects.ts', projects);
