#!/bin/bash
# Test hook for AskUserQuestion — logs payload + returns deny with canned answer.
# Install: add to project .claude/settings.local.json (see instructions below)
# Remove: delete the PreToolUse entry from settings.local.json after testing

LOG_FILE="/tmp/ask-user-question-test.json"

# Read full stdin
INPUT=$(cat)

# Log the complete payload for Test B
echo "$INPUT" | python3 -m json.tool > "$LOG_FILE" 2>/dev/null || echo "$INPUT" > "$LOG_FILE"

# Test A: return deny with a canned answer
cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "AskUserQuestion was answered externally. The user selected: Option B. Proceed with this answer as if the user had responded in the terminal."
  }
}
EOF
