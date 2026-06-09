import { execFileSync, spawnSync } from "node:child_process";

// Docker-backed Postgres provisioning for `finius setup` — the "spin up a new local Postgres" path,
// the alternative to pointing at an existing server by URL. Following the service.ts convention, the
// argv/URL builders are pure (unit-tested in tests/postgres-docker.test.ts); everything that shells
// out to `docker` lives in the IO helpers below.

export const DEFAULT_PG_IMAGE = "postgres:16-alpine";
export const DEFAULT_PG_CONTAINER = "finius-postgres";
export const DEFAULT_PG_VOLUME = "finius-pgdata";
// Off the standard 5432 by default so the managed container never collides with a system/Homebrew
// Postgres already listening there (the usual "port is already allocated" failure). Override at the
// port prompt during setup.
export const DEFAULT_PG_PORT = 55432;
export const DEFAULT_PG_DATABASE = "finius";
export const DEFAULT_PG_USER = "finius";

export type PostgresContainerOptions = {
  container: string;
  volume: string;
  // Host port to publish (mapped to the container's 5432). The connection URL targets localhost:<port>.
  port: number;
  database: string;
  user: string;
  password: string;
  image?: string;
};

// Build the `docker run` argv for a persistent local Postgres. A named volume keeps the data across
// container restarts/recreations (unlike the throwaway `--rm` container the test harness uses), and
// `--restart unless-stopped` brings it back after a reboot so `finius serve` finds it waiting.
export function renderDockerRunArgs(o: PostgresContainerOptions): string[] {
  return [
    "run",
    "-d",
    "--name",
    o.container,
    "--restart",
    "unless-stopped",
    "-e",
    `POSTGRES_USER=${o.user}`,
    "-e",
    `POSTGRES_PASSWORD=${o.password}`,
    "-e",
    `POSTGRES_DB=${o.database}`,
    "-p",
    `${o.port}:5432`,
    "-v",
    `${o.volume}:/var/lib/postgresql/data`,
    o.image ?? DEFAULT_PG_IMAGE
  ];
}

// The connection URL pointing at the published host port. The password is percent-encoded so special
// characters survive the URL (our generated ones are word-passwords, but a custom one might not).
export function postgresUrl(o: Pick<PostgresContainerOptions, "user" | "password" | "port" | "database">): string {
  return `postgres://${encodeURIComponent(o.user)}:${encodeURIComponent(o.password)}@localhost:${o.port}/${o.database}`;
}

// Is the `docker` CLI present AND the daemon reachable? `docker info` fails fast (non-zero) when the
// daemon is down, which is exactly the case we must not offer the spin-up path for.
export function isDockerAvailable(): boolean {
  try {
    const r = spawnSync("docker", ["info"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

export type ContainerState = { exists: boolean; running: boolean };

// Inspect a container by name. `docker inspect` returns the running flag as a string; absent ⇒ exits
// non-zero, which we read as "doesn't exist".
export function inspectContainer(name: string): ContainerState {
  try {
    const out = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", name], {
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString()
      .trim();
    return { exists: true, running: out === "true" };
  } catch {
    return { exists: false, running: false };
  }
}

// Start an already-created (stopped) container.
export function startContainer(name: string): void {
  execFileSync("docker", ["start", name], { stdio: "ignore" });
}

// Remove a container (force-killing it if running). Used when recreating one whose password we no
// longer hold.
export function removeContainer(name: string): void {
  execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
}

// Remove a named volume. Best-effort (a recreated container needs the old data dir gone so the new
// password takes); swallow the error if it's already absent or still in use.
export function removeVolume(name: string): void {
  try {
    execFileSync("docker", ["volume", "rm", name], { stdio: "ignore" });
  } catch {
    // already gone, or held by another container — not worth failing setup over.
  }
}

// Create + start the container. Throws (with docker's stderr) if the run fails — e.g. the port is
// already taken, which the caller surfaces as a hint to pick another.
export function runContainer(o: PostgresContainerOptions): void {
  execFileSync("docker", renderDockerRunArgs(o), { stdio: ["ignore", "ignore", "pipe"] });
}

// Poll `pg_isready` inside the container until Postgres accepts connections (it takes a beat to
// initialize a fresh data dir). Returns true once ready, false if it never came up within the budget.
export async function waitForPostgres(container: string, user: string, attempts = 60): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const r = spawnSync("docker", ["exec", container, "pg_isready", "-U", user], { stdio: "ignore" });
    if (r.status === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
