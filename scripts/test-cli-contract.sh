#!/bin/bash
# Test script for CLI contract (Phase 0.5)
# Validates that all global flags, JSON output, exit codes, and env vars work correctly

set +e  # Don't exit on first error - we want to run all tests

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Track results
PASS=0
FAIL=0

pass() {
  echo -e "${GREEN}✓${NC} $1"
  ((PASS++))
}

fail() {
  echo -e "${RED}✗${NC} $1"
  ((FAIL++))
}

warn() {
  echo -e "${YELLOW}⚠${NC} $1"
}

section() {
  echo
  echo "═══════════════════════════════════════════════════════════════"
  echo "$1"
  echo "═══════════════════════════════════════════════════════════════"
}

# Test 1: Global flags parser
section "Test 1: Global Flags"

# Test --help flag
if steroids --help > /dev/null 2>&1; then
  pass "--help flag works"
else
  fail "--help flag failed"
fi

# Test --version flag
if steroids --version | grep -q "steroids v"; then
  pass "--version flag works"
else
  fail "--version flag failed"
fi

# Test --json flag
if steroids --version --json | grep -q '"version"'; then
  pass "--json flag works"
else
  fail "--json flag failed"
fi

# Test combined short flags
if steroids tasks --help > /dev/null 2>&1; then
  pass "Command-specific --help works"
else
  fail "Command-specific --help failed"
fi

# Test 2: JSON Output Envelope
section "Test 2: JSON Output Envelope"

# Test success envelope
JSON_VERSION=$(steroids --version --json)
if echo "$JSON_VERSION" | jq -e '.version' > /dev/null 2>&1; then
  pass "JSON version output has correct structure"
else
  fail "JSON version output malformed"
fi

# Test error envelope (unknown command)
ERROR_JSON=$(steroids nonexistent --json 2>&1 || true)
if echo "$ERROR_JSON" | jq -e '.success == false' > /dev/null 2>&1; then
  pass "JSON error envelope has success=false"
else
  fail "JSON error envelope missing success field"
fi

if echo "$ERROR_JSON" | jq -e '.error.code' > /dev/null 2>&1; then
  pass "JSON error envelope has error.code"
else
  fail "JSON error envelope missing error.code"
fi

if echo "$ERROR_JSON" | jq -e '.error.message' > /dev/null 2>&1; then
  pass "JSON error envelope has error.message"
else
  fail "JSON error envelope missing error.message"
fi

# Test 3: Exit Codes
section "Test 3: Exit Codes"

# Test success exit code
steroids --version > /dev/null 2>&1
if [ $? -eq 0 ]; then
  pass "Success returns exit code 0"
else
  fail "Success did not return exit code 0"
fi

# Test invalid arguments exit code
steroids nonexistent > /dev/null 2>&1 || EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 2 ]; then
  pass "Invalid arguments returns exit code 2"
else
  fail "Invalid arguments returned exit code $EXIT_CODE (expected 2)"
fi

# Test 4: Environment Variables
section "Test 4: Environment Variables"

# Test STEROIDS_JSON
JSON_OUTPUT=$(STEROIDS_JSON=1 steroids --version 2>&1)
if echo "$JSON_OUTPUT" | jq -e '.version' > /dev/null 2>&1; then
  pass "STEROIDS_JSON env var works"
else
  fail "STEROIDS_JSON env var failed"
fi

# Test NO_COLOR
COLOR_OUTPUT=$(NO_COLOR=1 steroids --help 2>&1)
if [ $? -eq 0 ]; then
  pass "NO_COLOR env var accepted (no crash)"
else
  fail "NO_COLOR env var caused error"
fi

# Test 5: Help System
section "Test 5: Help System"

# Test help has all required sections
HELP_OUTPUT=$(steroids tasks --help)

if echo "$HELP_OUTPUT" | grep -q "USAGE:"; then
  pass "Help includes USAGE section"
else
  fail "Help missing USAGE section"
fi

if echo "$HELP_OUTPUT" | grep -q "OPTIONS:"; then
  pass "Help includes OPTIONS section"
else
  fail "Help missing OPTIONS section"
fi

if echo "$HELP_OUTPUT" | grep -q "GLOBAL OPTIONS:"; then
  pass "Help includes GLOBAL OPTIONS section"
else
  fail "Help missing GLOBAL OPTIONS section"
fi

if echo "$HELP_OUTPUT" | grep -q "EXAMPLES:"; then
  pass "Help includes EXAMPLES section"
else
  fail "Help missing EXAMPLES section"
fi

if echo "$HELP_OUTPUT" | grep -q "EXIT CODES:"; then
  pass "Help includes EXIT CODES section"
else
  fail "Help missing EXIT CODES section"
fi

if echo "$HELP_OUTPUT" | grep -q "ENVIRONMENT VARIABLES:"; then
  pass "Help includes ENVIRONMENT VARIABLES section"
else
  fail "Help missing ENVIRONMENT VARIABLES section"
fi

# Test 6: Interactive Detection
section "Test 6: Interactive Detection"

# When running in script, should not be interactive
# This is hard to test directly, but we can verify the code exists
if grep -q "isInteractive" src/cli/interactive.ts; then
  pass "Interactive detection code exists"
else
  fail "Interactive detection code missing"
fi

# Test 7: Colored Output
section "Test 7: Colored Output"

if grep -q "shouldDisableColors" src/cli/colors.ts; then
  pass "Color disable logic exists"
else
  fail "Color disable logic missing"
fi

# Test 8: All Commands Have Help
section "Test 8: All Commands Have Help"

COMMANDS="init sections tasks loop runners config hooks health scan backup logs gc completion locks dispute purge git projects stats llm about"

for cmd in $COMMANDS; do
  if steroids $cmd --help > /dev/null 2>&1; then
    pass "Command '$cmd' has help"
  else
    fail "Command '$cmd' missing help"
  fi
done

# Summary
section "Summary"

TOTAL=$((PASS + FAIL))
echo "Passed: $PASS / $TOTAL"
echo "Failed: $FAIL / $TOTAL"

if [ $FAIL -eq 0 ]; then
  echo
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
else
  echo
  echo -e "${RED}Some tests failed${NC}"
  exit 1
fi
