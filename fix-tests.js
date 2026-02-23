import fs from 'fs';

const files = [
  'tests/wakeup-helpers.test.ts',
  'tests/wakeup-project-iteration.test.ts',
  'tests/wakeup-basic.test.ts'
];

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');

  // Add initDatabase to imports
  content = content.replace("import { openDatabase }", "import { openDatabase, initDatabase }");

  // Replace openDatabase with initDatabase inside createTestProject
  content = content.replace(
    /const \{ db, close \} = openDatabase\(projectPath\);/g,
    "const { db, close } = initDatabase(projectPath);"
  );

  fs.writeFileSync(file, content);
}
