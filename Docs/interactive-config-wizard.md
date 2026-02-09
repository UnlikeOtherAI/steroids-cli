# Interactive Configuration Wizard

## Overview
Guide users through configuration with an interactive wizard that:
- Detects available providers (checks for API keys)
- Shows available models from provider APIs
- Lets user select coder and reviewer models
- Validates selections before saving

## Commands

### Full interactive setup
```bash
steroids config wizard
# or during init:
steroids init --interactive
```

### Flow
1. **Detect providers**
   ```
   Checking available providers...
   ✓ Anthropic (ANTHROPIC_API_KEY found)
   ✓ OpenAI (OPENAI_API_KEY found)
   ✗ Google (GOOGLE_API_KEY not set)
   ```

2. **Select coder provider & model**
   ```
   Select coder provider:
   > anthropic
     openai
   
   Fetching available models...
   
   Select coder model:
   > claude-sonnet-4-20250514 (recommended)
     claude-opus-4-5-20250514
     claude-haiku-4-20250514
   ```

3. **Select reviewer provider & model**
   ```
   Select reviewer provider:
   > openai
     anthropic
   
   Select reviewer model:
   > gpt-5.3-codex (recommended)
     gpt-4-turbo
   ```

4. **Confirm and save**
   ```
   Configuration:
     Coder: anthropic / claude-sonnet-4-20250514
     Reviewer: openai / gpt-5.3-codex
   
   Save to .steroids/config.yaml? [Y/n]
   ```

## TUI Components
- Arrow key navigation for selection
- Real-time model fetching with spinner
- Color-coded status (green=available, red=missing)
- Validation feedback

## Documentation
- Add to CLI/COMMANDS.md
- Add to README quickstart
- Document in config section
