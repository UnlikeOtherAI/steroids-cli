import { readFileSync, writeFileSync } from 'fs';
import { globSync } from 'glob';

const files = globSync('tests/**/*.test.ts');
for (const file of files) {
  let content = readFileSync(file, 'utf8');
  if (content.includes("unstable_mockModule('../src/runners/projects.js'")) {
    if (!content.includes('clearProjectHibernation')) {
      content = content.replace(
        /jest\.unstable_mockModule\('\.\.\/src\/runners\/projects\.js', \(\) => \(\{(.*?)\}\)\);/s,
        (match, inner) => {
           return `jest.unstable_mockModule('../src/runners/projects.js', () => ({${inner}\n  setProjectHibernation: jest.fn(),\n  clearProjectHibernation: jest.fn(),\n}));`;
        }
      );
      writeFileSync(file, content);
      console.log(`Updated mocks in ${file}`);
    }
  }
}