# Section Priorities & Dependencies

## Overview
Allow sections to have priorities and dependencies on other sections.

## Database Schema

### Migration: Add priority to sections
```sql
ALTER TABLE sections ADD COLUMN priority INTEGER DEFAULT 50;
-- Priority 0 = highest, 100 = lowest, 50 = default
```

### Migration: Add section_dependencies table
```sql
CREATE TABLE section_dependencies (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES sections(id),
  depends_on_section_id TEXT NOT NULL REFERENCES sections(id),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(section_id, depends_on_section_id)
);
```

## CLI Commands

### Set priority
```bash
steroids sections priority <section-id> <priority>
steroids sections priority <section-id> high    # Sets to 10
steroids sections priority <section-id> medium  # Sets to 50
steroids sections priority <section-id> low     # Sets to 90
steroids sections priority <section-id> 25      # Sets to 25
```

### Add dependency
```bash
steroids sections depends-on <section-id> <depends-on-section-id>
# Example: Phase 0.8 depends on Phase 0.7
steroids sections depends-on 52379b10 e01c44f6
```

### Remove dependency
```bash
steroids sections no-depends-on <section-id> <depends-on-section-id>
```

### View dependency graph
```bash
steroids sections graph
# Output:
# Phase 0.4: Global Runner Registry (priority: 10) [IN PROGRESS]
#   └─> Phase 0.7: Section Focus (priority: 20)
#       └─> Phase 0.8: Priorities & Dependencies (priority: 30)
# Phase 2: Configuration (priority: 50) [BLOCKED by Phase 0.5]
#   └─> Phase 3: Hooks System
```

### List with dependencies
```bash
steroids sections list --deps
# Shows dependencies inline
```

## Task Selection Changes

1. Order sections by: unmet dependencies (blocked last), then priority, then position
2. Skip sections where any dependency has incomplete tasks
3. Show [BLOCKED] indicator in section list

## Graph Output

### Default: ASCII art
```bash
steroids sections graph
# Outputs ASCII dependency tree to stdout
```

### Mermaid syntax (for markdown/docs)
```bash
steroids sections graph --mermaid
# Outputs Mermaid flowchart syntax to stdout:
# graph TD
#     A[Phase 0.4] --> B[Phase 0.7]
#     B --> C[Phase 0.8]
```

### Image output (PNG/SVG)
```bash
steroids sections graph --output png
steroids sections graph --output svg
steroids sections graph --output png -o   # Generate AND open the file
# Generates image file and outputs absolute path:
# /tmp/steroids-sections-graph-1707412345.png
```

**Open flag (-o, --open):**
- After generating, automatically open the file
- macOS: `open <filepath>`
- Linux: `xdg-open <filepath>`
- Windows: `start <filepath>`

**Implementation:**
1. Check if `mmdc` (Mermaid CLI) is installed: `which mmdc`
2. If not installed, prompt user:
   ```
   Mermaid CLI not found. Install it to generate images.
   Run: npm install -g @mermaid-js/mermaid-cli
   Install now? [y/N]
   ```
3. If user confirms, run `npm install -g @mermaid-js/mermaid-cli`
4. Generate Mermaid syntax to temp file: `os.tmpdir()/steroids-graph-{timestamp}.mmd`
5. Run: `mmdc -i {input.mmd} -o {output.png} -b transparent`
6. Output absolute path to generated file
7. Clean up the .mmd input file

**File locations:**
- Use `os.tmpdir()` for cross-platform temp directory
- macOS: `/var/folders/.../T/` or `/tmp/`
- Linux: `/tmp/`
- Windows: `%TEMP%`
- Filename: `steroids-sections-graph-{timestamp}.{png|svg}`

---

## Task Graph Visualization

The graph command should also support showing tasks within sections.

### Section-only view (default)
```bash
steroids sections graph
# Shows only sections and their dependencies
```

### Full view with tasks
```bash
steroids sections graph --tasks
steroids sections graph --tasks --output png -o
```

**Output includes:**
- Sections as containers/subgraphs
- Tasks within each section
- Task status indicated by color/style:
  - `[ ]` pending - gray
  - `[-]` in_progress - blue  
  - `[o]` review - yellow
  - `[x]` completed - green
  - `[!]` disputed - orange
  - `[F]` failed - red
- Dependencies between sections shown as arrows
- Rejection count shown for tasks with rejections

### Mermaid with tasks
```mermaid
graph TD
    subgraph A[Phase 0.4: Global Runner Registry]
        A1[✓ Add projects table]
        A2[✓ Create projects.ts]
        A3[● Add selector dropdown]
        A4[ ] Update docker-compose
    end
    subgraph B[Phase 0.7: Section Focus]
        B1[ ] Add --section flag
        B2[ ] Update queries
    end
    A --> B
```

### Filter options
```bash
steroids sections graph --tasks --status active    # Only show in_progress/review
steroids sections graph --tasks --status pending   # Only show pending
steroids sections graph --section <id>             # Only show one section
```
