# Add steroids runners analyze Command

## Problem
Before starting multiple runners, users should be able to check for potential conflicts between sections. This command analyzes task specs and warns about overlapping files or dependencies.

## Files to Create/Modify
- `src/commands/runners.ts` - Add `analyze` subcommand
- NEW: `src/runners/conflict-analyzer.ts` - Analysis logic

## Implementation

### Step 1: Add subcommand to runners.ts

```typescript
// In HELP text:
SUBCOMMANDS:
  start               Start runner daemon
  stop                Stop runner(s)
  status              Show runner status
  list                List all runners
  logs                View daemon logs
  analyze             Analyze sections for conflicts  // NEW
  wakeup              Check and restart stale runners
  cron                Manage cron job

// In switch:
case 'analyze':
  await runAnalyze(subArgs);
  break;
```

### Step 2: Implement runAnalyze()

```typescript
async function runAnalyze(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      sections: { type: 'string', short: 's' },  // Comma-separated section names/IDs
      llm: { type: 'boolean', default: false },  // Use LLM for deep analysis
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
steroids runners analyze - Analyze sections for potential conflicts

USAGE:
  steroids runners analyze --sections "API,Mobile"
  steroids runners analyze "API" "Mobile" "Web"

OPTIONS:
  --sections <list>   Comma-separated section names or IDs
  --llm               Use LLM for deeper analysis (slower, more accurate)
  -j, --json          Output as JSON
  -h, --help          Show help

EXAMPLES:
  steroids runners analyze --sections "API,Mobile"
  steroids runners analyze "Phase 1" "Phase 2" --llm
`);
    return;
  }

  // Get sections to analyze
  const sectionInputs = values.sections
    ? (values.sections as string).split(',').map(s => s.trim())
    : args;

  if (sectionInputs.length < 2) {
    console.error('Need at least 2 sections to analyze for conflicts');
    console.error('Usage: steroids runners analyze --sections "API,Mobile"');
    process.exit(1);
  }

  const projectPath = process.cwd();
  const { db, close } = openDatabase(projectPath);

  try {
    // Resolve section IDs
    const sections = sectionInputs.map(input => {
      const section = getSection(db, input) || getSectionByName(db, input);
      if (!section) {
        console.error(`Section not found: ${input}`);
        process.exit(1);
      }
      return section;
    });

    // Run analysis
    const analysis = await analyzeConflicts(db, sections, {
      useLLM: values.llm as boolean,
      projectPath,
    });

    if (values.json) {
      console.log(JSON.stringify(analysis, null, 2));
      return;
    }

    // Display results
    displayAnalysisResults(analysis, sections);

  } finally {
    close();
  }
}
```

### Step 3: Create src/runners/conflict-analyzer.ts

```typescript
/**
 * Conflict Analyzer - Detect potential conflicts between sections
 */

import type Database from 'better-sqlite3';
import type { Section, Task } from '../database/types.js';

export interface ConflictAnalysis {
  canRunInParallel: boolean;
  confidence: 'high' | 'medium' | 'low';
  fileConflicts: FileConflict[];
  pathOverlaps: PathOverlap[];
  sharedDependencies: string[];
  recommendations: string[];
}

export interface FileConflict {
  sectionA: string;
  sectionB: string;
  taskA: string;
  taskB: string;
  files: string[];
  risk: 'high' | 'medium' | 'low';
  reason: string;
}

export interface PathOverlap {
  path: string;
  sections: string[];
  risk: 'high' | 'medium' | 'low';
}

export interface AnalyzeOptions {
  useLLM?: boolean;
  projectPath: string;
}

/**
 * Analyze sections for potential conflicts
 */
export async function analyzeConflicts(
  db: Database.Database,
  sections: Section[],
  options: AnalyzeOptions
): Promise<ConflictAnalysis> {
  const fileConflicts: FileConflict[] = [];
  const pathOverlaps: PathOverlap[] = [];
  const recommendations: string[] = [];

  // Get pending tasks for each section
  const sectionTasks = new Map<string, Task[]>();
  for (const section of sections) {
    const tasks = db.prepare(`
      SELECT * FROM tasks
      WHERE section_id = ? AND status IN ('pending', 'in_progress', 'review')
    `).all(section.id) as Task[];
    sectionTasks.set(section.id, tasks);
  }

  // === HEURISTIC ANALYSIS ===

  // 1. Check for common file patterns in task titles/specs
  const filePatterns = extractFilePatterns(sectionTasks);

  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      const sectionA = sections[i];
      const sectionB = sections[j];

      const patternsA = filePatterns.get(sectionA.id) || new Set();
      const patternsB = filePatterns.get(sectionB.id) || new Set();

      // Find overlapping patterns
      const overlap = [...patternsA].filter(p => patternsB.has(p));

      if (overlap.length > 0) {
        for (const pattern of overlap) {
          pathOverlaps.push({
            path: pattern,
            sections: [sectionA.name, sectionB.name],
            risk: pattern.includes('shared') || pattern.includes('common') ? 'high' : 'medium',
          });
        }
      }
    }
  }

  // 2. Check for shared keywords suggesting overlap
  const sharedKeywords = ['shared', 'common', 'utils', 'types', 'config', 'package.json'];
  const sharedDeps: string[] = [];

  for (const [sectionId, tasks] of sectionTasks) {
    for (const task of tasks) {
      const titleLower = task.title.toLowerCase();
      for (const keyword of sharedKeywords) {
        if (titleLower.includes(keyword)) {
          sharedDeps.push(`${sections.find(s => s.id === sectionId)?.name}: "${task.title}"`);
        }
      }
    }
  }

  // === LLM ANALYSIS (optional) ===

  if (options.useLLM) {
    // TODO: Implement LLM-based deep analysis
    // This would send task specs to Claude/Codex for conflict detection
    recommendations.push('LLM analysis not yet implemented - using heuristics only');
  }

  // === GENERATE RECOMMENDATIONS ===

  if (pathOverlaps.length === 0 && sharedDeps.length === 0) {
    recommendations.push('No obvious conflicts detected. Sections appear safe to run in parallel.');
  } else {
    if (pathOverlaps.some(p => p.risk === 'high')) {
      recommendations.push('HIGH RISK: Sections share paths that are commonly modified. Consider running sequentially.');
    }
    if (sharedDeps.length > 0) {
      recommendations.push(`Tasks mention shared code: ${sharedDeps.slice(0, 3).join(', ')}${sharedDeps.length > 3 ? '...' : ''}`);
      recommendations.push('Consider: Complete shared tasks first, then run sections in parallel.');
    }
  }

  // Determine overall verdict
  const hasHighRisk = pathOverlaps.some(p => p.risk === 'high') || fileConflicts.some(c => c.risk === 'high');
  const hasMediumRisk = pathOverlaps.some(p => p.risk === 'medium') || sharedDeps.length > 0;

  return {
    canRunInParallel: !hasHighRisk,
    confidence: options.useLLM ? 'high' : (hasMediumRisk ? 'medium' : 'low'),
    fileConflicts,
    pathOverlaps,
    sharedDependencies: [...new Set(sharedDeps)],
    recommendations,
  };
}

/**
 * Extract file/path patterns from task titles and specs
 */
function extractFilePatterns(sectionTasks: Map<string, Task[]>): Map<string, Set<string>> {
  const patterns = new Map<string, Set<string>>();

  // Common patterns to look for
  const pathRegex = /(?:src|lib|packages?|apps?)\/[\w\-\/]+(?:\.(?:ts|js|tsx|jsx|json|yaml|yml))?/gi;

  for (const [sectionId, tasks] of sectionTasks) {
    const sectionPatterns = new Set<string>();

    for (const task of tasks) {
      // Extract from title
      const titleMatches = task.title.match(pathRegex) || [];
      titleMatches.forEach(m => sectionPatterns.add(m.toLowerCase()));

      // Extract common directory names
      if (task.title.toLowerCase().includes('api')) sectionPatterns.add('api');
      if (task.title.toLowerCase().includes('mobile')) sectionPatterns.add('mobile');
      if (task.title.toLowerCase().includes('web')) sectionPatterns.add('web');
      if (task.title.toLowerCase().includes('shared')) sectionPatterns.add('shared');
      if (task.title.toLowerCase().includes('common')) sectionPatterns.add('common');
    }

    patterns.set(sectionId, sectionPatterns);
  }

  return patterns;
}

/**
 * Display analysis results
 */
function displayAnalysisResults(analysis: ConflictAnalysis, sections: Section[]): void {
  console.log('');
  console.log('═'.repeat(60));
  console.log('  MULTI-RUNNER CONFLICT ANALYSIS');
  console.log('═'.repeat(60));
  console.log('');

  console.log(`Sections analyzed: ${sections.map(s => s.name).join(', ')}`);
  console.log(`Confidence: ${analysis.confidence.toUpperCase()}`);
  console.log('');

  // Overall verdict
  if (analysis.canRunInParallel) {
    console.log('✅ SAFE TO RUN IN PARALLEL');
  } else {
    console.log('⚠️  CONFLICTS DETECTED - Review before proceeding');
  }
  console.log('');

  // Path overlaps
  if (analysis.pathOverlaps.length > 0) {
    console.log('📁 Path Overlaps:');
    for (const overlap of analysis.pathOverlaps) {
      const icon = overlap.risk === 'high' ? '🔴' : overlap.risk === 'medium' ? '🟡' : '🟢';
      console.log(`  ${icon} ${overlap.path}`);
      console.log(`     Sections: ${overlap.sections.join(', ')}`);
    }
    console.log('');
  }

  // Shared dependencies
  if (analysis.sharedDependencies.length > 0) {
    console.log('🔗 Tasks mentioning shared code:');
    for (const dep of analysis.sharedDependencies.slice(0, 5)) {
      console.log(`  - ${dep}`);
    }
    if (analysis.sharedDependencies.length > 5) {
      console.log(`  ... and ${analysis.sharedDependencies.length - 5} more`);
    }
    console.log('');
  }

  // Recommendations
  console.log('💡 Recommendations:');
  for (const rec of analysis.recommendations) {
    console.log(`  • ${rec}`);
  }
  console.log('');
}
```

## Usage

```bash
# Basic analysis
$ steroids runners analyze --sections "API,Mobile"

═══════════════════════════════════════════════════════════════
  MULTI-RUNNER CONFLICT ANALYSIS
═══════════════════════════════════════════════════════════════

Sections analyzed: API, Mobile
Confidence: MEDIUM

✅ SAFE TO RUN IN PARALLEL

📁 Path Overlaps:
  🟡 shared
     Sections: API, Mobile

🔗 Tasks mentioning shared code:
  - API: "Update shared types for user model"
  - Mobile: "Use shared auth utilities"

💡 Recommendations:
  • Tasks mention shared code: API: "Update shared types...", Mobile: "Use shared auth..."
  • Consider: Complete shared tasks first, then run sections in parallel.

# With LLM deep analysis (future)
$ steroids runners analyze --sections "API,Mobile" --llm
```

## Testing

```bash
# Create sections with potentially conflicting tasks
steroids sections add "Test API"
steroids sections add "Test Mobile"
steroids tasks add "Update shared/types.ts" --section "Test API" --source spec.md
steroids tasks add "Use shared utilities" --section "Test Mobile" --source spec.md

# Run analysis
steroids runners analyze --sections "Test API,Test Mobile"
```
