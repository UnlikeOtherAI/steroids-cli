# SKILL: Apple-Platform App Architecture & HIG-Aligned Implementation

Purpose: Design and implement Apple-platform applications (iOS, iPadOS, macOS, watchOS, tvOS) that:

- Follow Apple Human Interface Guidelines (HIG)
- Use state-driven architecture
- Support deep linking & scene lifecycle
- Respect accessibility & localisation
- Meet performance, energy, and privacy requirements
- Pass App Store review

This skill is OS-aligned, not trend-aligned.

---

# 1. CORE ARCHITECTURAL PRINCIPLES

## 1.1 State-Driven UI (Mandatory)

UI must be a function of state.

- Views do not own business logic.
- Navigation is represented as data.
- Side effects are isolated.
- Concurrency is explicit.

### Invariants

- `View = f(State)`
- Navigation = `Tab + Path + Optional Modal`
- Side effects run in async services or Tasks
- UI updates on `@MainActor`

---

## 1.2 Recommended Layering

### Domain Layer
- Pure Swift types
- Immutable where possible
- Actors for shared mutable state

### State / Store Layer
- ObservableObject (SwiftUI)
- Explicit navigation state
- Routing logic (deep links included)

### UI Layer
- SwiftUI views OR UIKit view controllers
- Declarative composition
- No business logic

### Services Layer
- Networking
- Persistence
- Background tasks
- External APIs

---

# 2. NAVIGATION STRUCTURE

## 2.1 Top-Level Destinations

Use Tab Bar when:
- Peer-level sections
- Users switch frequently
- Each tab preserves its own navigation stack

Never overload first tab with “everything”.

---

## 2.2 Hierarchical Drill-Down

Use:
- `NavigationStack` (SwiftUI)
- `UINavigationController` (UIKit)

Navigation state must be data-driven:

```swift
@Published var path = NavigationPath()
```

Deep links mutate the path — not present views manually.

---

## 2.3 Split Views (iPad / macOS)

Use `NavigationSplitView` when:

- Stable sidebar hierarchy
- Parent-child browsing pattern (Mail, Notes style)

Must gracefully collapse to single column in compact environments.

---

## 2.4 Modality Rules

Use sheets for:
- Self-contained temporary tasks
- Editing flows
- Creation flows

Use alerts for:
- Critical confirmations

Never use modals for primary navigation.

---

# 3. LIFECYCLE & SCENES

Apps must support scene-based lifecycle.

## SwiftUI Entry Pattern

```swift
@main
struct MyApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                .onOpenURL { url in
                    appState.route(to: url)
                }
        }
    }
}
```

## Rules

- Route deep links through central router.
- Lifecycle events mutate state.
- UI reacts to state change.
- Never directly present UI in lifecycle callbacks.

---

# 4. DEEP LINKS & UNIVERSAL LINKS

## Mandatory Pattern

- Use Associated Domains
- Prefer Universal Links over custom URL schemes
- `onOpenURL` handles routing

Deep link must resolve to:

`(destination tab, navigation path, optional modal)`

No separate navigation flow for deep links.

---

# 5. CONCURRENCY MODEL

## Default: Swift Concurrency

Use:

- `async/await`
- `Task`
- `TaskGroup`
- `actor`

Rules:

- UI updates on `@MainActor`
- No heavy work on main thread
- Structured concurrency only
- Avoid fire-and-forget unbounded tasks

---

## When to Use Combine

Use only for:

- Streams of values over time
- Continuous user input
- System notifications
- Complex reactive pipelines

Do NOT use Combine for simple async fetches.

---

# 6. ADAPTIVE LAYOUT

## Safe Area Rules

- Interactive content must stay inside safe area
- Background may extend under system bars
- Use `safeAreaInset` where appropriate

## Size Class Rules

- Do not branch purely on orientation
- Design for resizing (iPad multitasking)
- Support multi-window

---

# 7. VISUAL SYSTEM COMPLIANCE

## Mandatory Usage

- System fonts (Dynamic Type compatible)
- SF Symbols (hierarchical/palette modes)
- Semantic colors
- System materials (.ultraThinMaterial etc.)
- Dark Mode support

Never hardcode colors without semantic fallback.

---

# 8. ACCESSIBILITY (NON-OPTIONAL)

Accessibility is structural.

## Required

- Every interactive element:
  - Label
  - Hint (if needed)
  - Traits
- Dynamic Type support
- Contrast validation
- Reduce Motion compliance
- VoiceOver navigable

Example:

```swift
Button {
    delete()
} label: {
    Image(systemName: "trash")
}
.accessibilityLabel("Delete")
.accessibilityHint("Deletes the selected item")
```

---

# 9. LOCALISATION & INTERNATIONALISATION

## Structural Rules

- No string concatenation
- Use String Catalog
- Support plural rules
- Support RTL automatically
- Use leading/trailing, not left/right

SwiftUI auto-localises string literals.

---

# 10. PERFORMANCE & ENERGY

## Performance Principles

- Batch network calls
- Avoid redundant view updates
- Profile with Instruments
- Avoid unnecessary animations

## Energy Principles

- Respect Dark Mode (OLED savings)
- Stop services when not needed
- Schedule background tasks properly
- Use BGTaskScheduler

---

# 11. PRIVACY & APP STORE COMPLIANCE

## Required

- Follow App Review Guidelines
- Implement App Tracking Transparency (if tracking)
- Provide Privacy Manifest (PrivacyInfo.xcprivacy)
- Match privacy disclosures to actual behaviour
- Do not manipulate consent UI

Consent must be:

- Clear
- Specific
- User-controlled

---

# 12. TESTING MATRIX

## Must Test

- Unit logic
- Navigation flows
- Deep link routing
- Accessibility audit
- Dynamic Type at max size
- Dark Mode
- RTL
- Performance profiling
- Background task execution

---

# 13. PLATFORM DIFFERENCES

## iPhone

- Touch-first
- Clear tab structure
- Deep hierarchical stacks

## iPad

- Adaptive layouts
- Split views
- Multi-window support

## macOS

- Windows & menu bar
- Keyboard-first usability

## watchOS

- Shallow hierarchy
- Glanceable content
- Crown-driven navigation

## tvOS

- Focus-based navigation
- Large targets
- Remote-first interaction

---

# 14. FINAL INVARIANTS (LLM-ENFORCABLE)

An Apple-compliant app must:

- Use container-based navigation
- Represent navigation as data
- Respect safe areas
- Use system typography and colors
- Support Dynamic Type
- Support RTL
- Handle deep links through central router
- Isolate side effects
- Use structured concurrency
- Respect privacy declarations
- Avoid UI logic in lifecycle callbacks

---

# OUTPUT EXPECTATION

Any generated Apple-platform app must:

1. Define navigation hierarchy first.
2. Define state model.
3. Define routing strategy.
4. Implement UI using system primitives.
5. Layer accessibility & localisation.
6. Integrate concurrency cleanly.
7. Validate performance & privacy before shipping.

Failure to follow these means non-HIG-compliant implementation.
