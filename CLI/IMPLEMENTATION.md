# CLI Implementation Guide

> Reference implementations for CLI components.
> For architecture overview, see [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## Prerequisites Checker

```typescript
// infrastructure/git/PrerequisitesChecker.ts
export interface PrerequisiteResult {
  gitInstalled: boolean;
  gitVersion: string | null;
  isGitRepo: boolean;
  hasRemote: boolean;
  remoteUrl: string | null;
  isAuthenticated: boolean;
  authMethod: 'ssh' | 'https' | null;
}

export class PrerequisitesChecker {
  async check(path: string): Promise<PrerequisiteResult> {
    const gitInstalled = await this.checkGitInstalled();
    if (!gitInstalled) {
      return {
        gitInstalled: false, gitVersion: null, isGitRepo: false,
        hasRemote: false, remoteUrl: null, isAuthenticated: false, authMethod: null,
      };
    }
    const gitVersion = await this.getGitVersion();
    const isGitRepo = await this.isGitRepository(path);
    const hasRemote = isGitRepo ? await this.hasRemoteOrigin(path) : false;
    const remoteUrl = hasRemote ? await this.getRemoteUrl(path) : null;
    const isAuthenticated = await this.checkAuthentication();
    const authMethod = isAuthenticated ? await this.detectAuthMethod() : null;
    return { gitInstalled, gitVersion, isGitRepo, hasRemote, remoteUrl, isAuthenticated, authMethod };
  }

  private async checkGitInstalled(): Promise<boolean> {
    try { await execAsync('git --version'); return true; } catch { return false; }
  }
  private async getGitVersion(): Promise<string> {
    const { stdout } = await execAsync('git --version');
    return stdout.trim().replace('git version ', '');
  }
  private async isGitRepository(path: string): Promise<boolean> {
    try { await execAsync('git rev-parse --git-dir', { cwd: path }); return true; } catch { return false; }
  }
  private async hasRemoteOrigin(path: string): Promise<boolean> {
    try { await execAsync('git remote get-url origin', { cwd: path }); return true; } catch { return false; }
  }
  private async getRemoteUrl(path: string): Promise<string> {
    const { stdout } = await execAsync('git remote get-url origin', { cwd: path });
    return stdout.trim();
  }
  private async checkAuthentication(): Promise<boolean> {
    try { await execAsync('ssh -T git@github.com 2>&1 || true'); return true; }
    catch {
      try {
        const { stdout } = await execAsync('git credential-manager get 2>&1 || true');
        return stdout.includes('username');
      } catch { return false; }
    }
  }
  private async detectAuthMethod(): Promise<'ssh' | 'https'> {
    try {
      const { stdout } = await execAsync('ssh -T git@github.com 2>&1 || true');
      if (stdout.includes('successfully authenticated')) return 'ssh';
    } catch {}
    return 'https';
  }
}
```

---

## Git Setup Service

```typescript
// infrastructure/git/GitSetupService.ts
export interface SetupOptions {
  provider: 'github' | 'gitlab';
  repoName: string;
  visibility: 'public' | 'private';
  description?: string;
}

export class GitSetupService {
  async initializeRepo(path: string): Promise<void> {
    await execAsync('git init', { cwd: path });
    await execAsync('git branch -M main', { cwd: path });
  }

  async createRemoteRepo(options: SetupOptions): Promise<string> {
    return options.provider === 'github'
      ? this.createGitHubRepo(options)
      : this.createGitLabRepo(options);
  }

  private async createGitHubRepo(options: SetupOptions): Promise<string> {
    const visibility = options.visibility === 'public' ? '--public' : '--private';
    const description = options.description ? `--description "${options.description}"` : '';
    const { stdout } = await execAsync(
      `gh repo create ${options.repoName} ${visibility} ${description} --source=. --remote=origin --push`
    );
    const match = stdout.match(/https:\/\/github\.com\/[\w-]+\/[\w-]+/);
    return match ? match[0] : '';
  }

  private async createGitLabRepo(options: SetupOptions): Promise<string> {
    const visibility = options.visibility === 'public' ? '--public' : '--private';
    const { stdout } = await execAsync(`glab repo create ${options.repoName} ${visibility}`);
    const match = stdout.match(/https:\/\/gitlab\.com\/[\w-]+\/[\w-]+/);
    return match ? match[0] : '';
  }

  async linkRemote(path: string, url: string): Promise<void> {
    await execAsync(`git remote add origin ${url}`, { cwd: path });
  }

  async pushInitial(path: string): Promise<void> {
    await execAsync('git push -u origin main', { cwd: path });
  }
}
```

---

## Output Formatting

### Table Formatter

```typescript
// cli/output/TableFormatter.ts
import Table from 'cli-table3';
import chalk from 'chalk';

export class TableFormatter {
  static printProjects(projects: ProjectDTO[], verbose: boolean): void {
    const table = new Table({
      head: [chalk.bold('Name'), chalk.bold('Status'), chalk.bold('Tasks'), chalk.bold('Health')],
    });
    for (const project of projects) {
      table.push([
        project.name,
        this.formatStatus(project.status),
        project.taskCount.toString(),
        this.formatHealth(project.healthScore),
      ]);
    }
    console.log(table.toString());
  }

  private static formatStatus(status: string): string {
    switch (status) {
      case 'active': return chalk.green('● Active');
      case 'maintenance': return chalk.yellow('○ Maintenance');
      case 'archived': return chalk.gray('○ Archived');
      default: return status;
    }
  }

  private static formatHealth(score: number | null): string {
    if (score === null) return chalk.gray('—');
    if (score >= 80) return chalk.green(`${score}%`);
    if (score >= 50) return chalk.yellow(`${score}%`);
    return chalk.red(`${score}%`);
  }
}
```

### JSON Formatter

```typescript
// cli/output/JsonFormatter.ts
export class JsonFormatter {
  static print(data: unknown, pretty = true): void {
    console.log(pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  }
}
```

---

## File Parsers

### TODO Parser

```typescript
// infrastructure/filesystem/TodoFileParser.ts
const CHECKBOX_REGEX = /^(\s*)-\s*\[([ xX-])\]\s*(.+)$/;

export class TodoFileParser {
  static parse(content: string, filePath: string): ParsedTask[] {
    const tasks: ParsedTask[] = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(CHECKBOX_REGEX);
      if (match) {
        tasks.push({
          title: match[3].trim(),
          status: this.parseCheckbox(match[2]),
          filePath,
          lineNumber: i + 1,
          indent: match[1].length,
        });
      }
    }
    return tasks;
  }

  private static parseCheckbox(char: string): TaskStatus {
    switch (char.toLowerCase()) {
      case 'x': return 'completed';
      case '-': return 'in_progress';
      default: return 'pending';
    }
  }
}
```

### AGENTS.md Parser

```typescript
// infrastructure/filesystem/AgentsFileParser.ts
export class AgentsFileParser {
  static parse(content: string): AgentsMetadata {
    const sections = this.extractSections(content);
    return {
      projectName: this.extractTitle(content),
      guidelines: this.extractList(sections['guidelines'] ?? ''),
      constraints: this.extractList(sections['constraints'] ?? ''),
      sourceOfTruth: this.extractList(sections['source of truth'] ?? ''),
    };
  }

  private static extractSections(content: string): Record<string, string> {
    const sections: Record<string, string> = {};
    const headingRegex = /^##\s+(.+)$/gm;
    // Implementation...
    return sections;
  }
}
```

---

## Git Integration

```typescript
// infrastructure/git/GitClient.ts
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class GitClient {
  constructor(private readonly repoPath: string) {}

  async getLastCommitDate(): Promise<Date | null> {
    try {
      const { stdout } = await execAsync('git log -1 --format=%ai', { cwd: this.repoPath });
      return new Date(stdout.trim());
    } catch { return null; }
  }

  async getRecentCommits(limit = 10): Promise<GitCommit[]> {
    const { stdout } = await execAsync(
      `git log --oneline --format="%H|%s|%ai" -n ${limit}`,
      { cwd: this.repoPath }
    );
    return stdout.split('\n').filter(Boolean).map(line => {
      const [hash, message, date] = line.split('|');
      return { hash, message, date: new Date(date) };
    });
  }

  async isClean(): Promise<boolean> {
    const { stdout } = await execAsync('git status --porcelain', { cwd: this.repoPath });
    return stdout.trim() === '';
  }
}
```

---

## Configuration Loading

```typescript
// infrastructure/config/ConfigLoader.ts
import { cosmiconfig } from 'cosmiconfig';

export class ConfigLoader {
  private static explorer = cosmiconfig('steroids');

  static async load(): Promise<SteroidsConfig> {
    const result = await this.explorer.search();
    if (!result) return this.getDefaults();
    return this.merge(this.getDefaults(), result.config);
  }

  private static getDefaults(): SteroidsConfig {
    return {
      projects: {
        basePath: process.env.HOME + '/Projects',
        scanInterval: '5m',
        ignored: ['node_modules', '.git', 'dist'],
      },
      output: { format: 'table', colors: true, verbose: false },
      webui: { port: 3000, host: 'localhost' },
    };
  }
}
```

---

## Error Handling

```typescript
// cli/commands/base.ts
export function withErrorHandling<T extends (...args: any[]) => Promise<void>>(action: T): T {
  return (async (...args: Parameters<T>) => {
    try {
      await action(...args);
    } catch (error) {
      if (error instanceof UserFacingError) {
        console.error(chalk.red(`Error: ${error.message}`));
        if (error.suggestion) {
          console.error(chalk.yellow(`Suggestion: ${error.suggestion}`));
        }
        process.exit(1);
      }
      console.error(chalk.red('Unexpected error occurred'));
      console.error(error);
      process.exit(1);
    }
  }) as T;
}
```

---

## Testing Examples

### Unit Test

```typescript
// tests/unit/infrastructure/TodoFileParser.test.ts
describe('TodoFileParser', () => {
  it('parses pending tasks', () => {
    const content = '- [ ] Do something';
    const tasks = TodoFileParser.parse(content, 'test.md');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('pending');
    expect(tasks[0].title).toBe('Do something');
  });

  it('parses completed tasks', () => {
    const content = '- [x] Done task';
    const tasks = TodoFileParser.parse(content, 'test.md');
    expect(tasks[0].status).toBe('completed');
  });

  it('tracks line numbers', () => {
    const content = 'Header\n\n- [ ] First\n- [ ] Second';
    const tasks = TodoFileParser.parse(content, 'test.md');
    expect(tasks[0].lineNumber).toBe(3);
    expect(tasks[1].lineNumber).toBe(4);
  });
});
```

### Integration Test

```typescript
// tests/integration/scan.test.ts
describe('ScanProjectsUseCase', () => {
  it('discovers projects with package.json', async () => {
    const container = createTestContainer();
    const useCase = container.get<ScanProjectsUseCase>(Tokens.ScanProjectsUseCase);
    const result = await useCase.execute({ path: '/path/to/test/projects' });
    expect(result.projects.length).toBeGreaterThan(0);
    expect(result.projects.every(p => p.path)).toBe(true);
  });
});
```

---

## Error Messages

| Scenario | Message |
|----------|---------|
| Git not installed | `Git is not installed. Steroids requires Git to function. Install Git: https://git-scm.com/downloads` |
| gh CLI not installed | `GitHub CLI (gh) is not installed. Install it: https://cli.github.com/` |
| glab CLI not installed | `GitLab CLI (glab) is not installed. Install it: https://gitlab.com/gitlab-org/cli` |
| Auth failed | `Git authentication failed. Run 'gh auth login' or configure SSH keys.` |
| Repo creation failed | `Failed to create repository. Check your permissions and try again.` |
