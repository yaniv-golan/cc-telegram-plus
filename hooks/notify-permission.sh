#!/bin/bash
# Sends a permission prompt notification directly to Telegram via curl.
# Called by CC as a Notification hook (matcher: permission_prompt).
# Reads JSON from stdin, sends message to all allowFrom users.

ENV_FILE="$HOME/.claude/channels/telegram/.env"
ACCESS_FILE="$HOME/.claude/channels/telegram/access.json"

# Read stdin
INPUT=$(cat)

# Also write to activity file for the progress watcher
ACTIVITY_FILE="$HOME/.claude/channels/telegram/activity.jsonl"

python3 -c "
import json, sys, os, datetime, subprocess

try:
    data = json.loads('''$(echo "$INPUT" | sed "s/'/'\\\\''/g")''')
except:
    sys.exit(0)

ntype = data.get('notification_type', '')
if ntype != 'permission_prompt':
    sys.exit(0)

message = data.get('message', 'Permission needed')
title = data.get('title', '')

# Read bot token
token = None
env_path = os.path.expanduser('$ENV_FILE')
try:
    for line in open(env_path):
        if line.strip().startswith('TELEGRAM_BOT_TOKEN='):
            token = line.strip().split('=', 1)[1]
            break
except:
    pass

if not token:
    sys.exit(0)

# Read allowFrom users
access_path = os.path.expanduser('$ACCESS_FILE')
try:
    access = json.load(open(access_path))
    chat_ids = access.get('allowFrom', [])
except:
    sys.exit(0)

if not chat_ids:
    sys.exit(0)

# Format the message
text = f'\u26a0\ufe0f <b>Approval needed</b>\n{message}'

# Send to each allowFrom user and track message IDs for cleanup
sent_messages = []
for chat_id in chat_ids:
    try:
        import urllib.request
        url = f'https://api.telegram.org/bot{token}/sendMessage'
        payload = json.dumps({
            'chat_id': chat_id,
            'text': text,
            'parse_mode': 'HTML',
        }).encode()
        req = urllib.request.Request(url, data=payload, headers={'Content-Type': 'application/json'})
        resp = json.loads(urllib.request.urlopen(req, timeout=5).read())
        if resp.get('ok') and resp.get('result', {}).get('message_id'):
            sent_messages.append({'chat_id': chat_id, 'message_id': resp['result']['message_id']})
    except:
        pass

# Write to activity file with sent message IDs so watcher can clean up
entry = {
    'ts': datetime.datetime.utcnow().isoformat() + 'Z',
    'session_id': data.get('session_id', ''),
    'type': 'permission',
    'message': message[:100],
    'sent_messages': sent_messages,
}
try:
    with open(os.path.expanduser('$ACTIVITY_FILE'), 'a') as f:
        f.write(json.dumps(entry) + '\n')
except:
    pass
" 2>/dev/null

exit 0
