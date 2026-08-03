#!/bin/bash
# Mock nova CLI speaking the RPC JSONL protocol, for integration tests.
# On each prompt command it emits a minimal event sequence and settles.
# The reply text embeds the hub env vars so tests can assert env injection.
if [[ "$*" == *"--list-sessions"* ]]; then
  printf '{"sessions":[{"sessionId":"mock-parent","cwd":"/tmp","sessionFile":"/tmp/mock-parent.jsonl","name":"Parent","parentSessionId":null,"createdAt":"2026-01-01T00:00:00Z","modifiedAt":"2026-01-01T00:00:00Z","messageCount":2,"firstMessage":"parent"},{"sessionId":"mock-child","cwd":"/tmp","sessionFile":"/tmp/mock-child.jsonl","name":"Child","parentSessionId":"mock-parent","createdAt":"2026-01-02T00:00:00Z","modifiedAt":"2026-01-02T00:00:00Z","messageCount":1,"firstMessage":"child"}]}\n'
  exit 0
fi
if [[ "$*" == *"--session-id"* && "$*" == *"--session "* ]]; then
  printf '%s\n' 'Error: --session-id cannot be combined with --session' >&2
  exit 2
fi
reply="mock reply url=$NOVA_HUB_URL id=$NOVA_AGENT_ID token=$NOVA_HUB_TOKEN depth=$NOVA_ASK_DEPTH"
while IFS= read -r line; do
  case "$line" in
    *'"type":"get_messages"'*)
      printf '{"type":"response","command":"get_messages","success":true,"data":{"messages":[{"role":"user","content":[{"type":"text","text":"restored question"}],"timestamp":1},{"role":"assistant","content":[{"type":"text","text":"restored answer"}],"timestamp":2}]}}\n'
      ;;
    *'"type":"prompt"'*)
      printf '{"type":"message_start","message":{"role":"assistant"}}\n'
      printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]}}\n' "$reply"
      printf '{"type":"agent_settled"}\n'
      ;;
  esac
done
