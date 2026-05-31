import {
  Terminal,
  FileText,
  FilePlus,
  PenLine,
  FolderOpen,
  Search,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Github,
  MessageSquare,
  Globe,
  Download,
  ListChecks,
  Bot,
  BookOpen,
  Plug,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export type ToolFamily =
  | "shell"
  | "fs"
  | "git"
  | "web"
  | "plan"
  | "mcp"
  | "other";

const FAMILY_BY_NAME: Record<string, ToolFamily> = {
  terminal: "shell",
  bash: "shell",
  shell: "shell",

  read_file: "fs",
  write_file: "fs",
  edit_file: "fs",
  list_files: "fs",
  search_files: "fs",
  read: "fs",
  write: "fs",
  edit: "fs",
  grep: "fs",
  glob: "fs",

  web_fetch: "web",
  web_search: "web",
  webfetch: "web",
  websearch: "web",

  todo: "plan",
  todowrite: "plan",
  task: "plan",
  skill_view: "plan",
};

const GIT_NAME_HINTS = [
  "commit",
  "branch",
  "repo",
  "repository",
  "pull_request",
  "pr_",
  "issue",
  "comment",
  "push",
  "clone",
  "merge",
  "tag",
  "release",
];

export function classifyTool(toolName: string): ToolFamily {
  const lower = toolName.toLowerCase();
  const direct = FAMILY_BY_NAME[lower];
  if (direct) return direct;
  if (lower.startsWith("mcp_github_") || lower.startsWith("github_")) return "git";
  if (lower.startsWith("mcp_")) {
    if (GIT_NAME_HINTS.some((h) => lower.includes(h))) return "git";
    return "mcp";
  }
  return "other";
}

export interface FamilyVisual {
  Icon: LucideIcon;
  color: string;
  bg: string;
}

// Distinct accent colours per family, drawn from Tailwind's core palette so they
// read clearly on Finius's light surfaces (HeroUI only ships 6 semantic colours,
// which would force collisions across the 7 families).
export const FAMILY_VISUAL: Record<ToolFamily, FamilyVisual> = {
  shell: { Icon: Terminal, color: "text-sky-500", bg: "bg-sky-500/15" },
  fs: { Icon: FileText, color: "text-violet-500", bg: "bg-violet-500/15" },
  git: { Icon: GitBranch, color: "text-amber-500", bg: "bg-amber-500/15" },
  web: { Icon: Globe, color: "text-emerald-500", bg: "bg-emerald-500/15" },
  plan: { Icon: ListChecks, color: "text-rose-500", bg: "bg-rose-500/15" },
  mcp: { Icon: Plug, color: "text-teal-500", bg: "bg-teal-500/15" },
  other: {
    Icon: Wrench,
    color: "text-foreground/60",
    bg: "bg-foreground/10",
  },
};

const ICON_BY_TOOL: Record<string, LucideIcon> = {
  read_file: FileText,
  read: FileText,
  write_file: FilePlus,
  write: FilePlus,
  edit_file: PenLine,
  edit: PenLine,
  patch: PenLine,
  str_replace: PenLine,
  list_files: FolderOpen,
  search_files: Search,
  grep: Search,
  glob: Search,
  web_fetch: Download,
  webfetch: Download,
  web_search: Search,
  websearch: Search,
  task: Bot,
  skill_view: BookOpen,
  commit: GitCommit,
  add_issue_comment: MessageSquare,
};

const GIT_ICON_HINTS: Array<[RegExp, LucideIcon]> = [
  [/pull_request|pr_/, GitPullRequest],
  [/commit/, GitCommit],
  [/branch/, GitBranch],
  [/repo|repository/, Github],
  [/issue|comment/, MessageSquare],
];

export function iconForTool(toolName: string, family: ToolFamily): LucideIcon {
  const lower = toolName.toLowerCase();
  const direct = ICON_BY_TOOL[lower];
  if (direct) return direct;

  if (family === "git") {
    const stripped = lower
      .replace(/^mcp_/, "")
      .replace(/^github_/, "")
      .replace(/^git_/, "");
    for (const [re, Icon] of GIT_ICON_HINTS) {
      if (re.test(stripped)) return Icon;
    }
    return Github;
  }

  return FAMILY_VISUAL[family].Icon;
}
