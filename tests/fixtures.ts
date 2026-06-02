export function otlpMetricBatch(sessionId = "session-a") {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "claude-code" } },
            { key: "session.id", value: { stringValue: sessionId } },
            { key: "user.id", value: { stringValue: "device-123" } },
            { key: "user.email", value: { stringValue: "dev@example.com" } },
            { key: "model", value: { stringValue: "claude-sonnet-4-5" } }
          ]
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.token.usage",
                unit: "tokens",
                sum: {
                  dataPoints: [
                    {
                      timeUnixNano: "1760000000000000000",
                      asInt: "1200",
                      attributes: [{ key: "type", value: { stringValue: "input" } }]
                    },
                    {
                      timeUnixNano: "1760000000000000000",
                      asInt: "350",
                      attributes: [{ key: "type", value: { stringValue: "output" } }]
                    }
                  ]
                }
              },
              {
                name: "claude_code.cost.usage",
                unit: "USD",
                sum: {
                  dataPoints: [
                    {
                      timeUnixNano: "1760000000000000000",
                      asDouble: 0.024,
                      attributes: []
                    }
                  ]
                }
              },
              {
                name: "ignored.metric",
                sum: { dataPoints: [{ asInt: "99" }] }
              }
            ]
          }
        ]
      }
    ]
  };
}

// A one-line Claude Code transcript (JSONL) carrying token usage (+ optional cost), keyed by the same
// `sessionId` Claude Code reports over OTel — so it can be matched to an OTel session.
export function jsonlTranscript(
  sessionId = "session-a",
  usage: { input_tokens?: number; output_tokens?: number } = { input_tokens: 999, output_tokens: 111 },
  costUsd?: number
) {
  const line: Record<string, unknown> = {
    type: "assistant",
    sessionId,
    timestamp: "2025-10-09T12:00:00.000Z",
    message: { model: "claude-sonnet-4-5", usage }
  };
  if (costUsd !== undefined) line.cost_usd = costUsd;
  return `${JSON.stringify(line)}\n`;
}

export function otlpLogBatch() {
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [{ timeUnixNano: "1760000000000000000", body: { stringValue: "hello" } }]
          }
        ]
      }
    ]
  };
}

// A Codex-style OTLP/JSON logs batch: two named log records (one repeated) so grouping by event name
// is testable, with attributes + a body to capture. Codex's native telemetry is logs-only.
// A realistic Codex logs-only OTLP batch. Codex's tracing appender sets the loose `name` to a Rust
// source location and the true event id to the `event.name` attribute — so this also exercises the
// parseOtelLogRecords precedence (event.name must win over `name`). Token usage rides on the
// response.completed `codex.sse_event` only; the delta sse_event and the api_request carry none.
export function codexLogBatch() {
  const sseEvent = (kind: string, tokens: Array<{ key: string; value: unknown }>, ts: string) => ({
    eventName: "event otel/src/events/session_telemetry.rs:778", // Codex pollutes the top-level field
    severityText: "INFO",
    timeUnixNano: ts,
    attributes: [
      { key: "session.id", value: { stringValue: "codex-session-1" } },
      { key: "event.name", value: { stringValue: "codex.sse_event" } },
      { key: "event.kind", value: { stringValue: kind } },
      { key: "model", value: { stringValue: "gpt-5.5" } },
      { key: "user.email", value: { stringValue: "codex@example.com" } },
      ...tokens
    ],
    body: { stringValue: kind }
  });
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex_cli_rs" } }] },
        scopeLogs: [
          {
            logRecords: [
              sseEvent(
                "response.completed",
                [
                  { key: "input_token_count", value: { intValue: 1000 } }, // includes the 200 cached
                  { key: "cached_token_count", value: { intValue: 200 } },
                  { key: "output_token_count", value: { intValue: 300 } }
                ],
                "1760000000000000000"
              ),
              {
                eventName: "event otel/src/events/session_telemetry.rs:450",
                severityText: "INFO",
                timeUnixNano: "1760000000000000000",
                attributes: [
                  { key: "session.id", value: { stringValue: "codex-session-1" } },
                  { key: "event.name", value: { stringValue: "codex.api_request" } }
                ],
                body: { stringValue: "POST /responses" }
              },
              sseEvent("response.output_text.delta", [], "1760000000001000000") // a delta, no usage
            ]
          }
        ]
      }
    ]
  };
}

export function copilotTraceBatch(sessionId = "copilot-session-1") {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "github-copilot" } },
            { key: "service.version", value: { stringValue: "1.0.57" } }
          ]
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: "AAAAAAAAAAAAAAAAAAAAAA==",
                spanId: "AAAAAAAAAAA=",
                name: "invoke_agent copilotcli",
                startTimeUnixNano: "1760000000000000000",
                endTimeUnixNano: "1760000002000000000",
                attributes: [
                  { key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } },
                  { key: "gen_ai.agent.name", value: { stringValue: "copilotcli" } },
                  { key: "gen_ai.conversation.id", value: { stringValue: sessionId } },
                  { key: "gen_ai.response.model", value: { stringValue: "gpt-5-mini" } },
                  { key: "gen_ai.usage.input_tokens", value: { intValue: 1000 } },
                  { key: "gen_ai.usage.output_tokens", value: { intValue: 250 } },
                  { key: "gen_ai.usage.cache_read.input_tokens", value: { intValue: 100 } },
                  { key: "github.copilot.user", value: { stringValue: "octo" } }
                ]
              },
              {
                traceId: "AAAAAAAAAAAAAAAAAAAAAA==",
                spanId: "AAAAAAAAAAE=",
                parentSpanId: "AAAAAAAAAAA=",
                name: "chat gpt-5-mini",
                startTimeUnixNano: "1760000000500000000",
                endTimeUnixNano: "1760000001500000000",
                attributes: [
                  { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
                  { key: "gen_ai.conversation.id", value: { stringValue: sessionId } },
                  { key: "gen_ai.response.model", value: { stringValue: "gpt-5-mini" } },
                  { key: "gen_ai.usage.input_tokens", value: { intValue: 9999 } }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
}

export function copilotVsCodeTraceBatch(sessionId = "vscode-window-session") {
  const tokenSpan = (conversationId: string, model: string, inputTokens: number, outputTokens: number) => ({
    traceId: `${conversationId.replace(/-/g, "").slice(0, 16)}AAAAAAAA`,
    spanId: conversationId.replace(/-/g, "").slice(0, 16),
    name: "invoke_agent GitHub Copilot Chat",
    startTimeUnixNano: "1760000000000000000",
    endTimeUnixNano: "1760000002000000000",
    attributes: [
      { key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } },
      { key: "gen_ai.agent.name", value: { stringValue: "GitHub Copilot Chat" } },
      { key: "gen_ai.conversation.id", value: { stringValue: conversationId } },
      { key: "copilot_chat.session_id", value: { stringValue: conversationId } },
      { key: "copilot_chat.chat_session_id", value: { stringValue: conversationId } },
      { key: "gen_ai.response.model", value: { stringValue: model } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: inputTokens } },
      { key: "gen_ai.usage.output_tokens", value: { intValue: outputTokens } }
    ]
  });
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "github-copilot" } },
            { key: "service.version", value: { stringValue: "0.50.1" } },
            { key: "session.id", value: { stringValue: sessionId } }
          ]
        },
        scopeSpans: [
          {
            spans: [
              tokenSpan("1e41a2d2-f8eb-4905-8434-111858d19287", "oswe-vscode-prime", 30000, 4800),
              tokenSpan("10ec3be6-89f1-4bb1-90ff-01234591ed3c", "gpt-4o-mini-2024-07-18", 260, 66)
            ]
          }
        ]
      }
    ]
  };
}

export function copilotVsCodeTranscript(sessionId = "1e41a2d2-f8eb-4905-8434-111858d19287") {
  return [
    JSON.stringify({
      type: "session.start",
      data: {
        sessionId,
        version: 1,
        producer: "copilot-agent",
        copilotVersion: "0.50.1",
        vscodeVersion: "1.122.1",
        startTime: "2026-06-02T04:13:18.237Z"
      },
      id: "start",
      timestamp: "2026-06-02T04:13:18.237Z",
      parentId: null
    }),
    JSON.stringify({
      type: "user.message",
      data: { content: "Can you run the tests?", attachments: [] },
      id: "user-1",
      timestamp: "2026-06-02T04:17:08.318Z",
      parentId: "start"
    }),
    JSON.stringify({
      type: "assistant.message",
      data: { messageId: "assistant-1", content: "Checking the test scripts.", toolRequests: [] },
      id: "assistant-1",
      timestamp: "2026-06-02T04:17:12.303Z",
      parentId: "user-1"
    })
  ].join("\n");
}

// A minimal Codex rollout transcript (the JSONL the codex-hook uploads): session meta, model, and a
// single cumulative token_count event. Carries NO cost (Codex never reports it).
export function codexRollout(sessionId = "codex-session-1", model = "gpt-5.1-codex") {
  return [
    JSON.stringify({ timestamp: "2026-05-31T07:15:20.000Z", type: "session_meta", payload: { id: sessionId } }),
    JSON.stringify({ timestamp: "2026-05-31T07:15:21.000Z", type: "turn_context", payload: { model } }),
    JSON.stringify({
      timestamp: "2026-05-31T07:15:22.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 300, total_tokens: 1300 } }
      }
    })
  ].join("\n");
}

// Raw LiteLLM-shaped price feed for the pure normalizeLiteLlm tests: a dated Claude entry, an undated
// Codex entry (no cache-read cost), an entry to skip (no rates), and the sample_spec sentinel.
export function litellmFeed() {
  return {
    sample_spec: { note: "ignore me" },
    "claude-sonnet-4-5-20250929": {
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      cache_read_input_token_cost: 0.0000003,
      cache_creation_input_token_cost: 0.00000375,
      litellm_provider: "anthropic"
    },
    "gpt-5.1-codex": {
      input_cost_per_token: 0.00000125,
      output_cost_per_token: 0.00001,
      litellm_provider: "openai"
    },
    "whisper-1": { mode: "audio_transcription" }
  };
}

// Already-normalized ModelPrice rows (effectiveDate 0 so they apply to every timestamp), for the
// storage tests that exercise importPricing + cost synthesis directly.
export function modelPrices() {
  return [
    {
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      inputPerToken: 0.000003,
      outputPerToken: 0.000015,
      cacheReadPerToken: 0.0000003,
      cacheCreationPerToken: 0.00000375,
      effectiveDate: 0
    },
    {
      model: "gpt-5.1-codex",
      provider: "openai",
      inputPerToken: 0.00000125,
      outputPerToken: 0.00001,
      cacheReadPerToken: 0.000000125,
      cacheCreationPerToken: 0.00000125,
      effectiveDate: 0
    }
  ];
}
