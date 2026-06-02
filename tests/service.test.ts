import { describe, expect, it } from "vitest";
import { renderServiceUnit } from "../src/cli/service.js";

const BASE = {
  execStart: "/usr/local/bin/finius serve",
  finiusHome: "/home/clifton/.finius",
  nodeBinDir: "/usr/local/bin"
} as const;

describe("renderServiceUnit", () => {
  it("renders a system unit with User= and the multi-user target", () => {
    const unit = renderServiceUnit({ ...BASE, scope: "system", user: "clifton" });
    expect(unit).toContain("ExecStart=/usr/local/bin/finius serve");
    expect(unit).toContain("User=clifton");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toContain("Environment=FINIUS_HOME=/home/clifton/.finius");
    expect(unit).toContain("Restart=on-failure");
  });

  it("omits User= for a per-user service and hangs off default.target", () => {
    const unit = renderServiceUnit({ ...BASE, scope: "user" });
    expect(unit).not.toContain("User=");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("prepends the node bin dir to PATH so an nvm `env node` shebang resolves", () => {
    const unit = renderServiceUnit({ ...BASE, scope: "system", nodeBinDir: "/home/clifton/.nvm/versions/node/v24.0.0/bin" });
    expect(unit).toContain("Environment=PATH=/home/clifton/.nvm/versions/node/v24.0.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  });
});
