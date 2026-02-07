# WebUI Development Tasks

## Current Stage: Local-Only MVP

Build the core WebUI functionality for local development use.

---

## Future Stage: GitHub OAuth Authentication

### Overview

Add GitHub OAuth to gate WebUI access based on repository permissions. Users can only see projects they have access to on GitHub.

### Requirements

- [ ] GitHub OAuth login flow
- [ ] Store GitHub access token securely (encrypted in DB or session)
- [ ] On project scan, check if project has `.git` with GitHub remote
- [ ] Query GitHub API to verify user has read access to repo
- [ ] Filter project list based on accessible repos
- [ ] Cache permission checks (refresh on login, expire after 1 hour)
- [ ] Handle users with no GitHub repos (show only local non-git projects)
- [ ] Logout / token revocation

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        WebUI with Auth                            │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│   Browser ──▶ /login ──▶ GitHub OAuth ──▶ Callback ──▶ Session   │
│                                                                   │
│   ┌─────────────────────────────────────────────────────────────┐│
│   │                      API Request Flow                        ││
│   │                                                              ││
│   │   GET /api/projects                                          ││
│   │         │                                                    ││
│   │         ▼                                                    ││
│   │   ┌─────────────┐    ┌──────────────┐    ┌───────────────┐  ││
│   │   │ Auth Check  │───▶│ Get GitHub   │───▶│ Filter by     │  ││
│   │   │ (session)   │    │ Accessible   │    │ Repo Access   │  ││
│   │   └─────────────┘    │ Repos (API)  │    └───────────────┘  ││
│   │                      └──────────────┘            │           ││
│   │                                                  ▼           ││
│   │                                        Return filtered list  ││
│   └─────────────────────────────────────────────────────────────┘│
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### Implementation Details

#### 1. GitHub OAuth Setup

```typescript
// config/auth.ts
interface GitHubOAuthConfig {
  clientId: string;      // From GitHub Developer Settings
  clientSecret: string;  // From GitHub Developer Settings
  callbackUrl: string;   // e.g., http://localhost:3000/auth/callback
  scopes: string[];      // ['read:user', 'repo']
}
```

#### 2. OAuth Flow

```typescript
// routes/auth/github.ts

// Step 1: Redirect to GitHub
GET /auth/github
  → Redirect to https://github.com/login/oauth/authorize
    ?client_id=XXX
    &redirect_uri=http://localhost:3000/auth/callback
    &scope=read:user,repo

// Step 2: Handle callback
GET /auth/callback?code=XXX
  → Exchange code for access token
  → Fetch user info (GET https://api.github.com/user)
  → Create session
  → Redirect to dashboard

// Step 3: Logout
POST /auth/logout
  → Destroy session
  → Redirect to login
```

#### 3. Permission Checking

```typescript
// services/GitHubPermissionService.ts
export class GitHubPermissionService {
  constructor(private readonly octokit: Octokit) {}

  async getAccessibleRepos(userId: string): Promise<string[]> {
    // Fetch all repos user has access to
    const repos = await this.octokit.paginate(
      this.octokit.repos.listForAuthenticatedUser,
      { per_page: 100 }
    );

    return repos.map(r => r.full_name); // ['owner/repo', ...]
  }

  async canAccessRepo(repoFullName: string): Promise<boolean> {
    try {
      await this.octokit.repos.get({
        owner: repoFullName.split('/')[0],
        repo: repoFullName.split('/')[1],
      });
      return true;
    } catch (e) {
      return false; // 404 = no access
    }
  }
}
```

#### 4. Project Filtering

```typescript
// services/ProjectFilterService.ts
export class ProjectFilterService {
  async filterByGitHubAccess(
    projects: Project[],
    accessibleRepos: string[]
  ): Promise<Project[]> {
    return projects.filter(project => {
      // Get GitHub remote from project
      const remote = this.getGitHubRemote(project.path);

      if (!remote) {
        // Non-GitHub project - show only if configured to
        return config.showNonGitHubProjects;
      }

      return accessibleRepos.includes(remote);
    });
  }

  private getGitHubRemote(projectPath: string): string | null {
    // Parse .git/config or run git remote -v
    // Extract github.com/owner/repo
  }
}
```

#### 5. Session Storage

```typescript
// For local: in-memory or file-based
// For team: Redis or file-based

interface UserSession {
  id: string;
  gitHubUserId: string;
  gitHubUsername: string;
  accessToken: string;  // Encrypted
  accessibleRepos: string[];  // Cached
  reposCachedAt: Date;
  expiresAt: Date;
}
```

### Environment Variables (Future)

```bash
# GitHub OAuth (required for team mode)
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
GITHUB_CALLBACK_URL=http://localhost:3000/auth/callback

# Session
SESSION_SECRET=<generate-with-openssl-rand-hex-32>

# Optional: Redis for sessions in team mode
REDIS_URL=redis://localhost:6379
```

### UI Changes

- [ ] Login page with "Sign in with GitHub" button
- [ ] User avatar in header (from GitHub)
- [ ] Logout button
- [ ] "Private" badge on projects
- [ ] Empty state: "No accessible projects" with explanation

### Security Considerations

- Store access tokens encrypted at rest
- Use secure, httpOnly cookies for sessions
- Validate GitHub webhook signatures (if adding webhooks)
- Rate limit GitHub API calls (5000/hour authenticated)
- Handle token expiration gracefully

### Testing

- [ ] Mock GitHub OAuth in tests
- [ ] Test permission filtering logic
- [ ] Test session expiration
- [ ] E2E test for login flow
