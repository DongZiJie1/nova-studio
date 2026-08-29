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
last_depth=0
while IFS= read -r line; do
  # The host injects the owning agent id as the first agentId member (serde
  #_json's BTreeMap orders it before payload fields). Payloads such as batch
  # results can embed other agents' agentId, so take the first occurrence.
  agent_id=$(printf '%s' "$line" | grep -o '"agentId":"[^"]*"' | head -1 | sed 's/"agentId":"\([^"]*\)"/\1/')
  request_id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
  if [[ "$line" == *'"type":"append_custom_message"'* ]]; then
    printf '{"type":"response","id":"%s","command":"append_custom_message","success":true,"agentId":"%s","data":{"appended":true}}\n' "$request_id" "$agent_id"
    continue
  fi
  case "$line" in
    *'"type":"agent_create"'*)
      last_depth=$(printf '%s' "$line" | sed -n 's/.*"depth":\([0-9]*\).*/\1/p')
      printf '{"type":"response","command":"agent_create","success":true,"agentId":"%s"}\n' "$agent_id"
      ;;
    *'"type":"agent_stop"'*|*'"type":"agent_cancel"'*|*'"type":"agent_force_stop"'*|*'"type":"agent_retry"'*)
      command=$(printf '%s' "$line" | sed -n 's/.*"type":"\([a-z_]*\)".*/\1/p')
      printf '{"type":"response","command":"%s","success":true,"agentId":"%s"}\n' "$command" "$agent_id"
      ;;
    *'"type":"steer"'*)
      printf '{"type":"response","command":"steer","success":true,"agentId":"%s"}\n' "$agent_id"
      ;;
    *'"type":"get_messages"'*)
      printf '{"type":"response","command":"get_messages","success":true,"agentId":"%s","data":{"messages":[{"role":"user","content":[{"type":"text","text":"restored question"}],"timestamp":1},{"role":"assistant","content":[{"type":"text","text":"restored answer"}],"timestamp":2}]}}\n' "$agent_id"
      ;;
    *'"type":"prompt"'*)
      reply="mock reply url=$NOVA_HUB_URL id=$agent_id token=$NOVA_HUB_TOKEN depth=$last_depth"
      if [[ "$line" == *"NOVA_MOCK_SLOW"* ]]; then
        # Tasks marked NOVA_MOCK_SLOW stay in-flight so tests can cancel
        # them. Emit from a background subshell so the host read loop keeps
        # processing later commands (cancel, append, ...) meanwhile.
        (
          sleep 30
          printf '{"type":"message_start","agentId":"%s","message":{"role":"assistant"}}\n' "$agent_id"
          printf '{"type":"message_end","agentId":"%s","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]}}\n' "$agent_id" "$reply"
          printf '{"type":"agent_settled","agentId":"%s"}\n' "$agent_id"
        ) &
        continue
      fi
      if [[ "$line" == *"NOVA_MOCK_TOOLS"* ]]; then
        # Simulate real tool activity so tests can assert trace-based
        # cross-checking of the structured task result.
        printf '{"type":"tool_execution_start","agentId":"%s","toolCallId":"tool-1","toolName":"edit","args":{"path":"/tmp/mock-changed.ts"}}\n' "$agent_id"
        printf '{"type":"tool_execution_end","agentId":"%s","toolCallId":"tool-1","toolName":"edit","isError":false}\n' "$agent_id"
        if [[ "$line" != *"NOVA_MOCK_TOOLS_FAIL"* ]]; then
          printf '{"type":"tool_execution_start","agentId":"%s","toolCallId":"tool-2","toolName":"bash","args":{"command":"npm test"}}\n' "$agent_id"
          printf '{"type":"tool_execution_end","agentId":"%s","toolCallId":"tool-2","toolName":"bash","isError":false}\n' "$agent_id"
        fi
      fi
      if [[ "$line" == *"NOVA_MOCK_TOOLS_FAIL"* ]]; then
        printf '{"type":"tool_execution_start","agentId":"%s","toolCallId":"tool-3","toolName":"bash","args":{"command":"npm test"}}\n' "$agent_id"
        printf '{"type":"tool_execution_end","agentId":"%s","toolCallId":"tool-3","toolName":"bash","isError":true}\n' "$agent_id"
      fi
      printf '{"type":"message_start","agentId":"%s","message":{"role":"assistant"}}\n' "$agent_id"
      printf '{"type":"message_end","agentId":"%s","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]}}\n' "$agent_id" "$reply"
      printf '{"type":"agent_settled","agentId":"%s"}\n' "$agent_id"
      ;;
    *'"type":"summarize_task_result"'*)
      printf '{"type":"response","id":"%s","command":"summarize_task_result","success":true,"agentId":"%s","data":{"text":"{\\"summary\\":\\"mock summary\\",\\"changedFiles\\":[],\\"verification\\":[\\"mock check\\"],\\"remainingRisks\\":[]}"}}\n' "$request_id" "$agent_id"
      ;;
  esac
done
