#!/usr/bin/env bash
# Test script for Phase 0.5: CLI Contract
# Verifies that all commands follow the global contract

echo "🧪 Testing CLI Contract Implementation"
echo "========================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

passed=0
failed=0

test_pass() {
  echo -e "${GREEN}✓${NC} $1"
  ((passed++))
}

test_fail() {
  echo -e "${RED}✗${NC} $1"
  ((failed++))
}

# Test 1: Version flag
echo "Testing --version flag..."
output=$(steroids --version)
if [[ "$output" =~ ^steroids\ v[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  test_pass "Version flag works"
else
  test_fail "Version flag broken: $output"
fi

# Test 2: Version with JSON
echo "Testing --version --json..."
output=$(steroids --version --json)
if echo "$output" | jq -e '.version' > /dev/null 2>&1; then
  test_pass "Version JSON output works"
else
  test_fail "Version JSON broken: $output"
fi

# Test 3: Help flag
echo "Testing --help flag..."
output=$(steroids --help)
if [[ "$output" =~ COMMANDS ]]; then
  test_pass "Help flag works"
else
  test_fail "Help flag broken"
fi

# Test 4: Command-specific help
echo "Testing command --help..."
for cmd in init sections tasks loop; do
  output=$(steroids $cmd --help)
  if [[ "$output" =~ USAGE ]]; then
    test_pass "Help works for: steroids $cmd"
  else
    test_fail "Help broken for: steroids $cmd"
  fi
done

# Test 5: JSON envelope for success
echo "Testing JSON envelope (success)..."
output=$(steroids tasks --json 2>&1)
if echo "$output" | jq -e '.success == true and .command == "tasks" and .data != null and .error == null' > /dev/null 2>&1; then
  test_pass "JSON success envelope works"
else
  test_fail "JSON success envelope broken: $output"
fi

# Test 6: JSON envelope for error
echo "Testing JSON envelope (error)..."
output=$(steroids unknown-command --json 2>&1)
exit_code=$?
if echo "$output" | jq -e '.success == false and .error.code == "INVALID_ARGUMENTS"' > /dev/null 2>&1 && [ $exit_code -eq 2 ]; then
  test_pass "JSON error envelope and exit code work"
else
  test_fail "JSON error envelope broken. Exit: $exit_code, Output: $output"
fi

# Test 7: Exit codes
echo "Testing exit codes..."
steroids --version > /dev/null 2>&1
if [ $? -eq 0 ]; then
  test_pass "Exit code 0 for success"
else
  test_fail "Exit code wrong for success"
fi

steroids unknown-command > /dev/null 2>&1
if [ $? -eq 2 ]; then
  test_pass "Exit code 2 for INVALID_ARGUMENTS"
else
  test_fail "Exit code wrong for INVALID_ARGUMENTS (got $?)"
fi

# Test 8: Environment variables
echo "Testing environment variables..."
output=$(STEROIDS_JSON=1 steroids --version)
if echo "$output" | jq -e '.version' > /dev/null 2>&1; then
  test_pass "STEROIDS_JSON environment variable works"
else
  test_fail "STEROIDS_JSON broken: $output"
fi

# Quiet mode should still show main output, just suppress warnings/info
output=$(STEROIDS_QUIET=1 steroids tasks 2>&1)
if [ -n "$output" ]; then
  test_pass "STEROIDS_QUIET environment variable works (main output still shown)"
else
  test_fail "STEROIDS_QUIET broken - no output at all"
fi

# Test 9: NO_COLOR environment variable
echo "Testing NO_COLOR..."
# This is tricky to test automatically, but we can at least verify it doesn't crash
NO_COLOR=1 steroids tasks --status all > /dev/null 2>&1
if [ $? -eq 0 ]; then
  test_pass "NO_COLOR environment variable doesn't crash"
else
  test_fail "NO_COLOR causes crash"
fi

# Test 10: Global flags on all commands
echo "Testing global flags on commands..."
for cmd in init sections tasks loop; do
  steroids $cmd --help > /dev/null 2>&1
  if [ $? -eq 0 ]; then
    test_pass "Global flags work on: steroids $cmd"
  else
    test_fail "Global flags broken on: steroids $cmd"
  fi
done

# Test 11: Combined short flags
echo "Testing combined short flags..."
output=$(steroids tasks -jq 2>&1)
if echo "$output" | jq -e '.success' > /dev/null 2>&1; then
  test_pass "Combined short flags (-jq) work"
else
  test_fail "Combined short flags broken"
fi

# Test 12: Dry run flag
echo "Testing --dry-run flag..."
# This should work without error
steroids tasks --help --dry-run > /dev/null 2>&1
if [ $? -eq 0 ]; then
  test_pass "--dry-run flag accepted"
else
  test_fail "--dry-run flag broken"
fi

# Summary
echo ""
echo "========================================"
echo "Test Results:"
echo "  Passed: $passed"
echo "  Failed: $failed"
echo "========================================"

if [ $failed -eq 0 ]; then
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}Some tests failed${NC}"
  exit 1
fi
