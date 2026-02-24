import { readFileSync, writeFileSync } from 'fs';
import { globSync } from 'glob';

const files = globSync('tests/**/*.test.ts');
for (const file of files) {
  let content = readFileSync(file, 'utf8');
  let changed = false;

  if (content.includes("unstable_mockModule('../src/runners/global-db.js'")) {
    if (!content.includes('getDaemonActiveStatus:')) {
      content = content.replace(
        /jest\.unstable_mockModule\('\.\.\/src\/runners\/global-db\.js', \(\) => \(\{(.*?)\}\)\);/s,
        (match, inner) => {
           return `jest.unstable_mockModule('../src/runners/global-db.js', () => ({${inner}
  getDaemonActiveStatus: jest.fn().mockReturnValue(true),
  setDaemonActiveStatus: jest.fn(),
}));`;
        }
      );
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(file, content);
    console.log(`Updated global-db mocks in ${file}`);
  }
}