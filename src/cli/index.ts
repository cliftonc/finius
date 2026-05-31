#!/usr/bin/env node
import { runCodexHook } from "./codex.js";
import { CONFIG_PATH, configExists, loadConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { runHook } from "./hook.js";
import { runServe } from "./serve.js";
import { runSetup } from "./setup.js";
import { banner, pc } from "./ui.js";

const COMMANDS: Array<[string, string]> = [
  ["finius", "Run setup if not configured, otherwise show status & help"],
  ["finius setup", "Configure server URL + Claude Code telemetry env & hook"],
  ["finius serve [--port N]", "Start the Finius server (API + dashboard)"],
  ["finius doctor", "Diagnose telemetry/hook/server config and connectivity"],
  ["finius hook", "Internal: upload the current session transcript (run by Claude Code hooks)"],
  ["finius codex-hook", "Internal: upload the current Codex rollout (run by the Codex Stop hook)"],
  ["finius help", "Show this help"]
];

function helpText(): string {
  const width = Math.max(...COMMANDS.map(([cmd]) => cmd.length));
  const rows = COMMANDS.map(([cmd, desc]) => `  ${pc.cyan(cmd.padEnd(width))}  ${pc.dim(desc)}`).join("\n");
  return `${pc.bold("Usage")}\n${rows}\n\n${pc.dim("Config:")} ${CONFIG_PATH}\n`;
}

function printStatus(): void {
  banner();
  const config = loadConfig();
  process.stdout.write(`\n${pc.green("Finius is configured.")}\n\n`);
  process.stdout.write(`  ${pc.dim("Server URL")}  ${config?.serverUrl ?? "(unknown)"}\n`);
  process.stdout.write(`  ${pc.dim("Config")}      ${CONFIG_PATH}\n\n`);
  process.stdout.write(`Run ${pc.cyan("finius setup")} to change settings, or ${pc.cyan("finius serve")} to start the server.\n\n`);
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
      if (!configExists()) return runSetup();
      printStatus();
      process.stdout.write(helpText());
      return 0;
    case "setup":
      return runSetup();
    case "serve":
      return runServe(rest);
    case "doctor":
      return runDoctor();
    case "hook":
      return runHook();
    case "codex-hook":
      return runCodexHook();
    case "help":
    case "--help":
    case "-h":
      banner();
      process.stdout.write(`\n${helpText()}`);
      return 0;
    default:
      process.stderr.write(`${pc.red(`Unknown command: ${cmd}`)}\n\n${helpText()}`);
      return 1;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err: unknown) => {
    process.stderr.write(`finius: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
