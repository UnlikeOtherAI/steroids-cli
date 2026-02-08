/**
 * Graph generation helpers for sections command
 */

import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { STATUS_MARKERS } from '../database/queries.js';

export interface SectionWithDeps {
  section: {
    id: string;
    name: string;
    priority?: number;
  };
  dependencies: Array<{ id: string }>;
  pendingDeps: any[];
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    rejection_count: number;
  }>;
}

// Generate Mermaid flowchart syntax
export function generateMermaidSyntax(
  sectionsWithDeps: SectionWithDeps[],
  includeTasks: boolean
): string {
  let mermaid = 'graph TD\n';
  const nodeIds = new Map<string, string>();
  const taskNodes: Array<{ id: string; status: string }> = [];

  // Generate node IDs
  sectionsWithDeps.forEach((item, idx) => {
    nodeIds.set(item.section.id, `S${idx}`);
  });

  // Generate section nodes and task subgraphs
  sectionsWithDeps.forEach((item) => {
    const nodeId = nodeIds.get(item.section.id)!;
    const priority = item.section.priority ?? 50;
    const blocked = item.pendingDeps.length > 0 ? ' [BLOCKED]' : '';

    if (includeTasks && item.tasks.length > 0) {
      // Create subgraph for section with tasks
      mermaid += `    subgraph ${nodeId}["${item.section.name} (priority: ${priority})${blocked}"]\n`;
      item.tasks.forEach((task, idx) => {
        const taskId = `${nodeId}_T${idx}`;
        const marker = STATUS_MARKERS[task.status as keyof typeof STATUS_MARKERS] || '[ ]';
        const rejections = task.rejection_count > 0 ? ` (${task.rejection_count})` : '';
        mermaid += `        ${taskId}["${marker} ${task.title}${rejections}"]\n`;

        // Track task nodes for styling
        taskNodes.push({ id: taskId, status: task.status });
      });
      mermaid += '    end\n';
    } else {
      // Simple section node
      mermaid += `    ${nodeId}["${item.section.name} (priority: ${priority})${blocked}"]\n`;
    }
  });

  // Generate dependency arrows
  sectionsWithDeps.forEach((item) => {
    const nodeId = nodeIds.get(item.section.id)!;
    item.dependencies.forEach((dep) => {
      const depNodeId = nodeIds.get(dep.id);
      if (depNodeId) {
        mermaid += `    ${depNodeId} --> ${nodeId}\n`;
      }
    });
  });

  // Add class definitions for task status colors
  if (includeTasks && taskNodes.length > 0) {
    mermaid += '\n';
    mermaid += '    classDef pending fill:#9ca3af,stroke:#6b7280,color:#000\n';
    mermaid += '    classDef in_progress fill:#3b82f6,stroke:#2563eb,color:#fff\n';
    mermaid += '    classDef review fill:#eab308,stroke:#ca8a04,color:#000\n';
    mermaid += '    classDef completed fill:#22c55e,stroke:#16a34a,color:#fff\n';
    mermaid += '    classDef disputed fill:#f97316,stroke:#ea580c,color:#fff\n';
    mermaid += '    classDef failed fill:#ef4444,stroke:#dc2626,color:#fff\n';
    mermaid += '\n';

    // Apply classes to task nodes
    taskNodes.forEach(({ id, status }) => {
      mermaid += `    class ${id} ${status}\n`;
    });
  }

  return mermaid;
}

// Check if mmdc is installed
export function isMmdcInstalled(): boolean {
  try {
    execSync('which mmdc', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Prompt to install mmdc (just shows message for now)
export async function installMmdc(): Promise<boolean> {
  console.log('Mermaid CLI not found. Install it to generate images.');
  console.log('Run: npm install -g @mermaid-js/mermaid-cli');
  console.log('');
  console.error('Error: Please install @mermaid-js/mermaid-cli manually');
  return false;
}

// Generate image from Mermaid syntax
export async function generateImageFromMermaid(
  mermaidSyntax: string,
  format: string,
  autoOpen: boolean
): Promise<void> {
  if (!['png', 'svg'].includes(format)) {
    console.error('Error: Output format must be png or svg');
    process.exit(1);
  }

  // Check if mmdc is installed
  if (!isMmdcInstalled()) {
    const installed = await installMmdc();
    if (!installed) {
      process.exit(1);
    }
  }

  // Generate temp files
  const timestamp = Date.now();
  const tempDir = tmpdir();
  const mmdPath = join(tempDir, `steroids-graph-${timestamp}.mmd`);
  const outputPath = join(tempDir, `steroids-sections-graph-${timestamp}.${format}`);

  try {
    // Write Mermaid syntax to temp file
    writeFileSync(mmdPath, mermaidSyntax, 'utf8');

    // Run mmdc to generate image
    execSync(`mmdc -i "${mmdPath}" -o "${outputPath}" -b transparent`, {
      stdio: 'pipe',
    });

    // Output the absolute path
    console.log(outputPath);

    // Auto-open if requested
    if (autoOpen) {
      const platform = process.platform;
      let openCmd: string;

      if (platform === 'darwin') {
        openCmd = `open "${outputPath}"`;
      } else if (platform === 'win32') {
        openCmd = `start "${outputPath}"`;
      } else {
        openCmd = `xdg-open "${outputPath}"`;
      }

      execSync(openCmd, { stdio: 'pipe' });
    }

    // Clean up the .mmd file
    unlinkSync(mmdPath);
  } catch (error: any) {
    console.error(`Error generating image: ${error.message}`);
    try {
      unlinkSync(mmdPath);
    } catch {}
    process.exit(1);
  }
}
