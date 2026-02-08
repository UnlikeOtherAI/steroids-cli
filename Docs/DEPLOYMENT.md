# Deployment Guide

> For global coding rules, see [CLAUDE.md](../CLAUDE.md)

## Overview

Steroids can be deployed as:
1. **Local CLI** - Installed globally via npm/pnpm
2. **Local WebUI** - Run alongside CLI for visual dashboard
3. **Team Server** - Shared WebUI instance for team visibility

---

## Prerequisites

- Node.js 20 LTS
- pnpm 9+
- Git 2.40+

---

## Local Installation

### CLI Only

```bash
# Install globally
pnpm add -g @steroids/cli

# Or via npm
npm install -g @steroids/cli

# Verify installation
steroids --version
```

### Full Stack (CLI + WebUI)

```bash
# Clone repository
git clone https://github.com/unlikeother/steroids.git
cd steroids

# Install dependencies
pnpm install

# Set up environment
cp .env.example .env

# Start development server
pnpm dev
```

---

## Environment Configuration

### Required Variables

```bash
# .env

# Server
PORT=3000
HOST=localhost
NODE_ENV=development  # development | production | test

# Session (required if auth enabled)
SESSION_SECRET=<generate-with-openssl-rand-hex-32>
```

### Optional Variables

```bash
# WebSocket (defaults to PORT + 1)
WS_PORT=3001

# Logging
LOG_LEVEL=info  # debug | info | warn | error

# Feature flags
ENABLE_AUTH=false
ENABLE_SSR=true

# Sentry (optional, for error tracking)
SENTRY_DSN=https://xxx@sentry.io/xxx
```

### Environment Validation

```typescript
// The app validates environment on startup
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('localhost'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SESSION_SECRET: z.string().min(32).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

// Fails fast if invalid
export const env = envSchema.parse(process.env);
```

---

## Build Process

### Development

```bash
# Start all services with hot reload
pnpm dev

# Start individual services
pnpm dev:api    # API server only
pnpm dev:web    # Web frontend only
pnpm dev:cli    # CLI in watch mode
```

### Production Build

```bash
# Build all packages
pnpm build

# Build outputs:
# - WebUI/packages/api/dist/     - Compiled API server
# - WebUI/packages/web/dist/     - SSR bundle + client assets
# - CLI/dist/                    - Compiled CLI
```

### Build Artifacts

```
dist/
├── api/
│   ├── main.js           # API entry point
│   └── ...
├── web/
│   ├── server/
│   │   └── entry-server.js
│   └── client/
│       ├── index.html
│       └── assets/
└── cli/
    └── main.js           # CLI entry point
```

---

## Local Development

### Running WebUI and API

From the project root:

```bash
# Using Makefile
make launch

# Or manually
cd API && npm start &
cd WebUI && npm run dev &
```

### Stopping Services

```bash
make stop-ui
```

### Access Points

- **WebUI**: http://localhost:3500
- **API**: http://localhost:3501

---

## Production Deployment

### Pre-deployment Checklist

- [ ] All tests pass (`pnpm test`)
- [ ] Build succeeds (`pnpm build`)
- [ ] Environment variables configured
- [ ] Secrets rotated from development values
- [ ] SSL/TLS configured
- [ ] Logging configured
- [ ] Health checks verified

### Health Check Endpoints

```typescript
// GET /health - Basic health
// Returns 200 if server is running
{
  "status": "ok",
  "timestamp": "2026-02-07T10:30:00Z"
}

// GET /health/ready - Readiness check
// Returns 200 if storage is accessible
{
  "status": "ready",
  "storage": "accessible",
  "timestamp": "2026-02-07T10:30:00Z"
}

// Returns 503 if not ready
{
  "status": "not_ready",
  "storage": "inaccessible",
  "error": "Cannot access .steroids directory"
}
```

### Reverse Proxy (Nginx)

```nginx
# /etc/nginx/sites-available/steroids
server {
    listen 80;
    server_name steroids.example.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name steroids.example.com;

    ssl_certificate /etc/letsencrypt/live/steroids.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/steroids.example.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## Monitoring

### Logging

```typescript
// Structured JSON logging in production
{
  "level": "info",
  "time": "2026-02-07T10:30:00.000Z",
  "msg": "Request completed",
  "requestId": "abc-123",
  "method": "GET",
  "url": "/api/projects",
  "statusCode": 200,
  "responseTime": 42
}
```

### Metrics (Optional)

```typescript
// Prometheus metrics endpoint
// GET /metrics

# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",path="/api/projects",status="200"} 1234

# HELP http_request_duration_seconds HTTP request duration
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{le="0.1"} 950
```

### Alerting Recommendations

| Metric | Warning | Critical |
|--------|---------|----------|
| Error rate | > 1% | > 5% |
| Response time (p95) | > 500ms | > 2000ms |
| Disk usage | > 80% | > 95% |

---

## Backup Strategy

### Data Backups

```bash
# Daily automated backup of .steroids directories
0 2 * * * tar -czf /backups/steroids_$(date +\%Y\%m\%d).tar.gz ~/.steroids/ /path/to/projects/*/.steroids/

# Retain 30 days
find /backups -name "steroids_*.tar.gz" -mtime +30 -delete
```

### Configuration Backup

```bash
# Backup .env and config files
tar -czf config_backup.tar.gz .env ~/.steroids/
```

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| ENOENT on startup | Missing .steroids directory | Run `steroids init` |
| Permission denied | File access issue | Check directory permissions |
| WebSocket disconnects | Proxy timeout | Increase proxy timeout |
| 502 Bad Gateway | App crashed | Check logs, restart app |

### Debug Mode

```bash
# Enable debug logging
LOG_LEVEL=debug pnpm start
```
