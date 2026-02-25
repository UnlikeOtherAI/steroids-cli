# CSR React Admin Panel – Architecture & Implementation Skill Spec

## 1. Core Architectural Principles

- **Client-Side Rendered (CSR) React SPA**
- Clear separation of:
  - **Server state** (remote data, caching, invalidation)
  - **Client/session state** (auth user, UI prefs)
  - **Local UI state** (component-level)
- **Feature-first structure** preferred over layer-first for scalability
- Routing is an architectural boundary (route-level containers)
- Client-side RBAC is UX only — enforcement must be server-side
- Prefer functional components + hooks
- Class components only for error boundaries (if needed)

---

## 2. Recommended Folder Structures

### Small App

```text
src/
api/
app/
components/
layout/
ui/
hooks/
pages/
routes/
styles/
types/
```

Use when:
- < 10 routes
- Few entities
- Single developer

---

### Medium App (Recommended Default)

```text
src/
app/
providers/
router/
shared/
api/
lib/
ui/
types/
features/
auth/
users/
roles/
pages/
dashboard/
users/
tests/
```

Use when:
- 10–40 routes
- Multiple entities
- Reusable forms/tables

---

### Large App (Feature-Sliced Inspired)

```text
src/
app/
pages/
widgets/
features/
entities/
shared/
processes/
tests/
e2e/
```

Use when:
- Multi-team
- 40+ routes
- Strict dependency control required

---

## 3. Component Architecture

### Component Layers

1. **App Root**
2. **Providers (Auth, Query, Theme)**
3. **Layouts**
4. **Pages (route containers)**
5. **Widgets**
6. **Feature Components**
7. **Shared UI primitives**

---

## 4. TypeScript Conventions

### Naming

- Folders: `kebab-case` or `camelCase` (be consistent)
- Components: `PascalCase.tsx`
- Types: `PascalCase`
- Feature slices: grouped by domain

### Core Shared Types

```ts
export type Id = string;

export interface PageRequest {
  page: number;
  pageSize: number;
}

export interface PageResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export type SortDirection = "asc" | "desc";

export interface ApiError {
  status: number;
  code: string;
  message: string;
  requestId?: string;
  details?: unknown;
}
```

---

## 5. State Management Strategy

### 1. Server State (Primary)

Use:

- `@tanstack/react-query`

Responsibilities:

- Fetching
- Caching
- Retry logic
- Background refetch
- Invalidation

Never store fetched lists in Redux unless absolutely necessary.

---

### 2. Client Session State

Small global state only:

- Auth user
- Roles
- Theme
- Feature flags

Options:

- Context (simple apps)
- Zustand (lightweight)
- Redux Toolkit (complex flows)
- MobX (if team aligned)

### 3. Local UI State

Use:

- `useState`
- `useReducer`

---

## 6. API Integration Pattern

### Layered Structure

```text
shared/api/httpClient.ts
features/users/api/usersService.ts
features/users/model/userMapper.ts
```

### Rules

- One central HTTP client
- Normalize all errors into `ApiError`
- Never leak Axios/fetch raw errors to UI
- Optional retry logic via:
  - React Query
  - Axios interceptors

---

## 7. Routing Architecture

Use:

- `react-router-dom`
- `createBrowserRouter`
- Route objects

### Pattern

- Route-level layout
- Route-level loader for auth
- Redirect inside loader
- Lazy route-based code splitting

---

## 8. Authentication & RBAC

### Architecture

- Auth provider at app level
- Protected route groups
- Loader-based redirect
- UI-level permission checks
- Server-level enforcement mandatory

Never trust frontend role checks.

---

## 9. Forms

Use:

- `react-hook-form`
- `zod` for validation

### Pattern

- `FormProvider`
- Typed schemas
- Infer types from schema
- Validation at boundary

Never trust backend data — validate external payloads.

---

## 10. Tables

Use:

- `@tanstack/react-table`

### Features

- Typed column definitions
- Pagination
- Sorting
- Filtering
- Optional virtualization

Virtualize if:

- > 200 rows visible
- Heavy cell rendering

Use:

- `@tanstack/react-virtual`
- or `react-window`

---

## 11. Performance Strategy

Only optimize when measured.

Tools:

- `React.memo`
- `useMemo`
- `useCallback`
- Virtualization
- Route-based lazy loading
- Split heavy widgets

Avoid premature memoization.

---

## 12. Styling Strategy

Pick one primary system:

### Option A

- Tailwind + headless components

### Option B

- MUI + `sx`

### Option C

- Chakra UI

Supplement with:

- CSS Modules (localized overrides)

Avoid mixing 3+ styling paradigms.

---

## 13. Testing Strategy

### Unit / Component

- `@testing-library/react`
- Test user behavior, not implementation

### Integration

- `msw` for API mocking

### E2E

- `@playwright/test`

### Runner

- `vitest` (preferred for Vite)

---

## 14. Accessibility

Target:

- WCAG 2.2 AA

Critical Areas:

- Dialogs
- Menus
- Tables
- Keyboard navigation
- Focus management

Follow WAI-ARIA patterns.

---

## 15. Internationalization

Options:

- `react-i18next`
- `react-intl`

Handle:

- Dates
- Currency
- Plurals
- Enum labels

Never hardcode formatted strings.

---

## 16. Build Tooling

Avoid:

- Create React App (deprecated)

Use:

- Vite

### Key config:

- `base` for subpath deployment
- `import.meta.env`
- Manual chunk splitting if needed

---

## 17. Developer Experience

Recommended:

- ESLint
- Prettier or Biome
- Husky + lint-staged
- Storybook
- Code generators (Hygen / Plop)

---

## 18. Scaling Checklist

1. Move to feature-first structure
2. Separate server vs client state
3. Route-level guards
4. Standardize forms/tables
5. Add lazy route splitting
6. Add virtualization for heavy lists
7. Formalize accessibility audits
8. Enforce linting + precommit hooks
9. Server-enforce RBAC
10. Migrate to modern build tooling if legacy

---

## 19. Recommended Core Dependencies

```text
react
react-dom
react-router-dom
@tanstack/react-query
@tanstack/react-table
@tanstack/react-virtual
react-hook-form
zod
axios (optional)
zustand or @reduxjs/toolkit (if needed)
react-i18next or react-intl
vitest
@testing-library/react
msw
@playwright/test
eslint
prettier or biome
husky
lint-staged
storybook
```

---

## 20. Architectural Default Recommendation

For most professional admin panels:

- Vite
- React Router (data router)
- TanStack Query
- Feature-first folder structure
- React Hook Form + Zod
- TanStack Table
- Tailwind or MUI
- MSW + Playwright
- Zustand (only if needed)
- Strict server-side RBAC enforcement

End of spec.
