#!/bin/bash
# Writes tool activity events to the telegram channel's activity file.
# Called by CC as a PostToolUse, Stop, SubagentStart, SubagentStop, or Notification hook.
# Reads JSON from stdin, extracts relevant fields, appends to activity.jsonl.

ACTIVITY_FILE="$HOME/.claude/channels/telegram/activity.jsonl"

# Read all of stdin
INPUT=$(cat)

python3 -c "
import json, sys, os, datetime

try:
    data = json.loads(sys.stdin.read()) if not '''$INPUT''' else json.loads('''$INPUT''')
except:
    sys.exit(0)

event = data.get('hook_event_name', '')
session_id = data.get('session_id', '')

entry = {'ts': datetime.datetime.utcnow().isoformat() + 'Z', 'session_id': session_id}

if event in ('PreToolUse', 'PostToolUse'):
    tool = data.get('tool_name', '')
    # Skip telegram MCP tools — they're outbound replies, not progress
    if 'telegram' in tool.lower():
        sys.exit(0)
    inp = data.get('tool_input', {})

    # Extract maximum useful detail for developers
    if tool == 'Read':
        path = inp.get('file_path', '')
        # Show relative path if possible
        detail = path.split('/')[-2] + '/' + path.split('/')[-1] if '/' in path else path
        if inp.get('offset'):
            detail += f' L{inp[\"offset\"]}'
    elif tool in ('Edit', 'Write'):
        path = inp.get('file_path', '')
        detail = path.split('/')[-2] + '/' + path.split('/')[-1] if '/' in path else path
    elif tool == 'Bash':
        # Show description if available, otherwise first 60 chars of command
        detail = inp.get('description', '') or inp.get('command', '')[:60]
    elif tool == 'Grep':
        pat = inp.get('pattern', '')[:30]
        path = inp.get('path', '').split('/')[-1] if inp.get('path') else ''
        detail = f'\"{pat}\"' + (f' in {path}' if path else '')
    elif tool == 'Glob':
        detail = inp.get('pattern', '')
    elif tool == 'Agent':
        detail = inp.get('description', '')[:50]
    elif tool == 'WebSearch':
        detail = inp.get('query', '')[:50]
    elif tool == 'WebFetch':
        url = inp.get('url', '')
        # Show just the domain
        try:
            from urllib.parse import urlparse
            detail = urlparse(url).netloc
        except:
            detail = url[:40]
    elif tool == 'LS':
        detail = inp.get('path', '').split('/')[-1] if inp.get('path') else '.'
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
