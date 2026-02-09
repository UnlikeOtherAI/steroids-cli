# Watch Command Specification

## Overview

The `steroids watch` command provides a real-time terminal dashboard showing the current state of the automation system. It combines runner status, task progress, and live log output into a single view.

## Command

```bash
steroids watch [options]
```

## Options

| Option | Description |
|--------|-------------|
| `--refresh <ms>` | Refresh interval in milliseconds (default: 1000) |
| `--no-logs` | Hide log output panel |
| `--compact` | Minimal single-line status |
| `-j, --json` | Output as JSON stream (for piping) |
| `-h, --help` | Show help |

## Display Layout

```
╔════════════════════════════════════════════════════════════════════╗
║                        STEROIDS WATCH                               ║
╠════════════════════════════════════════════════════════════════════╣
║ Runner: ACTIVE (pid: 12345)              Uptime: 2h 15m             ║
║ Task:   Implement user auth [a1b2c3d4]   Phase: CODER               ║
║ Status: in_progress                      Attempt: 2/15              ║
╠════════════════════════════════════════════════════════════════════╣
║ TASKS                                                               ║
║ ┌──────────┬───────┐                                               ║
║ │ Pending  │    12 │                                               ║
║ │ Progress │     1 │ ◀── current                                   ║
║ │ Review   │     0 │                                               ║
║ │ Complete │    45 │                                               ║
║ │ Disputed │     2 │                                               ║
║ │ Failed   │     0 │                                               ║
║ └──────────┴───────┘                                               ║
╠════════════════════════════════════════════════════════════════════╣
║ RECENT LOGS                                                         ║
║ [14:32:01] CODER: Reading specification file...                     ║
║ [14:32:05] CODER: Implementing feature...                           ║
║ [14:32:12] CODER: Running npm run build...                          ║
║ [14:32:15] CODER: Build passed ✓                                    ║
║ [14:32:16] CODER: Running npm test...                               ║
║ [14:32:20] CODER: Tests passed ✓                                    ║
║ [14:32:21] CODER: Committing changes...                             ║
╠════════════════════════════════════════════════════════════════════╣
║ [q] Quit  [p] Pause  [r] Refresh  [l] Toggle logs  [t] Task detail  ║
╚════════════════════════════════════════════════════════════════════╝
```

## Compact Mode

```bash
steroids watch --compact
```

Single-line output suitable for status bars or tmux:

```
[ACTIVE] Task: a1b2c3d4 (CODER 2/15) | P:12 I:1 R:0 C:45 | 2h15m
```

Format: `[STATUS] Task: ID (PHASE ATTEMPT) | P:pending I:in_progress R:review C:completed | UPTIME`

## JSON Stream Mode

```bash
steroids watch --json
```

Outputs newline-delimited JSON for each refresh:

```json
{"timestamp":"2024-01-15T14:32:21Z","runner":{"active":true,"pid":12345,"uptime":8100},"task":{"id":"a1b2c3d4","title":"Implement user auth","status":"in_progress","phase":"coder","attempt":2},"counts":{"pending":12,"in_progress":1,"review":0,"completed":45,"disputed":2,"failed":0},"lastLog":"CODER: Committing changes..."}
```

## Keyboard Controls

| Key | Action |
|-----|--------|
| `q` | Quit watch mode |
| `p` | Pause/resume refresh |
| `r` | Force refresh now |
| `l` | Toggle log panel visibility |
| `t` | Show detailed task info |
| `↑/↓` | Scroll log history |

## Data Sources

The watch command aggregates data from:

1. **Runner Status** - `~/.steroids/steroids.db` runners table
2. **Task Counts** - Project `.steroids/steroids.db` tasks table
3. **Current Task** - Task with `in_progress` or `review` status
4. **Log Output** - `.steroids/logs/` directory, latest file

## Implementation Notes

### Refresh Logic

1. Query runner status from global DB
2. Query task counts from project DB
3. Find current active task
4. Tail last N lines from current log file
5. Render display
6. Sleep for refresh interval
7. Repeat

### Terminal Handling

- Use raw mode for keyboard input
- Handle terminal resize (SIGWINCH)
- Restore terminal state on exit
- Support both TTY and non-TTY (--json mode)

### Performance

- Cache DB connections (don't reopen each refresh)
- Only re-render changed sections
- Limit log tail to last 20 lines
- Use efficient terminal escape sequences

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Normal exit (user quit) |
| 1 | Error (no project, DB error) |

## Examples

```bash
# Basic watch
steroids watch

# Faster refresh (500ms)
steroids watch --refresh 500

# Compact for tmux status
steroids watch --compact

# JSON for external tools
steroids watch --json | jq '.task.status'

# No logs, just status
steroids watch --no-logs
```

## Related Commands

- `steroids runners status` - One-time runner check
- `steroids tasks list` - Full task listing
- `steroids logs tail --follow` - Log-only streaming
- `steroids health --watch` - Health monitoring
