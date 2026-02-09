# Steroids Chat CLI - Design Document

## Overview

This document describes the architecture for adding a chat command line interface to Steroids. The chat CLI will provide an interactive developer assistant that can help with task management, code review, debugging, and general development workflow within the Steroids ecosystem.

---

## Core Principles

### 1. Conversation as Structured State

The chat system treats conversations as **structured state** that can be persisted, replayed, pruned, and transformed. This is essential because modern LLM APIs are designed around context windows, tool calls, and streaming—not static input strings.

Key implications:
- Conversations are not just "chat bubbles"—they are typed items with metadata
- Context selection (what to send) is a deterministic step, not emergent text concatenation
- Each turn is a lifecycle: started → streaming deltas → completed/cancelled

### 2. Typed Conversation Items

The internal transcript includes typed items rather than plain messages:

```typescript
type ConversationItem =
  | UserMessage
  | AssistantMessage
  | ToolCallRequest
  | ToolOutput
  | RetrievalResult      // RAG chunks
  | Checkpoint           // Summaries/compactions
  | ModerationAnnotation // Safety approvals
```

This enables:
- Deterministic context assembly
- Clear token budgeting
- Selective replay and pruning
- Audit trails

### 3. Stateless-First Design

The chat CLI operates in **stateless mode** by default:
- Client maintains conversation state
- Server receives full context on each request
- Encrypted reasoning items can be passed between turns for continuity
- No dependency on provider-side conversation persistence

Benefits:
- Privacy/compliance control
- Portability across providers
- Predictable behaviour
- Works offline with local models

---

## Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Chat CLI (steroids chat)                │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Input Layer │  │ Turn        │  │ Output Layer        │  │
│  │ - readline  │→ │ Orchestrator│→ │ - Streaming render  │  │
│  │ - multiline │  │             │  │ - Markdown format   │  │
│  └─────────────┘  └──────┬──────┘  └─────────────────────┘  │
│                          │                                   │
│  ┌───────────────────────┴───────────────────────────────┐  │
│  │              Context Assembler                         │  │
│  │  - Token budgeting    - History window                 │  │
│  │  - Compaction         - RAG injection                  │  │
│  └───────────────────────┬───────────────────────────────┘  │
│                          │                                   │
│  ┌───────────────────────┴───────────────────────────────┐  │
│  │              Provider Adapters                         │  │
│  │  - Claude (Anthropic)  - OpenAI                        │  │
│  │  - Gemini (Google)     - Bedrock (AWS)                 │  │
│  │  - Local (Ollama)                                      │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Tool        │  │ State       │  │ Token               │  │
│  │ Executor    │  │ Storage     │  │ Counter             │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Turn Orchestrator

The central component that manages a conversation turn:

1. Accept user message
2. Assemble context bundle (history + retrieved chunks + tool definitions + runtime metadata)
3. Stream tokens/events to the UI
4. Execute tools when requested, append tool results as new items
5. Finalise turn with usage metadata and durable storage

```typescript
interface TurnOrchestrator {
  start(userMessage: string): AsyncGenerator<StreamEvent>;
  executeToolCall(call: ToolCall): Promise<ToolOutput>;
  finalise(): Promise<TurnResult>;
  abort(): void;
}
```

### Context Assembler

Responsible for building the exact input bundle for each request:

```typescript
interface ContextAssembler {
  // Build context with explicit token budget
  assemble(
    thread: Thread,
    userMessage: string,
    budget: TokenBudget
  ): Promise<ContextBundle>;

  // Estimate tokens before sending
  estimateTokens(bundle: ContextBundle): Promise<number>;

  // Compact when over budget
  compact(thread: Thread): Promise<CompactionResult>;
}

interface TokenBudget {
  maxTotal: number;        // Model's context window
  reserveForOutput: number; // Leave room for response
  historyWindow: number;    // Recent messages to keep verbatim
  summaryBudget: number;    // Tokens for compacted history
  retrievalBudget: number;  // Tokens for RAG chunks
}
```

### Provider Adapters

Abstract interface allowing multiple LLM providers:

```typescript
interface ProviderAdapter {
  // Generate response with streaming
  generate(
    request: GenerateRequest
  ): AsyncGenerator<StreamEvent>;

  // Count tokens (preflight)
  countTokens(content: TokenCountRequest): Promise<number>;

  // Compact conversation (if supported)
  compact?(items: ConversationItem[]): Promise<CompactedItems>;

  // Provider capabilities
  readonly capabilities: ProviderCapabilities;
}

interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  tokenCounting: boolean;
  compaction: boolean;
  maxContextWindow: number;
}
```

---

## Token Management

### Why Token Counting Matters

Token accounting prevents:
- Hard failures (context overflow)
- Silent context clipping
- Unbounded cost growth
- "The model missed the actual error" scenarios

### Token Counting Strategy

1. **Preflight estimation**: Count tokens before sending to avoid exceeding context window
2. **Post-completion recording**: Record actual usage for billing, analytics, and "context remaining" display
3. **Provider-specific counting**: Use provider CountTokens APIs for hosted models
4. **Local fallback**: Use exact local tokeniser for offline mode and open-weights models

```typescript
interface TokenCounter {
  // Provider-side counting (most accurate)
  countViaProvider(
    content: string,
    provider: ProviderAdapter
  ): Promise<number>;

  // Local counting (fast, for budgeting)
  countLocal(
    content: string,
    model: string
  ): number;

  // Record actual usage after completion
  recordUsage(usage: TokenUsage): void;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;  // Prompt cache hits
  totalCost?: number;     // Estimated cost
}
```

### Token Counting Libraries

| Provider | Method | Notes |
|----------|--------|-------|
| Anthropic | `messages/count_tokens` API | Includes tools, images, documents |
| OpenAI | `tiktoken` library | BPE tokeniser, ~4 bytes per token average |
| Google | `count_tokens` API | Multimodal counts may be estimates |
| AWS Bedrock | `CountTokens` operation | Model-specific, matches billing |
| Local | `tiktoken` / `SentencePiece` | Must match exact model vocab |

---

## Context Compaction

### The Problem

Long-running chats hit a predictable failure mode: the transcript grows until you either hit a context limit or spend too much on repeated history.

### Compaction Strategies

#### 1. Provider Compaction (OpenAI)

OpenAI's `/v1/responses/compact` endpoint:
- Returns encrypted, opaque compacted items
- Treat as model-consumable memory state
- Don't depend on reading the summary text

```typescript
// Compaction fits into token budgeting
if (estimatedTokens > budget.maxTotal - budget.reserveForOutput) {
  const compacted = await provider.compact(thread.items);
  thread.items = compacted;
}
```

#### 2. Rolling Summary + Buffer

LangChain-style `ConversationSummaryBufferMemory`:
- Buffer of recent verbatim messages
- Accumulated summary of older messages
- Prune based on token length, not turn count

```typescript
interface SummaryBufferMemory {
  recentBuffer: ConversationItem[];  // Last N messages verbatim
  summary: string;                    // Compressed older history

  addMessage(item: ConversationItem): void;
  prune(tokenLimit: number): void;
  toContext(): ConversationItem[];
}
```

Retains:
- User preferences and constraints
- Decisions already made
- Open TODOs / work-in-progress state

#### 3. Retrieval-Augmented Memory (RAG)

Externalise knowledge so you only inject relevant snippets:
- Embed conversation history and project context
- Retrieve relevant chunks at runtime
- Avoid "everything in prompt" anti-pattern

```typescript
interface ConversationRAG {
  // Index conversation for later retrieval
  index(item: ConversationItem): Promise<void>;

  // Retrieve relevant history given current context
  retrieve(
    query: string,
    limit: number
  ): Promise<RetrievalResult[]>;
}
```

### Compaction Command

Expose compaction as a first-class user command:

```bash
steroids chat
> /compact              # Compact conversation history
> /compact --summary    # Show what was compacted
> /context              # Show current context usage
```

---

## State Storage

### Storage Architecture

```typescript
interface ChatStorage {
  // Thread management
  createThread(): Promise<Thread>;
  getThread(id: string): Promise<Thread | null>;
  listThreads(filters?: ThreadFilters): Promise<Thread[]>;

  // Item persistence
  appendItem(threadId: string, item: ConversationItem): Promise<void>;
  getItems(threadId: string): Promise<ConversationItem[]>;

  // Checkpoints (compaction snapshots)
  saveCheckpoint(threadId: string, checkpoint: Checkpoint): Promise<void>;
  getLatestCheckpoint(threadId: string): Promise<Checkpoint | null>;
}
```

### Storage Options

| Mode | Storage | Use Case |
|------|---------|----------|
| Ephemeral | In-memory only | Quick questions, no persistence |
| Session | `.steroids/chat/sessions/` | Project-specific conversations |
| Global | `~/.steroids/chat/` | Cross-project conversations |

### Retention Controls

Explicit retention configuration:

```yaml
# .steroids/config.yaml
chat:
  retention:
    mode: session           # ephemeral | session | global
    maxAge: 7d              # Auto-delete after duration
    maxItems: 1000          # Max items per thread
    storeToolOutputs: false # Don't persist sensitive outputs
    encryptAtRest: true     # Encrypt stored conversations
```

### Privacy Considerations

Per provider data controls:
- **Anthropic**: Opt-in training, shorter retention otherwise
- **OpenAI**: `store=false` disables response persistence
- **Google**: Abuse monitoring only, no model training
- **Azure**: Organisational data isolation

For compliance, support:
- Per-tenant storage configuration
- Stateless mode with encrypted reasoning pass-through
- No accidental long-term storage via logs

---

## Security Model

### Threat Model

When chat can call tools (build systems, shells, Git, cloud APIs), the primary risk shifts from "wrong answer" to "wrong action."

OWASP Top 10 for LLM Applications:
- **LLM01: Prompt Injection** - Malicious inputs manipulate behaviour
- **LLM02: Insecure Output Handling** - Failing to validate outputs enables exploits

### Defence Layers

#### 1. Channel Separation

Strict separation between:
- **Instruction channels**: System/developer messages (trusted)
- **Data channels**: Tool outputs, retrieved docs, user artefacts (untrusted)

```typescript
interface ConversationItem {
  role: 'system' | 'user' | 'assistant' | 'tool';
  trusted: boolean;  // Explicitly mark trust level
  content: string;
}
```

#### 2. Tool Policy

```typescript
interface ToolPolicy {
  // Allowlist of permitted tools
  allowedTools: string[];

  // Per-tool permission levels
  permissions: {
    [tool: string]: 'auto' | 'confirm' | 'deny';
  };

  // Sandboxing configuration
  sandbox: {
    networkAccess: boolean;
    fileSystemScope: string[];  // Allowed paths
    maxExecutionTime: number;
  };

  // Output validation
  validateOutput: (output: string) => boolean;
}
```

#### 3. Approval Gates

High-impact actions require human confirmation:

```typescript
const DANGEROUS_PATTERNS = [
  /rm\s+-rf/,
  /git\s+push\s+--force/,
  /DROP\s+TABLE/i,
  /DELETE\s+FROM/i,
];

async function executeWithApproval(
  command: string,
  policy: ToolPolicy
): Promise<ToolOutput> {
  if (requiresApproval(command, policy)) {
    const approved = await promptUser(
      `Execute: ${command}?`,
      ['yes', 'no', 'always', 'never']
    );
    if (!approved) {
      return { status: 'denied', reason: 'User rejected' };
    }
  }
  return execute(command);
}
```

---

## Streaming Implementation

### Server-Sent Events (SSE)

All major providers support SSE-style streaming:

| Provider | Method | Events |
|----------|--------|--------|
| OpenAI | `stream=true` | `response.delta`, `response.done` |
| Anthropic | `stream: true` | `content_block_delta`, `message_stop` |
| Gemini | `generate_content_stream()` | Chunk yields |
| Bedrock | `ConverseStream` | Consistent across models |

### Stream Event Types

```typescript
type StreamEvent =
  | { type: 'start'; turnId: string }
  | { type: 'delta'; content: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; result: ToolOutput }
  | { type: 'done'; usage: TokenUsage }
  | { type: 'error'; error: Error }
  | { type: 'cancelled' };
```

### Terminal Rendering

```typescript
class StreamRenderer {
  private spinnerActive = false;

  async render(events: AsyncGenerator<StreamEvent>): Promise<void> {
    for await (const event of events) {
      switch (event.type) {
        case 'start':
          this.showSpinner('Thinking...');
          break;
        case 'delta':
          this.hideSpinner();
          process.stdout.write(event.content);
          break;
        case 'tool_call':
          this.showToolCall(event.call);
          break;
        case 'done':
          this.showUsage(event.usage);
          break;
      }
    }
  }
}
```

---

## CLI Interface

### Commands

```bash
# Start interactive chat
steroids chat

# Start with context
steroids chat --context     # Include project context
steroids chat --task <id>   # Focus on specific task

# Session management
steroids chat --list        # List saved sessions
steroids chat --resume <id> # Resume session
steroids chat --new         # Force new session

# Configuration
steroids chat --model <m>   # Override model
steroids chat --provider <p> # Override provider
```

### In-Chat Commands

```
/help           Show available commands
/clear          Clear screen
/compact        Compact conversation history
/context        Show context usage (tokens)
/save           Save session
/load <id>      Load session
/export         Export conversation as markdown
/model <m>      Switch model
/tools          List available tools
/tool <name>    Toggle tool on/off
/quit           Exit chat
```

### Keyboard Shortcuts

```
Ctrl+C          Cancel current generation
Ctrl+D          Exit chat
Ctrl+L          Clear screen
Up/Down         Navigate history
Tab             Autocomplete commands
```

---

## Performance Optimisation

### Stable Prompt Prefixes

Prompt caching relies on exact prefix matches. Structure prompts as:

1. **Static instructions** (system prompt, project rules)
2. **Stable tool definitions** (identical across requests)
3. **Volatile runtime info** (conversation history, user message)

```typescript
function assemblePrompt(thread: Thread, userMessage: string): Message[] {
  return [
    // 1. Static (cacheable)
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: PROJECT_RULES },

    // 2. Tools (stable)
    ...getToolDefinitions(),

    // 3. Dynamic (changes per request)
    ...thread.getRecentHistory(),
    { role: 'user', content: userMessage },
  ];
}
```

### Caching Strategy

```typescript
interface PromptCache {
  // Cache stable prefix
  cachePrefix(prefix: Message[]): string;

  // Check if prefix matches cached
  matches(prefix: Message[]): boolean;

  // Get cache stats
  getStats(): { hits: number; misses: number; savings: number };
}
```

---

## Integration with Steroids

### Task Context

```bash
# Chat about a specific task
steroids chat --task abc123

# Auto-loads:
# - Task spec from source file
# - Task audit history
# - Related section context
# - Recent rejection notes
```

### Tool Integration

Available tools when chatting within Steroids:

| Tool | Description |
|------|-------------|
| `steroids_tasks` | Query and update tasks |
| `steroids_sections` | View section progress |
| `steroids_audit` | Check task history |
| `steroids_config` | Read/update config |
| `file_read` | Read project files |
| `file_write` | Write project files (with approval) |
| `bash` | Execute commands (sandboxed) |
| `git` | Git operations |

### Context Injection

```typescript
async function injectProjectContext(): Promise<ConversationItem[]> {
  const items: ConversationItem[] = [];

  // Project structure
  items.push({
    role: 'system',
    content: await getProjectStructure(),
    trusted: true,
  });

  // Active tasks
  const activeTasks = await getActiveTasks();
  if (activeTasks.length > 0) {
    items.push({
      role: 'system',
      content: formatTasks(activeTasks),
      trusted: true,
    });
  }

  // Recent errors (from runner logs)
  const recentErrors = await getRecentErrors();
  if (recentErrors.length > 0) {
    items.push({
      role: 'system',
      content: formatErrors(recentErrors),
      trusted: false,  // Untrusted - could contain injection
    });
  }

  return items;
}
```

---

## Common Failure Modes

### 1. Silent Context Clipping

**Problem**: Large tool outputs get truncated, model "misses the actual error"

**Solution**:
- Token-aware truncation with markers
- Retrieve error-relevant slices via RAG
- Show user when truncation occurs

### 2. Prompt Injection via Tool Output

**Problem**: Model treats untrusted text as instructions, calls tools accordingly

**Solution**:
- Mark trust levels on all items
- Validate tool calls against policy
- Require confirmation for dangerous operations

### 3. Unbounded Cost Growth

**Problem**: Linear transcript resend grows indefinitely

**Solution**:
- Stable prefixes (caching)
- Rolling summaries/compaction
- RAG instead of "everything in prompt"

### 4. Provider Lock-in

**Problem**: Deep coupling to single provider API

**Solution**:
- Internal canonical format
- Provider adapters with capability detection
- Graceful degradation (e.g., local token counting when API unavailable)

---

## Implementation Phases

### Phase 1: Foundation
- [ ] Core conversation loop with streaming
- [ ] Claude provider adapter
- [ ] Basic token counting
- [ ] In-memory session storage
- [ ] Essential slash commands (/help, /clear, /quit)

### Phase 2: Context Management
- [ ] Token budgeting with preflight counts
- [ ] Rolling summary memory
- [ ] /compact command
- [ ] /context usage display

### Phase 3: Tool Integration
- [ ] Steroids tool definitions
- [ ] Tool policy and sandboxing
- [ ] Approval gates for dangerous operations
- [ ] File read/write tools

### Phase 4: Persistence
- [ ] Session storage
- [ ] Resume/load sessions
- [ ] Export to markdown
- [ ] Retention policies

### Phase 5: Multi-Provider
- [ ] OpenAI adapter
- [ ] Gemini adapter
- [ ] Local model support (Ollama)
- [ ] Provider switching

### Phase 6: Advanced Features
- [ ] RAG for project context
- [ ] Conversation branching
- [ ] Shared sessions
- [ ] Web UI integration

---

## References

- OpenAI Responses API: Stateful vs stateless conversation modes
- Anthropic Messages API: Streaming and token counting
- LangChain ConversationSummaryBufferMemory: Rolling summary pattern
- OWASP Top 10 for LLM Applications: Security guidance
- NIST AI RMF: Risk management framework
