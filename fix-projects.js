import fs from 'fs';

let content = fs.readFileSync('src/runners/projects.ts', 'utf-8');

// Remove types
content = content.replace(/\s*hibernating_until\?: string \| null;/g, '');
content = content.replace(/\s*hibernation_tier\?: number;/g, '');
content = content.replace(/\s*hibernating_until: [^,]*,/g, '');
content = content.replace(/\s*hibernation_tier: [^,]*,?/g, '');

// Remove setProjectHibernation
content = content.replace(/\/\*\*\s*\*\s*Set hibernation state for a project\s*\*\/\s*export function setProjectHibernation[\s\S]*?\}\s*\}\s*/, '');

// Remove clearProjectHibernation
content = content.replace(/\/\*\*\s*\*\s*Clear hibernation state for a project\s*\*\/\s*export function clearProjectHibernation[\s\S]*?\}\s*\}\s*/, '');

fs.writeFileSync('src/runners/projects.ts', content);
