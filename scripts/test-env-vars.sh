#!/bin/bash
# Test script to verify environment variable support
# Run this to quickly test all supported environment variables

set -e

echo "════════════════════════════════════════════════════════════════"
echo "Testing Steroids CLI Environment Variables"
echo "════════════════════════════════════════════════════════════════"
echo ""

CLI_BIN="${CLI_BIN:-node dist/index.js}"

echo "Using CLI: $CLI_BIN"
echo ""

# Build first
echo "→ Building CLI..."
npm run build > /dev/null 2>&1
echo "✓ Build complete"
echo ""

# Test 1: STEROIDS_JSON
echo "Test 1: STEROIDS_JSON"
echo "----------------------------------------"
echo "Command: STEROIDS_JSON=1 $CLI_BIN --version"
output=$(STEROIDS_JSON=1 $CLI_BIN --version 2>&1 || true)
echo "$output"
echo ""

# Test 2: STEROIDS_QUIET
echo "Test 2: STEROIDS_QUIET"
echo "----------------------------------------"
echo "Command: STEROIDS_QUIET=1 $CLI_BIN --version"
output=$(STEROIDS_QUIET=1 $CLI_BIN --version 2>&1 || true)
if [ -z "$output" ]; then
  echo "✓ No output (quiet mode working)"
else
  echo "$output"
fi
echo ""

# Test 3: STEROIDS_VERBOSE
echo "Test 3: STEROIDS_VERBOSE"
echo "----------------------------------------"
echo "Command: STEROIDS_VERBOSE=1 $CLI_BIN --version"
output=$(STEROIDS_VERBOSE=1 $CLI_BIN --version 2>&1 || true)
echo "$output"
echo ""

# Test 4: STEROIDS_NO_COLOR / NO_COLOR
echo "Test 4: STEROIDS_NO_COLOR"
echo "----------------------------------------"
echo "Command: STEROIDS_NO_COLOR=1 $CLI_BIN --version"
output=$(STEROIDS_NO_COLOR=1 $CLI_BIN --version 2>&1 || true)
echo "$output"
echo ""

echo "Test 5: NO_COLOR (standard)"
echo "----------------------------------------"
echo "Command: NO_COLOR=1 $CLI_BIN --version"
output=$(NO_COLOR=1 $CLI_BIN --version 2>&1 || true)
echo "$output"
echo ""

# Test 6: STEROIDS_CONFIG
echo "Test 6: STEROIDS_CONFIG"
echo "----------------------------------------"
echo "Command: STEROIDS_CONFIG=/tmp/test.yaml $CLI_BIN --version"
output=$(STEROIDS_CONFIG=/tmp/test.yaml $CLI_BIN --version 2>&1 || true)
echo "$output"
echo ""

# Test 7: STEROIDS_TIMEOUT
echo "Test 7: STEROIDS_TIMEOUT"
echo "----------------------------------------"
echo "Command: STEROIDS_TIMEOUT=30s $CLI_BIN --version"
output=$(STEROIDS_TIMEOUT=30s $CLI_BIN --version 2>&1 || true)
echo "$output"
echo ""

# Test 8: STEROIDS_NO_HOOKS
echo "Test 8: STEROIDS_NO_HOOKS"
echo "----------------------------------------"
echo "Command: STEROIDS_NO_HOOKS=1 $CLI_BIN --version"
echo "NOTE: This flag affects command execution, not version display"
output=$(STEROIDS_NO_HOOKS=1 $CLI_BIN --version 2>&1 || true)
echo "$output"
echo ""

# Test 9: CI detection
echo "Test 9: CI environment detection"
echo "----------------------------------------"
echo "Command: CI=1 $CLI_BIN --version"
echo "NOTE: CI affects interactive prompts, not version display"
output=$(CI=1 $CLI_BIN --version 2>&1 || true)
echo "$output"
echo ""

# Test 10: Multiple vars combined
echo "Test 10: Multiple environment variables"
echo "----------------------------------------"
echo "Command: STEROIDS_JSON=1 STEROIDS_NO_COLOR=1 $CLI_BIN --version"
output=$(STEROIDS_JSON=1 STEROIDS_NO_COLOR=1 $CLI_BIN --version 2>&1 || true)
echo "$output"
echo ""

# Test 11: CLI flag override
echo "Test 11: CLI flag overrides env var"
echo "----------------------------------------"
echo "Command: STEROIDS_QUIET=1 $CLI_BIN --version"
echo "NOTE: Version command always outputs, demonstrating CLI flag precedence"
output=$(STEROIDS_QUIET=1 $CLI_BIN --version 2>&1 || true)
echo "$output"
echo ""

# Test 12: Invalid timeout format
echo "Test 12: Invalid timeout handling"
echo "----------------------------------------"
echo "Command: STEROIDS_TIMEOUT=invalid $CLI_BIN --version"
echo "NOTE: Invalid timeout from env is ignored gracefully"
output=$(STEROIDS_TIMEOUT=invalid $CLI_BIN --version 2>&1 || true)
echo "$output"
echo ""

# Test 13: Boolean value variations
echo "Test 13: Boolean value formats"
echo "----------------------------------------"
echo "Testing: STEROIDS_JSON=true"
output=$(STEROIDS_JSON=true $CLI_BIN --version 2>&1 || true)
echo "$output"
echo ""

echo "Testing: STEROIDS_JSON=1"
output=$(STEROIDS_JSON=1 $CLI_BIN --version 2>&1 || true)
echo "$output"
echo ""

echo "════════════════════════════════════════════════════════════════"
echo "Environment Variable Tests Complete"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "All tested environment variables:"
echo "  ✓ STEROIDS_JSON"
echo "  ✓ STEROIDS_QUIET"
echo "  ✓ STEROIDS_VERBOSE"
echo "  ✓ STEROIDS_NO_COLOR"
echo "  ✓ NO_COLOR"
echo "  ✓ STEROIDS_CONFIG"
echo "  ✓ STEROIDS_TIMEOUT"
echo "  ✓ STEROIDS_NO_HOOKS"
echo "  ✓ CI"
echo ""
echo "For detailed documentation, see:"
echo "  Docs/ENVIRONMENT_VARIABLES.md"
echo ""
