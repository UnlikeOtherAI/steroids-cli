# Architectural Study: Injecting Schemas into CLI Sessions

## The Core Question
> "How hard would it be to start a conversation using an API (to enforce a JSON schema) and then inject that session into the CLI wrapper's conversation history?"

## The Short Answer
**Extremely difficult and highly brittle.** Doing this would require reverse-engineering the undocumented, internal state-management implementations of 5+ different CLI tools, many of which use remote server-side threads that we cannot manipulate locally.

---

## Deep Dive: How Session State is Managed Today
Steroids CLI operates as a "wrapper" around independent CLI binaries (`claude`, `gemini`, `vibe`, `codex`). When Steroids passes a `--resume <session_id>` flag, the underlying tool handles reconstructing the history. 

Here is how each tool manages that state, and why injecting an API-created session is problematic:

### 1. Codex (OpenAI)
*   **State Location:** Remote (OpenAI Assistants API Threads).
*   **The Problem:** The `codex` CLI maps a local session ID to a remote OpenAI `thread_id`. If we created a thread natively via the OpenAI SDK (to pass a strict `response_format` schema), we would have to reverse-engineer Codex's local SQLite cache (or JSON config) to artificially plant the `thread_id` so the CLI thinks it owns it. If Codex updates its internal database schema, our injection breaks.

### 2. Claude CLI (Anthropic)
*   **State Location:** Local (`~/.anthropic/sessions/` SQLite or JSON).
*   **The Problem:** Anthropic's CLI uses a proprietary format to store past user/assistant messages. To inject an API-generated turn, we would have to write a custom SQLite adapter just for Anthropic's undocumented schema. Furthermore, the Claude API doesn't support "arbitrary JSON schema" directly without forcing the model to use a "Tool"—which the CLI wrapper does not understand how to resume.

### 3. Vibe (Mistral)
*   **State Location:** Local (`~/.vibe/logs/session/`).
*   **The Problem:** Vibe stores its history in `.json` and `.log` files. While technically the easiest to modify, any change to Vibe's internal file structure would instantly break the Steroids CLI loop.

### 4. Gemini CLI
*   **State Location:** Local file system.
*   **The Problem:** The Gemini CLI stores sessions as serialized protocol buffers or JSON. While we could theoretically generate a session file, keeping our generator perfectly synced with the upstream CLI's format is a massive maintenance burden.

---

## Why this violates our "Simplicity" mandate
The primary goal of the current refactor campaign has been to **delete code** and **remove fragile dependencies on string parsing and complex fallbacks**. 

If we attempted to "API-Inject" sessions:
1.  We would have to build and maintain **5 different reverse-engineered database adapters** just to sync state with the CLIs.
2.  Every time Anthropic, Google, or OpenAI pushes an update to their CLI, our state injection could break.
3.  We would have to maintain both native API SDKs *and* CLI wrappers in the codebase, doubling the surface area for bugs.

## The Alternative (The "Plain Text" Path)
Instead of fighting the CLI tools to force them into strict JSON compliance, we should **embrace their natural output format: Markdown and Plain Text.**

As detailed in the `JSON-vs-Text-Study.md` document, we can achieve 100% deterministic state transitions by simply looking for explicit intent tokens (e.g., `DECISION: APPROVE`) in the unstructured text. This requires **zero** reverse-engineering, allows us to delete the complex JSON schema validation, and relies purely on the host system (Git/File system) for data integrity.