# Steroids WebUI

Visual dashboard for managing Steroids projects.

## Features

- **Projects Page**: List all registered Steroids projects with stats
- **Project Management**: Enable/disable projects, prune stale entries
- **Live Stats**: View pending, in-progress, review, and completed tasks
- **Runner Status**: Monitor active runners for each project

## Development

```bash
# Install dependencies
npm install

# Run dev server (http://localhost:3500)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Environment Variables

Create a `.env.local` file:

```env
VITE_API_URL=http://localhost:3501
```

## Architecture

- **React 18** with TypeScript
- **Vite** for fast development
- **Atomic Design** component structure
- **Tailwind CSS** styling (via inline classes)

See [ARCHITECTURE.md](./ARCHITECTURE.md) for details.

## Running Locally

```bash
# Install dependencies
npm install

# Development mode
npm run dev

# Or from project root
make launch
```

Access at http://localhost:3500
