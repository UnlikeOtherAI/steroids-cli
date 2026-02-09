# Monitor - Mac Menu Bar App

A native macOS menu bar application for monitoring Steroids runners across multiple projects.

## Overview

Monitor is a lightweight Swift app that lives in the menu bar (not the dock). It provides a quick overview of all active runners across all your Steroids projects, showing what tasks are being processed and surfacing logs when needed.

## Design Goals

1. **Zero infrastructure** - No API server, no background services
2. **Multi-project** - Monitor runners from projects anywhere on your filesystem
3. **Lightweight** - Minimal CPU/memory, only updates when things change
4. **Developer-focused** - Quick glance to see what's happening

## Visual Design

```
┌─────────────────────────────────────────────┐
│  ● (green/yellow/red status indicator)      │  ← Menu bar icon
└─────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────┐
│  STEROIDS MONITOR                           │
├─────────────────────────────────────────────┤
│  📁 steroids-cli                            │
│     ├─ 🟢 runner-1: Task #42 "Add auth..."  │  ← Hover for details
│     ├─ 🟡 runner-2: Reviewing...            │
│     └─ ⚫ runner-3: Idle                     │
├─────────────────────────────────────────────┤
│  📁 my-saas-project                         │
│     ├─ 🟢 coder: Task #7 "Fix bug..."       │
│     └─ 🔴 reviewer: Error (hover for logs)  │
├─────────────────────────────────────────────┤
│  + Add Project...                           │
├─────────────────────────────────────────────┤
│  ⚙ Preferences                              │
│  Quit Monitor                               │
└─────────────────────────────────────────────┘
```

### Hover States

**Hovering over a runner** shows a popover with:
```
┌─────────────────────────────────────────────┐
│  Runner: coder-1                            │
│  Status: Active                             │
│  ─────────────────────────────────────────  │
│  Current Task: #42                          │
│  "Implement user authentication flow"       │
│  ─────────────────────────────────────────  │
│  Started: 2 minutes ago                     │
│  Attempts: 1                                │
└─────────────────────────────────────────────┘
```

**Hovering over an error state** shows recent logs:
```
┌─────────────────────────────────────────────┐
│  Runner: reviewer-1                         │
│  Status: Error                              │
│  ─────────────────────────────────────────  │
│  Last 5 log entries:                        │
│  [ERROR] Failed to connect to Claude API    │
│  [ERROR] Retrying in 30s...                 │
│  [WARN] Rate limit approaching              │
│  ...                                        │
│  ─────────────────────────────────────────  │
│  ▶ View Full Logs                           │
└─────────────────────────────────────────────┘
```

## Data Access Strategy

### Option A: Direct SQLite (Recommended)

Read directly from each project's `.steroids/steroids.db`:

```
~/.steroids/
└── monitor.json          # List of project paths to monitor

/path/to/project-1/
└── .steroids/
    └── steroids.db       # SQLite database

/path/to/project-2/
└── .steroids/
    └── steroids.db
```

**Pros:**
- No process spawning overhead
- Real-time data access
- Efficient for frequent polling

**Cons:**
- Coupled to database schema
- Need to handle schema migrations

**Mitigation:** Read a `schema_version` from the database and gracefully degrade if unknown.

### Option B: CLI with JSON Output

Shell out to the CLI with a `--json` flag:

```bash
cd /path/to/project && steroids runners list --json
cd /path/to/project && steroids logs list --json --limit 5
```

**Pros:**
- CLI handles all logic and schema changes
- Stable contract via JSON output

**Cons:**
- Process spawning is expensive for frequent updates
- Slower response times

### Recommendation: Hybrid Approach

1. **Use SQLite directly** for frequent reads (runner status, current task)
2. **Use CLI** for complex operations (adding projects, viewing full logs)
3. **Watch for changes** using FSEvents to avoid polling

```swift
// Efficient: Direct SQLite read
let runners = try SQLiteReader.runners(from: projectDB)

// Infrequent: CLI for complex operations
let fullLogs = try CLI.execute("logs list --json", in: projectPath)
```

## Architecture

### Technology Stack

- **Language:** Swift 5.9+
- **UI Framework:** SwiftUI + AppKit (for NSStatusItem)
- **Database:** SQLite.swift or GRDB.swift
- **File Watching:** FSEvents via DispatchSource

### Project Structure

```
Monitor/
├── ARCHITECTURE.md
├── Package.swift
├── Sources/
│   ├── App/
│   │   ├── MonitorApp.swift          # App entry point
│   │   └── AppDelegate.swift         # NSStatusItem setup
│   ├── Views/
│   │   ├── StatusBarMenu.swift       # Main dropdown menu
│   │   ├── ProjectSection.swift      # Project group in menu
│   │   ├── RunnerMenuItem.swift      # Individual runner row
│   │   ├── RunnerPopover.swift       # Hover detail view
│   │   └── PreferencesWindow.swift   # Settings window
│   ├── Models/
│   │   ├── Project.swift             # Project entity
│   │   ├── Runner.swift              # Runner entity
│   │   ├── Task.swift                # Task entity
│   │   └── LogEntry.swift            # Log entry entity
│   ├── Services/
│   │   ├── ProjectRegistry.swift     # Manages monitored projects
│   │   ├── DatabaseReader.swift      # SQLite access
│   │   ├── FileWatcher.swift         # FSEvents wrapper
│   │   └── CLIBridge.swift           # Shell out to steroids CLI
│   └── Utilities/
│       ├── StatusIcon.swift          # Dynamic icon generation
│       └── TimeFormatter.swift       # "2 minutes ago" etc.
└── Tests/
    └── ...
```

### Core Components

#### 1. ProjectRegistry

Manages the list of projects to monitor:

```swift
class ProjectRegistry: ObservableObject {
    @Published var projects: [MonitoredProject] = []

    private let configPath = "~/.steroids/monitor.json"

    func addProject(at path: URL) throws
    func removeProject(_ project: MonitoredProject)
    func refresh()
}

struct MonitoredProject: Identifiable {
    let id: UUID
    let path: URL
    let name: String
    var runners: [Runner]
    var lastUpdated: Date
}
```

#### 2. DatabaseReader

Reads runner/task/log data from SQLite:

```swift
class DatabaseReader {
    func runners(from dbPath: URL) throws -> [Runner]
    func currentTask(for runnerName: String, from dbPath: URL) throws -> Task?
    func recentLogs(for runnerName: String, limit: Int, from dbPath: URL) throws -> [LogEntry]
}
```

#### 3. FileWatcher

Watches `.steroids/` directories for changes:

```swift
class FileWatcher {
    func watch(directory: URL, onChange: @escaping () -> Void)
    func stopWatching(directory: URL)
}
```

Uses FSEvents to efficiently detect database changes without polling.

#### 4. StatusIconManager

Manages the menu bar icon state:

```swift
enum OverallStatus {
    case allGood      // 🟢 All runners idle or succeeding
    case working      // 🟡 At least one runner active
    case hasErrors    // 🔴 At least one runner in error state
    case noRunners    // ⚫ No runners configured
}

class StatusIconManager {
    func updateIcon(for status: OverallStatus)
}
```

## Configuration

### ~/.steroids/monitor.json

```json
{
  "version": 1,
  "projects": [
    {
      "path": "/Users/dev/projects/steroids-cli",
      "name": "steroids-cli",
      "enabled": true
    },
    {
      "path": "/Users/dev/projects/my-saas",
      "name": "My SaaS",
      "enabled": true
    }
  ],
  "preferences": {
    "refreshInterval": 5,
    "showIdleRunners": true,
    "notifyOnError": true,
    "launchAtLogin": false
  }
}
```

## Update Strategy

1. **On launch:** Read all project databases, populate initial state
2. **FSEvents trigger:** When any `.steroids/steroids.db` changes, re-read that project
3. **Fallback polling:** Every 30s, refresh all projects (handles edge cases)
4. **Manual refresh:** Cmd+R or menu option

## Menu Bar Icon States

| Icon | Meaning |
|------|---------|
| ● (green) | All runners idle or last task succeeded |
| ● (yellow) | At least one runner actively processing |
| ● (red) | At least one runner in error state |
| ○ (gray) | No projects configured or all disabled |

## Error Handling

- **Project not found:** Show grayed-out with "Project moved or deleted"
- **Database locked:** Retry with backoff, show "Database busy" if persistent
- **Schema mismatch:** Show "Update Steroids CLI" with version info
- **CLI not found:** Show "CLI not installed" with install instructions

## Future Enhancements

1. **Click to open project** - Open project folder in Finder or terminal
2. **Quick actions** - Pause/resume runners from menu
3. **Notifications** - Alert when task completes or errors
4. **History view** - Show recent completed tasks
5. **Multiple workspaces** - Group projects by workspace

## Build & Distribution

```bash
# Development
cd Monitor
swift build

# Release
swift build -c release

# Create .app bundle
# (Script to package as macOS app)
```

Distribute via:
- GitHub Releases (signed .dmg)
- Homebrew Cask (future)

## Implementation Order

1. **Phase 1: Basic menu**
   - NSStatusItem with static icon
   - Read single project from config
   - Display runners in menu

2. **Phase 2: Multi-project**
   - Project registry with add/remove
   - Grouped menu structure
   - Preferences window

3. **Phase 3: Live updates**
   - FSEvents file watching
   - Dynamic icon color
   - Hover popovers

4. **Phase 4: Polish**
   - Error handling
   - Notifications
   - Launch at login
