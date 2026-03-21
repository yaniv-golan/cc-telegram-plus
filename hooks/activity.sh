#!/bin/bash
# Writes tool activity events to the telegram channel's activity file.
# Called by CC as a PostToolUse, Stop, SubagentStart, SubagentStop, or Notification hook.
# Reads JSON from stdin, extracts relevant fields, appends to activity.jsonl.

ACTIVITY_FILE="$HOME/.claude/channels/telegram/activity.jsonl"

# Read stdin (CC passes hook data as JSON)
INPUT=$(cat)

# Extract fields using python3 (available on macOS/Linux)
python3 -c "
import json, sys, os
try:
    data = json.loads('''$INPUT''')
except:
    # Fallback: read from original stdin data
    try:
        data = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    except:
        sys.exit(0)

event = data.get('hook_event_name', '')
session_id = data.get('session_id', '')

entry = {'ts': __import__('datetime').datetime.utcnow().isoformat() + 'Z', 'session_id': session_id}

if event == 'PostToolUse':
    tool = data.get('tool_name', '')
    # Skip our own telegram tools — they're outbound, not progress
    if tool.startswith('mcp__plugin_telegram') or tool.startswith('mcp__telegram'):
        sys.exit(0)
    detail = ''
    inp = data.get('tool_input', {})
    if tool == 'Read':
        detail = inp.get('file_path', '').split('/')[-1]
    elif tool == 'Edit' or tool == 'Write':
        detail = inp.get('file_path', '').split('/')[-1]
    elif tool == 'Bash':
        cmd = inp.get('command', '')
        detail = inp.get('description', '') or cmd[:40]
    elif tool == 'Grep':
        detail = inp.get('pattern', '')[:30]
    elif tool == 'Glob':
        detail = inp.get('pattern', '')[:30]
    elif tool == 'Agent':
        detail = inp.get('description', '')[:40]
    elif tool.startswith('mcp__'):
        detail = tool.split('__')[-1]
    else:
        detail = ''
    entry['type'] = 'tool'
    entry['tool'] = tool
    entry['detail'] = detail

elif event == 'Stop':
    entry['type'] = 'stop'

elif event == 'SubagentStart':
    entry['type'] = 'subagent_start'
    entry['agent_type'] = data.get('agent_type', '')

elif event == 'SubagentStop':
    entry['type'] = 'subagent_stop'
    entry['agent_type'] = data.get('agent_type', '')

elif event == 'Notification':
    ntype = data.get('notification_type', '')
    if ntype == 'permission_prompt':
        entry['type'] = 'permission'
        entry['message'] = data.get('message', '')[:100]
    else:
        sys.exit(0)

else:
    sys.exit(0)

os.makedirs(os.path.dirname('$ACTIVITY_FILE'), exist_ok=True)
with open('$ACTIVITY_FILE', 'a') as f:
    f.write(json.dumps(entry) + '\n')
" 2>/dev/null

exit 0
