# Tailwind UI Architecture & Implementation Skill Pack (v4+)

## Purpose

Best practices, patterns, constraints, and implementation strategies for:

- Marketing / landing websites
- Admin dashboards / SaaS applications

Built for:

- Tailwind CSS v4+
- Modern browser targets
- WCAG 2.2-aligned accessibility patterns
- Performance-safe layout techniques
- Minimal JavaScript where possible

This is optimized for LLM consumption and system-prompt usage.

## 1. Tailwind v4 Philosophy

### Core Principles

- CSS-first configuration (`@theme`, `@source`)
- Automatic content detection
- Avoid dynamic class construction
- Mobile-first responsive system
- Container queries supported in core
- Modern browser baseline (no legacy IE assumptions)

### Golden Rules

- Never build dynamic class strings:

```text
// ❌ Wrong
bg-${color}-500

// ✅ Correct
const variants = {
  primary: "bg-blue-500",
  danger: "bg-red-500"
};
```

- Always use complete class names in source.
- If necessary, safelist with `@source inline()`.
- Prefer utilities over custom CSS.
- Extract components before using `@apply`.

## 2. Landing Page Architecture

### File Structure

```
src/
  pages/
  sections/
  components/
  assets/
  styles/
    app.css
```

### styles/app.css

```css
@import "tailwindcss";

@theme {
  --color-primary: #111111;
  --breakpoint-3xl: 1600px;
}
```

### Layout Strategy

#### Width Philosophy (choose one)

Option A (preferred):

```html
<div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
```

Option B:

```html
<div class="container mx-auto px-4">
```

#### Section Pattern

##### Hero

- Mobile: single column, centered content
- Desktop: two-column grid (copy + visual)

```html
<section class="py-20">
  <div class="mx-auto max-w-7xl px-4">
    <div class="grid gap-12 lg:grid-cols-2">
```

##### Feature Grid

```html
<div class="grid gap-8 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
```

### Navigation Pattern (Marketing)

- Use disclosure pattern for mobile.

#### Mobile Toggle (No JS Required)

```html
<details class="md:hidden">
  <summary class="p-2 rounded-md hover:bg-black/5">
    ☰
  </summary>
  <nav class="mt-2 rounded-lg border p-2">
```

#### Desktop Nav

```html
<nav class="hidden md:flex gap-6">
```

### Motion Guidelines

- Always animate: `opacity`, `transform`
- Never animate: `width`, `height`, `left`, `margin`
- Use utility: `class="transition-transform duration-200 ease-out"`
- Prefer motion-safe defaults with `motion-reduce` variants.

### Accessibility Requirements (Landing)

Mandatory:

- `focus-visible:ring-*`
- `sr-only` for hidden text
- Skip link
- Touch targets ≥ 24×24px
- Avoid hover-only interactions
- Respect `motion-reduce`

## 3. Admin Panel Architecture

Admin UIs should prioritize stability, predictability, and state persistence.

### Recommended Structure

- `app/`
- `shell/`
- `features/`
- `ui/`
- `styles/`

### App Shell Layout

- **Mobile**
  - Sidebar: off-canvas drawer
  - Top bar: toggle button
  - Backdrop overlay
  - Focus trap
- **Desktop**
  - Persistent sidebar
  - Content offset via margin
  - Sticky top bar

### Sidebar Pattern (Responsive)

#### Off-Canvas (Mobile)

```text
class="fixed inset-y-0 left-0 w-64 -translate-x-full transform transition-transform"
```

- Open state: `translate-x-0`
- Backdrop: `class="fixed inset-0 bg-black/30 transition-opacity"`

#### Desktop

```html
<main class="lg:ml-64">
```

### Sidebar Collapse Strategy

#### Option 1 — No Layout Shift (Recommended)

- Keep width fixed: `class="w-64"`
- Hide labels: `<span class="sr-only">Label</span>`

#### Option 2 — Width Shrink (Use Carefully)

- `class="transition-[width] duration-200"`
- Persist state in `localStorage`

### Nested Navigation

- Use `<details>` for collapsible groups:
  - `<details class="open:bg-black/5">`
  - `<summary class="px-3 py-2">`

## 4. Responsive Strategy

- Mobile-first by default.
- Breakpoints:
  - `sm:`
  - `md:`
  - `lg:`
  - `xl:`
  - `2xl:`
- Use container queries for component-level behavior where appropriate:

```css
@container
```

## 5. Performance Rules

### Critical

- No dynamic classes
- Avoid large `@apply` blocks
- Minify CSS
- Enable Brotli
- Avoid heavy shadows
- Avoid excessive arbitrary values

### CSS Reflow Safety

- **Safe:** `opacity`, `transform`
- **Danger:** `width`, `height`, `padding`, `margin`

## 6. State Management Decision Tree

### Landing Pages

- Prefer CSS-only patterns
- Use `<details>`
- Minimal Alpine only if required

### Admin Panels

#### Option A — Alpine

- `x-data`
- `x-show`
- `x-transition`
- `x-trap`
- `x-collapse`

#### Option B — HTMX

- Server-driven UI
- Partial updates
- Minimal JS

#### Option C — React/Vue

Use when:

- Complex client state
- Optimistic updates
- Heavy interactivity

## 7. Accessibility Enforcement (Admin)

Sidebar drawer requirements:

- Trap focus
- Close on Escape
- Restore focus after close
- Prevent background interaction

Focus rules:

- Never remove outlines
- Always add:
  - `focus-visible:outline-none`
  - `focus-visible:ring-4`

## 8. Testing Stack

- Playwright (E2E)
- axe-core (Accessibility)
- Storybook a11y (Components)
- Lighthouse (Performance)

## 9. Component Reuse Strategy

Recommended order:

1. Extract component file
2. Extract layout wrapper
3. Compose utilities
4. Use `@layer components` only if needed
5. Avoid heavy `@apply`

## 10. Menu Pattern Comparison

| Pattern | Best For | Notes |
| --- | --- | --- |
| Off-canvas drawer | Mobile admin | No layout shift |
| Persistent sidebar | Desktop admin | Fast workflow |
| Mini sidebar | Dense admin | Requires tooltips |
| Top nav only | Light apps | Limited depth |
| Disclosure nav | Marketing | Simple and accessible |

## 11. Anti-Patterns

- Dynamic Tailwind class names
- Animating width
- Removing focus indicators
- Hover-only navigation
- Massive arbitrary value chains
- Rebuilding Tailwind config in JS in v4 projects
- Overusing `@apply`

## 12. Production Checklist

- No dynamic classes
- CSS minified
- Brotli enabled
- Lighthouse score ≥ 90
- No layout shift on menu toggle
- Focus visible everywhere
- Touch targets ≥ 24px
- No animation without `motion-reduce` support

## 13. Design Philosophy Summary

### Landing pages optimize for

- Clarity
- Conversion
- Visual hierarchy
- Performance

### Admin panels optimize for

- Stability
- Predictability
- State persistence
- Keyboard workflows
- Zero layout jump
