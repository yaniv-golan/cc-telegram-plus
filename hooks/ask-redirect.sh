#!/bin/bash
# Routes AskUserQuestion to Telegram when conditions are met.
# Falls through to terminal (exit 0) for unsupported cases.

STATE_DIR="$HOME/.claude/channels/telegram"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Only proceed if this CC instance owns the active Telegram session
if ! python3 "$SCRIPT_DIR/lib/session-guard.py" 2>/dev/null; then
  exit 0
fi

# Read stdin to temp file (safe for any JSON content)
TMPINPUT=$(mktemp)
trap "rm -f '$TMPINPUT'" EXIT
cat > "$TMPINPUT"

python3 - "$TMPINPUT" "$STATE_DIR" << 'PYEOF'
import json, sys, os, time, urllib.request

input_file = sys.argv[1]
state_dir = sys.argv[2]

env_file = os.path.join(state_dir, ".env")
access_file = os.path.join(state_dir, "access.json")
pending_file = os.path.join(state_dir, "ask-pending.json")
reply_file = os.path.join(state_dir, "ask-reply.json")

def exit_allow():
    sys.exit(0)

def exit_deny(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason
        }
    }))
    sys.exit(0)

# 1. Parse hook input
try:
    data = json.load(open(input_file))
except:
    exit_allow()

questions = data.get("tool_input", {}).get("questions", [])

# 2. Guard: single question
if len(questions) != 1:
    exit_allow()

question = questions[0]

# 3. Guard: single-select
if question.get("multiSelect"):
    exit_allow()

# 4. Guard: single allowFrom user
try:
    access = json.load(open(access_file))
except:
    exit_allow()

allow_from = access.get("allowFrom", [])
if len(allow_from) != 1:
    exit_allow()

# In Telegram, a user's ID is also their DM chat_id
chat_id = allow_from[0]

# 5. Session guard is handled in bash (session-guard.py) before this block

# 6. Read bot token
token = None
try:
    for line in open(env_file):
        if line.strip().startswith("TELEGRAM_BOT_TOKEN="):
            token = line.strip().split("=", 1)[1]
            break
except:
    pass

if not token:
    exit_allow()

# 7. Generate nonce
nonce = os.urandom(4).hex()

# 8. Clean up stale files
for f in [pending_file, reply_file]:
    try: os.unlink(f)
    except: pass

# 9. Format message
q_text = question.get("question", "")
header = question.get("header", "")
options = question.get("options", [])

msg_text = f"\u2753 {header}\n\n{q_text}" if header else f"\u2753 {q_text}"

# Build inline keyboard
inline_keyboard = None
if options:
    inline_keyboard = []
    for i, opt in enumerate(options):
        label = opt.get("label", f"Option {i}")
        desc = opt.get("description", "")
        btn_text = f"{label} \u2014 {desc}" if desc else label
        inline_keyboard.append([{"text": btn_text, "callback_data": f"ask_answer_{i}"}])

# 10. Send to Telegram (BEFORE writing ask-pending.json — ordering constraint)
payload = {"chat_id": chat_id, "text": msg_text}
if inline_keyboard:
    payload["reply_markup"] = {"inline_keyboard": inline_keyboard}

try:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
    if not resp.get("ok"):
        exit_allow()
    sent_msg_id = resp["result"]["message_id"]
except:
    exit_allow()

# 11. Write ask-pending.json (AFTER successful send)
pending = {
    "nonce": nonce,
    "chatId": chat_id,
    "sentMessageId": sent_msg_id,
    "options": options if options else None,
    "ts": int(time.time() * 1000),
}
tmp = pending_file + ".tmp"
with open(tmp, "w") as f:
    json.dump(pending, f)
os.rename(tmp, pending_file)

# 12. Poll for reply (no timeout — blocks like terminal AskUserQuestion)
# Note: hook timeout in hooks.json is 3600s (1 hour). If user doesn't respond
# within that time, CC kills the hook and the tool call fails.
while True:
    time.sleep(1)
    try:
        reply = json.load(open(reply_file))
        if reply.get("nonce") == nonce:
            break
        # Wrong nonce — stale, delete and keep waiting
        try: os.unlink(reply_file)
        except: pass
    except:
        pass

# 13. Clean up
answer = reply.get("answer", "")
for f in [pending_file, reply_file]:
    try: os.unlink(f)
    except: pass

# 14. Return deny with answer
exit_deny(f"AskUserQuestion was answered via Telegram. The user selected: {answer}. Proceed with this answer as if the user had responded in the terminal.")
PYEOF

# If python3 exits non-zero, allow terminal prompt
exit 0
