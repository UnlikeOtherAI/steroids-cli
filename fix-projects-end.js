import fs from 'fs';
let projects = fs.readFileSync('src/runners/projects.ts', 'utf-8');
projects = projects.replace(/  \}\);
\}
$/g, '');
fs.writeFileSync('src/runners/projects.ts', projects);
