import { parseArgs } from 'node:util';
import { withDatabase } from '../database/connection.js';
import { getSection, deleteSection } from '../database/queries.js';
import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { invalidArgumentsError, sectionNotFoundError } from '../cli/errors.js';
import { ErrorCode, getExitCode } from '../cli/errors.js';

export async function deleteSectionCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'sections', subcommand: 'delete', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      force: { type: 'boolean', short: 'f', default: false },
    },
    allowPositionals: true,
  });

  if (flags.help) {
    out.log(`
steroids sections delete <id> - Permanently delete a section

USAGE:
  steroids sections delete <id> [options]

ARGUMENTS:
  id    Section ID or prefix (min 4 chars)

OPTIONS:
  -f, --force   Also delete all tasks belonging to the section
  --dry-run     Show what would be deleted without making changes

GLOBAL OPTIONS:
  -j, --json    Output as JSON
  -h, --help    Show help

DESCRIPTION:
  Permanently deletes a section and removes all its dependency edges.
  By default, the command fails if the section still has tasks.
  Use --force to delete the section along with all its tasks.

EXAMPLES:
  steroids sections delete abc123
  steroids sections delete abc123 --force
`);
    return;
  }

  if (positionals.length === 0) {
    throw invalidArgumentsError('Section ID required');
  }

  const sectionIdInput = positionals[0];
  const projectPath = process.cwd();

  withDatabase(projectPath, (db: any) => {
    const section = getSection(db, sectionIdInput);
    if (!section) {
      throw sectionNotFoundError(sectionIdInput);
    }

    if (flags.dryRun) {
      const taskCount = (db.prepare('SELECT COUNT(*) as n FROM tasks WHERE section_id = ?').get(section.id) as { n: number }).n;
      out.log(`Would delete section: ${section.name} (${section.id})`);
      if (taskCount > 0) {
        if (values.force) {
          out.log(`  Would also delete ${taskCount} task(s)`);
        } else {
          out.log(`  Section has ${taskCount} task(s) — add --force to delete them too`);
        }
      }
      return;
    }

    let deletedTaskCount: number;
    try {
      deletedTaskCount = deleteSection(db, section.id, { force: values.force });
    } catch (err: any) {
      out.error(ErrorCode.GENERAL_ERROR, err.message);
      process.exit(getExitCode(ErrorCode.GENERAL_ERROR));
    }

    if (flags.json) {
      out.success({
        deleted: {
          id: section.id,
          name: section.name,
          deletedTaskCount,
        },
      });
    } else {
      out.log(`Deleted section: ${section.name} (${section.id})`);
      if (deletedTaskCount > 0) {
        out.log(`  Also deleted ${deletedTaskCount} task(s)`);
      }
    }
  });
}
