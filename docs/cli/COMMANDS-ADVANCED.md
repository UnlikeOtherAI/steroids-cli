# Advanced CLI Commands

> Commands for purging, runners, and system maintenance.
> For core commands, see [COMMANDS.md](./COMMANDS.md)

---

## `steroids purge`

Remove completed tasks and clean up system state.

```
Usage: steroids purge [options]
       steroids purge tasks [options]
       steroids purge ids [options]
       steroids purge logs [options]

Subcommands:
  steroids purge tasks       Remove completed tasks from TODO.md
  steroids purge ids         Clean up orphaned IDs from ids.json
  steroids purge logs        Remove old runner logs
  steroids purge all         Run all purge operations

Task Purge Options:
  --status <status>           Purge by status: completed | review (default: completed)
  --older-than <duration>     Only purge tasks completed before duration (e.g., 7d, 30d)
  --section <name>            Only purge from specific section
  --keep-audit                Keep audit trail in ids.json after purging
  --archive <file>            Archive purged tasks to file before removing

ID Purge Options:
  --orphaned                  Remove orphaned IDs (tasks no longer in file)
  --older-than <duration>     Only purge orphaned IDs older than duration

Log Purge Options:
  --older-than <duration>     Remove logs older than duration (default: 7d)

Safety Options:
  --dry-run                   Preview what would be purged
  --yes                       Skip confirmation prompt
  --backup                    Create backup before purging (overrides config)
  --no-backup                 Skip backup (overrides config)

Examples:
  # Preview what would be purged
  steroids purge tasks --dry-run

  # Purge completed tasks older than 30 days
  steroids purge tasks --older-than 30d

  # Purge and archive to file
  steroids purge tasks --archive ./archive/2024-01.md

  # Purge all completed tasks (with confirmation)
  steroids purge tasks --status completed

  # Purge orphaned IDs
  steroids purge ids --orphaned

  # Purge old logs
  steroids purge logs --older-than 14d

  # Full cleanup, non-interactive
  steroids purge all --older-than 30d --yes

Output (JSON):
  {
    "purged": {
      "tasks": 15,
      "ids": 8,
      "logs": 42
    },
    "archived": "./archive/2024-01.md",
    "backup": ".steroids/backup/2024-01-15.json"
  }
```

---

## `steroids runners`

Manage global LLM agent coordinators.

```
Usage: steroids runners <subcommand> [options]

Subcommands:
  steroids runners list                   List all runners
  steroids runners start                  Start a new runner
  steroids runners stop <id>              Stop a runner by ID
  steroids runners wakeup                 Check and restart stalled workflows
  steroids runners logs [id]              View runner logs
  steroids runners cron <action>          Manage cron wake-up job

List Options:
  --status <status>           Filter by: idle | running | completed | failed

Start Options:
  --project <path>            Project path (default: current directory)
  --task <id>                 Start with specific task GUID
  --model <model>             LLM model to use

Stop Options:
  --all                       Stop all runners
  --force                     Force kill (SIGKILL)

Wakeup Options:
  --dry-run                   Show what would happen without executing

Logs Options:
  --follow                    Follow log output (tail -f)
  --limit <n>                 Number of lines to show (default: 100)
  --all                       Show all runner logs

Cron Actions:
  install                     Install cron job for wake-up
  uninstall                   Remove cron job
  status                      Check if cron job is installed

Examples:
  steroids runners list
  steroids runners list --status running --json
  steroids runners start --project ~/my-project
  steroids runners start --task a1b2c3d4-e5f6-7890-abcd-ef1234567890
  steroids runners stop f47ac10b-58cc-4372-a567-0e02b2c3d479
  steroids runners stop --all
  steroids runners wakeup --dry-run
  steroids runners logs --follow
  steroids runners cron install
  steroids runners cron status
```

---

## `steroids backup`

Manage backups of project state.

```
Usage: steroids backup <subcommand> [options]

Subcommands:
  steroids backup create     Create a new backup
  steroids backup list       List available backups
  steroids backup restore    Restore from a backup
  steroids backup clean      Remove old backups

Create Options:
  --output <path>             Custom backup destination
  --include <files>           Additional files to include (comma-separated)

List Options:
  --limit <n>                 Number of backups to show
  --older-than <duration>     Only show backups older than duration

Restore Options:
  --dry-run                   Preview what would be restored
  --force                     Overwrite existing files without prompt

Clean Options:
  --older-than <duration>     Remove backups older than duration
  --keep <n>                  Keep at least n most recent backups
  --dry-run                   Preview what would be removed

Examples:
  # Create backup
  steroids backup create
  steroids backup create --output ~/backups/my-project

  # List backups
  steroids backup list

  # Restore from backup
  steroids backup restore .steroids/backup/2024-01-15T10-30-00
  steroids backup restore --dry-run .steroids/backup/2024-01-15T10-30-00

  # Clean old backups
  steroids backup clean --older-than 30d
  steroids backup clean --keep 5
```

---

## `steroids gc`

Garbage collection and cleanup utilities.

```
Usage: steroids gc [options]

Options:
  --orphaned-ids              Clean orphaned IDs from ids.json
  --stale-runners             Clean stale runner state
  --temp-files                Remove temporary files
  --all                       Run all cleanup operations
  --dry-run                   Preview what would be cleaned

Examples:
  steroids gc --orphaned-ids
  steroids gc --all --dry-run
  steroids gc --all
```

---

## Related Documentation

- [COMMANDS.md](./COMMANDS.md) - Core CLI commands
- [RUNNERS.md](./RUNNERS.md) - Runner system details
- [STORAGE.md](./STORAGE.md) - Purge and backup storage
- [AUDIT.md](./AUDIT.md) - Audit trail documentation
