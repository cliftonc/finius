import { describe, expect, it } from "vitest";
import { DEFAULT_PG_IMAGE, postgresUrl, renderDockerRunArgs } from "../src/cli/postgres.js";

const OPTS = {
  container: "finius-postgres",
  volume: "finius-pgdata",
  port: 5432,
  database: "finius",
  user: "finius",
  password: "blue-happy-otter"
} as const;

describe("renderDockerRunArgs", () => {
  it("builds a persistent, auto-restarting container with the env + port + volume wired up", () => {
    const args = renderDockerRunArgs(OPTS);
    expect(args.slice(0, 4)).toEqual(["run", "-d", "--name", "finius-postgres"]);
    expect(args).toContain("--restart");
    expect(args).toContain("unless-stopped");
    expect(args).toContain("POSTGRES_USER=finius");
    expect(args).toContain("POSTGRES_PASSWORD=blue-happy-otter");
    expect(args).toContain("POSTGRES_DB=finius");
    expect(args).toContain("5432:5432");
    expect(args).toContain("finius-pgdata:/var/lib/postgresql/data");
    // The image is the final positional arg.
    expect(args.at(-1)).toBe(DEFAULT_PG_IMAGE);
  });

  it("maps a custom host port to the container's 5432 and honours an image override", () => {
    const args = renderDockerRunArgs({ ...OPTS, port: 55432, image: "postgres:17" });
    expect(args).toContain("55432:5432");
    expect(args.at(-1)).toBe("postgres:17");
  });
});

describe("postgresUrl", () => {
  it("targets the published host port on localhost", () => {
    expect(postgresUrl(OPTS)).toBe("postgres://finius:blue-happy-otter@localhost:5432/finius");
  });

  it("percent-encodes credentials with URL-unsafe characters", () => {
    expect(postgresUrl({ ...OPTS, password: "p@ss/w:rd" })).toBe(
      "postgres://finius:p%40ss%2Fw%3Ard@localhost:5432/finius"
    );
  });
});
