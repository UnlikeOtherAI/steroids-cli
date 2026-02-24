import fs from 'fs';
import path from 'path';
import { globSync } from 'glob';

const files = globSync('src/**/*.ts');
let totalReplaced = 0;

for (const file of files) {
  let content = fs.readFileSync(file, 'utf-8');
  let originalContent = content;

  // Replace openGlobalDatabase
  // With varying whitespace and inner content. We use a while loop to handle nested/sequential replacements.
  
  let changed = true;
  while (changed) {
    changed = false;
    
    // Pattern for openGlobalDatabase
    const globalPattern = /(?:const|let)\s+\{\s*db\s*,\s*close\s*\}\s*=\s*openGlobalDatabase\(\s*\)\s*;\s*try\s*\{([\s\S]*?)\}\s*finally\s*\{\s*close\(\s*\)\s*;\s*\}/g;
    const globalPattern2 = /(?:const|let)\s+([a-zA-Z0-9_]+)\s*=\s*openGlobalDatabase\(\s*\)\s*;\s*try\s*\{([\s\S]*?)\}\s*finally\s*\{\s*\1\.close\(\s*\)\s*;\s*\}/g;
    
    const newContent = content.replace(globalPattern, (match, inner) => {
      changed = true;
      const hasReturn = /\breturn\b/.test(inner);
      const prefix = hasReturn ? 'return ' : '';
      return `${prefix}withGlobalDatabase((db) => {${inner}});`;
    }).replace(globalPattern2, (match, varName, inner) => {
      changed = true;
      const hasReturn = /\breturn\b/.test(inner);
      const prefix = hasReturn ? 'return ' : '';
      return `${prefix}withGlobalDatabase((${varName}Db) => {\nconst ${varName} = { db: ${varName}Db };\n${inner}});`;
    });
    
    if (changed) {
      content = newContent;
      totalReplaced++;
    }
  }

  // Pattern for openDatabase(args)
  changed = true;
  while (changed) {
    changed = false;
    
    const dbPattern = /(?:const|let)\s+\{\s*db\s*,\s*close\s*\}\s*=\s*openDatabase\((.*?)\)\s*;\s*try\s*\{([\s\S]*?)\}\s*finally\s*\{\s*close\(\s*\)\s*;\s*\}/g;
    const dbPattern2 = /(?:const|let)\s+([a-zA-Z0-9_]+)\s*=\s*openDatabase\((.*?)\)\s*;\s*try\s*\{([\s\S]*?)\}\s*finally\s*\{\s*\1\.close\(\s*\)\s*;\s*\}/g;
    
    const newContent = content.replace(dbPattern, (match, args, inner) => {
      changed = true;
      const hasReturn = /\breturn\b/.test(inner);
      return `/* REFACTOR_MANUAL */ withDatabase(${args}, (db) => {${inner}});`;
    }).replace(dbPattern2, (match, varName, args, inner) => {
      changed = true;
      const hasReturn = /\breturn\b/.test(inner);
      return `/* REFACTOR_MANUAL */ withDatabase(${args}, (${varName}Db) => {\nconst ${varName} = { db: ${varName}Db };\n${inner}});`;
    });
    
    if (changed) {
      content = newContent;
      totalReplaced++;
    }
  }
  
  if (content !== originalContent) {
    // Add imports if necessary
    if (content.includes('withGlobalDatabase(') && !content.includes('withGlobalDatabase')) {
      content = content.replace(/openGlobalDatabase/, 'openGlobalDatabase, withGlobalDatabase');
    }
    if (content.includes('withDatabase(') && !content.includes('withDatabase')) {
      content = content.replace(/openDatabase/, 'openDatabase, withDatabase');
    }
    
    fs.writeFileSync(file, content);
  }
}

console.log(`Replaced ${totalReplaced} blocks.`);
