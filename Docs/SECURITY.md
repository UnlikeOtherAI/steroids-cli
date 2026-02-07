# Security Guide

## Current Status: Local-Only Tool

Steroids is currently designed as a **local development tool** running on `localhost`. There is no authentication or network exposure by default.

```
┌─────────────────────────────────────────┐
│           Your Machine                   │
│                                          │
│   CLI ──▶ localhost:3000 ──▶ WebUI      │
│              │                           │
│              ▼                           │
│         .steroids/                      │
│        (file storage)                    │
│                                          │
└─────────────────────────────────────────┘
        No external access
```

### Security Model (v1)

- **No authentication** - You're on your own machine
- **No HTTPS** - localhost doesn't need it
- **No CORS restrictions** - Same-origin only
- **Filesystem access** - Limited to configured `basePath`

---

## Secure Coding Practices

Even for local tools, follow these practices:

### Path Traversal Prevention

```typescript
import path from 'path';

function isPathSafe(basePath: string, requestedPath: string): boolean {
  const resolved = path.resolve(basePath, requestedPath);
  return resolved.startsWith(path.resolve(basePath));
}
```

### Input Validation

```typescript
import { z } from 'zod';

const projectPathSchema = z.string()
  .min(1)
  .max(4096)
  .refine(path => !path.includes('..'), 'Path traversal not allowed');
```

### No Command Injection

```typescript
// NEVER interpolate user input into shell commands
// Use array arguments instead
import { execa } from 'execa';
await execa('git', ['clone', userUrl]);  // Safe
```

---

## Environment Variables

```bash
# .env (never commit)
SESSION_SECRET=your-secret-key

# .env.example (commit this)
SESSION_SECRET=<generate-with-openssl-rand-hex-32>
```

---

## Future: Team Mode with GitHub OAuth

> **Status:** Planned for future release

When Steroids supports team deployment, authentication will gate access based on GitHub repository permissions.

See [WebUI TODO: GitHub OAuth Authentication](#github-oauth-task) for implementation details.
