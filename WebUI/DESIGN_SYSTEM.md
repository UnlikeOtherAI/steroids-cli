# Steroids WebUI Design System

## 1) Quick inventory (1 screen summary)

* **Page type:** Dashboard / overview screen (multi-card admin layout)
* **Primary layout regions:**

  1. **App shell** centered on a neutral page background (large rounded container + shadow)
  2. **Left sidebar** (dark) with brand row, primary CTA pill, vertical nav, bottom round CTA
  3. **Top bar** (light) with page title (left) + search + icon button(s) + user pill (right)
  4. **Main content** (light) with:

     * Row A: 4 equal **stat tiles**
     * Row B: left **table card** + right **gauge card**
     * Row C: left **list/tabs card** + right **chart card**
* **Grid system guess (inside main content):**

  * Main content inner width (excluding sidebar): **~1357px**
  * Main content horizontal padding: **~32-40px**
  * **Row A:** 4 columns, each **~310px wide**, **~16px** gutters
  * **Rows B/C:** 2 columns, **left ~793px**, **right ~459px**, **gap ~32-36px**
  * Behavior: **fluid main**, sidebar fixed; grid likely **12-col** with mixed spans

---

## 2) Design tokens (output as a Tailwind-oriented token set)

### 2.1 Colors

| Token         |   Hex | Where it's used                                                 | Notes                                 |
| ------------- | ----: | --------------------------------------------------------------- | ------------------------------------- |
| `bg.page`     | `#BDB7B2` | Outer page/background behind the app shell                  | Neutral warm gray                     |
| `bg.shell`    | `#C9C0BC` | Large rounded "device/app container" behind the UI          | Slightly lighter than `bg.page`       |
| `bg.surface`  | `#EBDFD8` | Main content background (top bar + canvas)                  | Warm beige/pink tint                  |
| `bg.surface2` | `#F1EBE6` | Card backgrounds (stat tiles + large cards)                 | Very close to surface, but lighter    |
| `bg.elevated` | `#FFFFFF` | Search input, dropdown pills, icon buttons, active sidebar pill | True white, used as "raised" elements |

| Token            |   Hex | Where it's used                                     | Notes                            |
| ---------------- | ----: | --------------------------------------------------- | -------------------------------- |
| `text.primary`   | `#2A2723` | Primary headings, main numbers, key labels      | Warm near-black (not pure black) |
| `text.secondary` | `#8F8C89` | Secondary labels, helper text, subdued headings | Mid gray                         |
| `text.muted`     | `#C2C0BE` | Placeholder-ish text, tertiary hints            | Very light gray                  |
| `text.inverse`   | `#F9F7F5` | Sidebar text/icons on dark background           | Slightly off-white               |

| Token          |   Hex | Where it's used                                       | Notes                              |
| -------------- | ----: | ----------------------------------------------------- | ---------------------------------- |
| `accent`       | `#E65E2A` | Sidebar CTA icon, active nav icon/text, small accents | Saturated orange                   |
| `accent.hover` | `#D95525` | Hover/active darken                                   | ~5-10% darker                      |
| `accent.soft`  | `#EFD6C5` | Soft orange chips/pills                               | Used for "warm status" backgrounds |

**Status colors (chips, indicators, arcs)**

| Token          |   Hex | Where it's used                     | Notes                         |
| -------------- | ----: | ----------------------------------- | ----------------------------- |
| `success`      | `#2F9A57` | Success text/indicators         | Foreground green              |
| `success.soft` | `#C8EAC6` | Soft green pill backgrounds     | Sampled from chip bg          |
| `warning`      | `#D6A33A` | Warning text/indicators         | Foreground amber              |
| `warning.soft` | `#FFE08C` | Soft amber pill backgrounds     | Sampled from chip bg          |
| `danger`       | `#E05A5A` | Danger text/indicators          | Foreground red                |
| `danger.soft`  | `#F3C8C4` | Soft red/pink pill backgrounds  | Sampled from chip bg          |
| `info`         | `#71A0E3` | Info/blue indicators            | Sampled from blue circle      |
| `info.soft`    | `#C7D4F9` | Very soft blue backgrounds      | Sampled from lighter blues    |

---

### 2.2 Typography

* **Font family:** `Poppins` / `Manrope`-style geometric sans (fallback: `Inter`, `system-ui`)
* **Base font size:** `~14px` (most body) with `~20px` line-height
* **Weights observed:** `400` (body), `500` (labels/nav), `600` (section titles), `700` (key values/page title)

**Type ramp**

| Tailwind token | Size (px) | Line-height (px) |  Weight | Typical usage                                        |
| -------------- | --------: | ---------------: | ------: | ---------------------------------------------------- |
| `text-xs`      |        12 |               16 |     500 | Small labels, chip text, badge counts                |
| `text-sm`      |        14 |               20 | 400/500 | Body, nav labels, table cells                        |
| `text-base`    |        16 |               24 | 500/600 | Card titles, section headers (smaller)               |
| `text-lg`      |        18 |               26 |     600 | Section titles inside cards                          |
| `text-xl`      |        20 |               28 | 600/700 | Major section title (main content)                   |
| `text-2xl`     |        24 |               32 |     700 | Tile "Value" / prominent numbers                     |

---

### 2.3 Spacing & sizing scale

* **Rhythm:** **8px grid** (most gaps are 8/16/24/32; occasional 36/40)
* **App shell padding:** ~28px on all sides
* **Main content padding:** **~32-40px**
* **Card padding:** **~24px** (large cards), **~20-24px** (stat tiles)

**Standard heights:**
* Top bar height: **~100px**
* Search input height: **~54px**
* Sidebar primary CTA pill: **~55px**
* Filter pills: **~40px**
* Icon-only round buttons: **~44-48px**
* Table/list row: **~44-48px**

---

### 2.4 Corner radii

| Token           | Radius (px) | Where it's used                                                        |
| --------------- | ----------: | ---------------------------------------------------------------------- |
| `radius.sm`     |       10-12 | Small inner elements, subtle rounding                                  |
| `radius.md`     |          14 | Some cards / medium surfaces                                           |
| `radius.lg`     |          16 | **Most cards** (stat tiles + big cards)                                |
| `radius.xl`     |       28-32 | App shell inner rounding (UI container), large panels                  |
| `radius.pill`   |        9999 | Search input, dropdown pills, filter pills, sidebar active item, chips |

---

### 2.5 Borders, shadows, elevation

**Shadow recipes (Tailwind-style)**

| Elevation      | Approx shadow                                               | Used for                          |
| -------------- | ----------------------------------------------------------- | --------------------------------- |
| `shadow.card`  | `0 10px 30px rgba(0,0,0,0.06), 0 1px 0 rgba(0,0,0,0.03)` | All cards                         |
| `shadow.pill`  | `0 12px 28px rgba(0,0,0,0.08)`                              | Search input, white pills/buttons |
| `shadow.shell` | `0 24px 60px rgba(0,0,0,0.18)`                              | Outer app shell (big container)   |

---

### 2.6 Effects

* **Hover (pills/buttons):** slightly darker shadow + tiny translate
* **Hover (sidebar items):** text brightens
* **Active/selected:** Sidebar active item uses **white pill** + **accent** icon/text
* **Transitions:** `transition-all duration-150 ease-out`

---

## 3) Layout spec

### 3.1 Global

* Outer page: **solid warm gray** background (`bg.page`)
* Centered app shell: large rounded rectangle with heavy soft shadow
* Main UI background: `bg.surface` (warm beige)

### 3.2 Regions

**Sidebar**
* Width: **~299px** (use `w-[300px]`)
* Height: full app height
* Background: near-black `#060606`

**Top bar**
* Height: **~100px**
* Left: large page title
* Right: search input (pill) + icon button (pill/circle) + user dropdown (pill)

**Main content**
* Left padding: **~32-40px**
* Row spacing: **~24-32px**

---

## 5) Tailwind config

```js
export default {
  theme: {
    extend: {
      colors: {
        bg: {
          page: "#BDB7B2",
          shell: "#C9C0BC",
          surface: "#EBDFD8",
          surface2: "#F1EBE6",
          elevated: "#FFFFFF",
        },
        text: {
          primary: "#2A2723",
          secondary: "#8F8C89",
          muted: "#C2C0BE",
          inverse: "#F9F7F5",
        },
        accent: {
          DEFAULT: "#E65E2A",
          hover: "#D95525",
          soft: "#EFD6C5",
        },
        success: { DEFAULT: "#2F9A57", soft: "#C8EAC6" },
        warning: { DEFAULT: "#D6A33A", soft: "#FFE08C" },
        danger:  { DEFAULT: "#E05A5A", soft: "#F3C8C4" },
        info:    { DEFAULT: "#71A0E3", soft: "#C7D4F9" },
        sidebar: "#060606",
      },
      fontFamily: {
        sans: ["Poppins", "Inter", "system-ui", "sans-serif"],
      },
      borderRadius: {
        sm: "12px",
        md: "14px",
        lg: "16px",
        xl: "32px",
        pill: "9999px",
      },
      boxShadow: {
        card: "0 10px 30px rgba(0,0,0,0.06), 0 1px 0 rgba(0,0,0,0.03)",
        pill: "0 12px 28px rgba(0,0,0,0.08)",
        shell: "0 24px 60px rgba(0,0,0,0.18)",
      },
    },
  },
};
```

---

## CSS Component Classes

```css
.card { @apply bg-bg-surface2 rounded-lg shadow-card; }
.stat-tile { @apply bg-bg-surface2 rounded-lg shadow-card p-5; }
.btn-pill { @apply bg-bg-elevated rounded-full shadow-pill px-6 py-3 text-sm font-medium text-text-primary hover:shadow-card transition-all duration-150; }
.btn-accent { @apply bg-accent text-white rounded-full shadow-pill px-6 py-3 text-sm font-medium hover:bg-accent-hover transition-all duration-150; }
.input-search { @apply h-14 bg-bg-elevated rounded-full shadow-pill px-5 pl-12 text-sm text-text-primary placeholder:text-text-muted focus:outline-none; }
.badge-success { @apply px-3 py-1 bg-success-soft text-success text-xs font-medium rounded-full; }
.badge-warning { @apply px-3 py-1 bg-warning-soft text-warning text-xs font-medium rounded-full; }
.badge-danger { @apply px-3 py-1 bg-danger-soft text-danger text-xs font-medium rounded-full; }
.badge-info { @apply px-3 py-1 bg-info-soft text-info text-xs font-medium rounded-full; }
.badge-accent { @apply px-3 py-1 bg-accent-soft text-accent text-xs font-medium rounded-full; }
.sidebar-item { @apply flex items-center gap-3 px-6 py-3 text-sm font-medium text-text-inverse/90 hover:text-text-inverse transition-colors rounded-full; }
.sidebar-item-active { @apply flex items-center gap-3 px-6 py-3 bg-bg-elevated rounded-full shadow-pill text-sm font-medium text-accent; }
```

---

## Rules of composition

* Cards always use: `bg.surface2 + radius.lg (~16px) + shadow.card`
* Elevated controls (search/pills/icon buttons) always use: `bg.white + shadow.pill + rounded-full`
* Main background is warm: `bg.surface` (no pure white canvas)
* Spacing follows an 8px grid:
  * Outer paddings: **32-40px**
  * Card padding: **24px**
  * Small gaps: **16px**
  * Large column gaps: **32-36px**
* Chips are always `rounded-full`, with soft tinted bg + stronger text color
