#!/bin/bash
# Mock nova CLI speaking the RPC JSONL protocol, for integration tests.
# On each prompt command it emits a minimal event sequence and settles.
# The reply text embeds the hub env vars so tests can assert env injection.
reply="mock reply url=$NOVA_HUB_URL id=$NOVA_AGENT_ID token=$NOVA_HUB_TOKEN depth=$NOVA_ASK_DEPTH"
while IFS= read -r line; do
  case "$line" in
    *'"type":"prompt"'*)
      printf '{"type":"message_start","message":{"role":"assistant"}}\n'
      printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]}}\n' "$reply"
      printf '{"type":"agent_settled"}\n'
      ;;
  esac
done
