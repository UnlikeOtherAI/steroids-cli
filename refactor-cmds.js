import { Project, SyntaxKind } from 'ts-morph';
import fs from 'fs';

const project = new Project({
  tsConfigFilePath: 'tsconfig.json',
});

const sourceFiles = project.getSourceFiles('src/commands/*.ts');

for (const sourceFile of sourceFiles) {
  const fileName = sourceFile.getBaseName();
  if (fileName.includes('.test.') || fileName === 'index.ts') continue;

  const exportFuncs = sourceFile.getFunctions().filter(f => f.isExported() && f.getName()?.endsWith('Command'));
  if (exportFuncs.length === 0) continue;

  let changed = false;

  for (const func of exportFuncs) {
    const name = func.getName()!;
    const body = func.getBody();
    if (!body || !body.isKind(SyntaxKind.Block)) continue;

    const bodyText = body.getText();
    
    // Find parseArgs
    const parseArgsMatch = bodyText.match(/parseArgs\(\{\s*args,\s*options:\s*(\{[\s\S]*?\})\s*(?:,\s*allowPositionals:\s*(true|false))?\s*\}\)/);
    let optionsText = '{}';
    let allowPositionals = 'true';
    if (parseArgsMatch) {
       optionsText = parseArgsMatch[1];
       if (parseArgsMatch[2]) {
         allowPositionals = parseArgsMatch[2];
       }
    }

    // Determine requireInit
    const requireInit = bodyText.includes('!isInitialized(');

    // Find HELP constant
    const hasHelp = sourceFile.getVariableDeclaration('HELP');
    const helpVar = hasHelp ? 'HELP' : '`Run steroids ${name} --help for usage`';

    // Construct the new command definition
    const commandName = name.replace('Command', '');
    
    const handlerBody = bodyText
      .replace(/if\s*\(\s*flags\.help\s*\)\s*\{[\s\S]*?return;\s*\}/, '')
      .replace(/const\s*\{\s*values.*\}\s*=\s*parseArgs\(\{[\s\S]*?\}\);/, '')
      .replace(/if\s*\(\s*!isInitialized\([^)]*\)\s*\)\s*\{[\s\S]*?process\.exit\(1\);\s*\}/, '')
      .replace(/^\{\s*|\s*\}$/g, ''); // strip outer braces

    const newCode = `export const ${name} = defineCommand({
  name: '${commandName}',
  description: '${commandName} command',
  helpText: ${helpVar},
  requireInit: ${requireInit},
  options: ${optionsText},
  allowPositionals: ${allowPositionals},
  handler: async (args, flags, values, positionals) => {
${handlerBody}
  }
});`;

    // Replace the function with a variable declaration
    func.replaceWithText(newCode);
    changed = true;
  }

  if (changed) {
    // Add import for defineCommand
    if (!sourceFile.getImportDeclaration(i => i.getModuleSpecifierValue().includes('base-command'))) {
       sourceFile.addImportDeclaration({
         namedImports: ['defineCommand'],
         moduleSpecifier: '../cli/base-command.js'
       });
    }
    sourceFile.saveSync();
  }
}
