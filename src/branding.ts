import pc from "picocolors";

// Shared brand presentation with NO interactive-prompt dependency, so both the CLI (cli/ui.ts) and
// the long-running server (server/index.ts) can render the wordmark without pulling in @clack/prompts.

export const BANNER_LINES = [
  "███████╗██╗███╗   ██╗██╗██╗   ██╗███████╗",
  "██╔════╝██║████╗  ██║██║██║   ██║██╔════╝",
  "█████╗  ██║██╔██╗ ██║██║██║   ██║███████╗",
  "██╔══╝  ██║██║╚██╗██║██║██║   ██║╚════██║",
  "██║     ██║██║ ╚████║██║╚██████╔╝███████║",
  "╚═╝     ╚═╝╚═╝  ╚═══╝╚═╝ ╚═════╝ ╚══════╝"
];

export const TAGLINE = "Local-first AI coding usage & cost tracker";

// The colored wordmark + tagline. `subtitle` names the running command (e.g. "setup", "serve").
export function renderBanner(subtitle?: string): string {
  const art = BANNER_LINES.map((line) => pc.cyan(line)).join("\n");
  const sub = subtitle ? `  ${pc.dim("·")}  ${pc.cyan(subtitle)}` : "";
  return `\n${art}\n${pc.dim(TAGLINE)}${sub}\n`;
}

export function banner(subtitle?: string): void {
  process.stdout.write(renderBanner(subtitle));
}

// An aligned label/value block (dim labels, padded to a common width). ANSI-safe because padding is
// computed on the plain label text before any coloring is applied to the value.
export function panel(rows: Array<[string, string]>): string {
  const width = Math.max(0, ...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${pc.dim(label.padEnd(width))}   ${value}`).join("\n");
}

export { pc };
