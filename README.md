# Steroids

**A developer command center for managing multiple software projects with confidence.**

Steroids is a development tool for power developers who refuse to let their projects become unmaintainable slop. It provides a unified dashboard and CLI for tracking tasks, monitoring health, and maintaining architectural integrity across your entire portfolio of projects.

Built for developers who believe in:
- **Testable code** over "it works on my machine"
- **Clean architecture** over vibe coding
- **Maintainable structures** over quick hacks
- **Developer experience** over feature bloat

---

## The Suite

### Steroids CLI

The main task management CLI. Tracks tasks across projects, coordinates LLM agents with locking, and triggers scripts/webhooks on completion events. File-based storage, no database required.

### Pump

Data gathering CLI using Google APIs (Gemini, Search). Grounds LLM responses with real-time data and reduces costs by preprocessing with cheaper APIs before expensive model calls.

### Iron

Documentation scaffolding wizard. Interactive CLI that guides you through setting up CLAUDE.md, AGENTS.md, README templates, and architecture decision records for new projects.

### WebUI

Visual dashboard for monitoring projects, tasks, and runner status. Browse configs, view audit trails, and manage hooks through a web interface.

---

## Installation

```bash
# Clone the repository
git clone https://github.com/unlikeother/steroids.git
cd steroids

# Install dependencies
pnpm install

# Start development
pnpm dev
```

### Prerequisites

- Node.js 20 LTS or higher
- pnpm 9+
- Git 2.40+

### Quick Start

```bash
# Initialize Steroids in your projects directory
steroids init

# Scan for projects
steroids scan ~/Projects

# View all tasks across projects
steroids tasks

# Check system health
steroids health

# Launch the web UI
steroids serve
```

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `steroids init` | Initialize Steroids with Git setup |
| `steroids scan [path]` | Scan directory for projects |
| `steroids tasks` | List tasks across all projects |
| `steroids tasks --project <name>` | List tasks for specific project |
| `steroids tasks update <id>` | Update task status |
| `steroids health` | Show system health overview |
| `steroids config init` | Initialize configuration file |
| `steroids config show` | Display current configuration |
| `steroids serve` | Launch WebUI server |

### Examples

```bash
# Scan with JSON output
steroids scan ~/Projects --json

# Filter tasks by status
steroids tasks --status pending

# Verbose health check
steroids health --verbose

# Serve on custom port
steroids serve --port 8080
```

---

## Web UI

The Steroids WebUI provides a visual dashboard for managing your projects:

### Features

- **Dashboard** - Overview of all projects with health scores
- **Project Grid** - Visual cards with status indicators
- **Task Management** - Cross-project task view with inline editing
- **Health Monitoring** - Real-time project health metrics
- **Activity Feed** - Recent commits, deploys, and task updates
- **AGENTS.md Viewer** - View project guidelines directly
- **Dark Mode** - Full light/dark theme support
- **Keyboard Shortcuts** - `⌘K` command palette, vim-style navigation

### Access

```bash
# Start the server
steroids serve

# Open in browser
open http://localhost:3000
```

---

## Configuration

Steroids uses a YAML configuration file:

```yaml
# ~/.steroids/config.yaml

projects:
  basePath: ~/Projects          # Root directory to scan
  scanInterval: 5m              # How often to rescan
  ignored:                      # Directories to skip
    - node_modules
    - .git
    - dist
    - build

output:
  format: table                 # table | json
  colors: true                  # Enable colored output
  verbose: false                # Show detailed output

webui:
  port: 3000                    # Server port
  host: localhost               # Server host
```

### Environment Variables

Steroids CLI supports environment variables for configuration. See [Environment Variables Documentation](./Docs/ENVIRONMENT_VARIABLES.md) for complete details.

```bash
# Output control
STEROIDS_JSON=1                 # Output as JSON
STEROIDS_QUIET=1                # Minimal output
STEROIDS_VERBOSE=1              # Detailed output
STEROIDS_NO_COLOR=1             # Disable colors
NO_COLOR=1                      # Standard no-color flag

# Configuration
STEROIDS_CONFIG=/path/to/config.yaml
STEROIDS_TIMEOUT=30s            # Command timeout

# Behavior
STEROIDS_NO_HOOKS=1             # Skip hook execution
STEROIDS_AUTO_MIGRATE=1         # Auto-apply migrations

# Automatically detected
CI=1                            # CI environment (set by CI systems)
```

---

## Development

### Setup

```bash
# Clone and install
git clone https://github.com/unlikeother/steroids.git
cd steroids
pnpm install

# Start development (all services)
pnpm dev

# Or start individual services
pnpm dev:web      # Web frontend only
pnpm dev:cli      # CLI in watch mode
```

### Testing

```bash
# Run all tests
pnpm test

# Run with coverage
pnpm test:coverage

# Run E2E tests
pnpm test:e2e

# Run specific test file
pnpm test src/domain/entities/Project.test.ts
```

### Building

```bash
# Build all packages
pnpm build

# Lint code
pnpm lint

# Type check
pnpm typecheck
```

---

## Architecture

Steroids follows clean architecture principles with clear separation between:

- **Domain Layer** - Business entities and logic
- **Application Layer** - Use cases and orchestration
- **Infrastructure Layer** - External integrations
- **Presentation Layer** - UI and API routes

### Documentation

- [CLAUDE.md](./CLAUDE.md) - Global coding standards
- [CLI Architecture](./CLI/ARCHITECTURE.md) - Command-line architecture
- [Environment Variables](./Docs/ENVIRONMENT_VARIABLES.md) - Environment variable reference
- [Pump](./Pump/README.md) - Data gathering CLI
- [Iron](./Iron/README.md) - Documentation scaffolding CLI
- [WebUI Architecture](./WebUI/ARCHITECTURE.md) - Dashboard architecture
- [Code Quality](./Docs/CODE_QUALITY.md) - The 50 rules
- [Security](./Docs/SECURITY.md) - Security practices
- [Deployment](./Docs/DEPLOYMENT.md) - Deployment guide
- [Testing](./Docs/TESTING.md) - Testing guide
- [Contributing](./Docs/CONTRIBUTING.md) - Contribution guidelines

---

## Contributing

We welcome contributions that improve code quality and developer experience.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

See [CONTRIBUTING.md](./Docs/CONTRIBUTING.md) for detailed guidelines.

---

## License

MIT License - see [LICENSE](./LICENSE) for details.

---

## Credits

Created by [UnlikeOther.ai](https://unlikeother.ai)

**Author:** Ondrej Rafaj ([@rafiki270](https://github.com/rafiki270))

---

<p align="center">
  <em>Made with love in Scotland.</em>
</p>
