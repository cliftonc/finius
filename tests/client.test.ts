import { describe, expect, it } from "vitest";
import { finiusVersion, uploadHeaders } from "../src/cli/client.js";

describe("uploadHeaders", () => {
  it("always tags uploads as finius traffic (header + User-Agent), no auth needed", () => {
    const h = uploadHeaders();
    expect(h["x-finius-client"]).toBe("hook");
    expect(h["user-agent"]).toBe(`finius-hook/${finiusVersion()}`);
    expect(h["content-type"]).toBe("application/json");
    expect(h.authorization).toBeUndefined();
  });

  it("adds the bearer token in Secure Mode while keeping the marker", () => {
    const h = uploadHeaders("tok123");
    expect(h.authorization).toBe("Bearer tok123");
    expect(h["x-finius-client"]).toBe("hook");
  });

  it("reads a real semver-ish version from package.json", () => {
    expect(finiusVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
