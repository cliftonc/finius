import { describe, expect, it } from "vitest";
import { parseOtelMetricPoints, parseOtelMetricRecords, preferredIdentity } from "../src/server/otel";
import { otlpMetricBatch } from "./fixtures";

describe("OTLP parser", () => {
  it("extracts Claude Code token and cost metrics", () => {
    const points = parseOtelMetricPoints(otlpMetricBatch());

    expect(points).toHaveLength(3);
    expect(points.map((point) => point.kind)).toEqual(["tokens", "tokens", "cost"]);
    expect(points[0]).toMatchObject({
      sessionId: "session-a",
      userEmail: "dev@example.com",
      model: "claude-sonnet-4-5",
      tokenType: "input",
      value: 1200
    });
  });

  it("captures every metric data point (not just token/cost) for the raw log", () => {
    const records = parseOtelMetricRecords(otlpMetricBatch());
    // token.usage (2 points) + cost.usage (1) + ignored.metric (1) = 4 raw records
    expect(records).toHaveLength(4);
    expect(records.map((record) => record.metricName)).toContain("ignored.metric");
    const input = records.find((record) => record.attributes.type === "input");
    expect(input).toMatchObject({ metricName: "claude_code.token.usage", value: 1200, kind: "sum" });
  });

  it("normalizes camelCase cache token types", () => {
    const batch = {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: "session.id", value: { stringValue: "s1" } }] },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.token.usage",
                  sum: {
                    dataPoints: [
                      { asInt: "5", attributes: [{ key: "type", value: { stringValue: "cacheCreation" } }] },
                      { asInt: "7", attributes: [{ key: "type", value: { stringValue: "cacheRead" } }] }
                    ]
                  }
                }
              ]
            }
          ]
        }
      ]
    };

    const points = parseOtelMetricPoints(batch);
    expect(points.map((point) => point.tokenType)).toEqual(["cache_creation", "cache_read"]);
  });

  it("prefers email, account id, then user id for identity", () => {
    expect(preferredIdentity({ userEmail: "a@example.com", userAccountId: "acct", userId: "user" })).toBe("a@example.com");
    expect(preferredIdentity({ userEmail: null, userAccountId: "acct", userId: "user" })).toBe("acct");
    expect(preferredIdentity({ userEmail: null, userAccountId: null, userId: "user" })).toBe("user");
  });
});
