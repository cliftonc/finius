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
