import { intro, outro, select, spinner } from "@clack/prompts";
import { backfill, findClaudeTranscripts } from "./backfill.js";
import { CODEX_SOURCE, findCodexRollouts } from "./codex.js";
import { resolveServerUrl } from "./config.js";
import { ask, banner, pc } from "./ui.js";

type ImportTarget = "claude" | "codex" | "all";

export async function runImport(args: string[] = []): Promise<number> {
  banner("import");
  intro(pc.bgCyan(pc.black(" Import historical sessions ")));

  const target = await resolveTarget(args[0]);
  if (!target) {
    process.stderr.write(`${pc.red(`Unknown import target: ${args[0]}`)}\n`);
    process.stderr.write(`Use ${pc.cyan("finius import claude")}, ${pc.cyan("finius import codex")}, or ${pc.cyan("finius import all")}.\n`);
    return 1;
  }

  const serverUrl = resolveServerUrl();
  if (!(await checkServer(serverUrl))) {
    outro(pc.yellow(`Server not reachable at ${serverUrl}. Start it with \`finius serve\`, then re-run import.`));
    return 1;
  }

  let failed = 0;
  if (target === "claude" || target === "all") {
    failed += (await backfill(findClaudeTranscripts(), { source: "claude-code-jsonl", format: "claude", label: "Claude sessions" })).failed;
  }
  if (target === "codex" || target === "all") {
    failed += (await backfill(findCodexRollouts(), { source: CODEX_SOURCE, format: "codex", label: "Codex sessions" })).failed;
  }

  outro(failed ? pc.yellow("Import finished with failures.") : pc.green("Import finished."));
  return failed ? 1 : 0;
}

async function resolveTarget(value: string | undefined): Promise<ImportTarget | null> {
  if (!value) {
    return ask(
      await select({
        message: "Which historical sessions should be imported?",
        options: [
          { value: "all", label: "Claude + Codex" },
          { value: "claude", label: "Claude only" },
          { value: "codex", label: "Codex only" }
        ]
      })
    ) as ImportTarget;
  }
  const normalized = value.toLowerCase();
  if (normalized === "claude" || normalized === "codex" || normalized === "all") return normalized;
  return null;
}

async function checkServer(serverUrl: string): Promise<boolean> {
  const s = spinner();
  s.start(`Checking server at ${serverUrl}`);
  try {
    const res = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
    if (res.ok) {
      s.stop(`Server reachable at ${pc.cyan(serverUrl)}`);
      return true;
    }
    s.stop(pc.yellow(`Server responded with ${res.status}`));
  } catch {
    s.stop(pc.yellow("Server not reachable"));
  }
  return false;
}
