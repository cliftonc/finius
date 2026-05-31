import { normalizeLiteLlm } from "./pricing.js";
import type { ModelPrice } from "./types.js";

// Historical-pricing fetcher. When a JSONL import carries usage on a day we have no price for, the
// processing step asks for the prices in effect on that day; we reconstruct them from LiteLLM's git
// history on GitHub (it only publishes *current* pricing, but every past version lives in its commits).
// This is the I/O the storage layer stays out of — it's injected via setHistoricalPriceFetcher.

const REPO = "BerriAI/litellm";
const FILE = "model_prices_and_context_window.json";

// Given a YYYY-MM-DD day, return the model prices in effect on that day (or null if unavailable).
export type SnapshotFetcher = (dayIso: string) => Promise<ModelPrice[] | null>;

// Default fetcher: find the latest commit to the price file at or before the day, fetch that exact
// version, and stamp its prices with the commit date as effectiveDate so they apply from then on.
export const githubSnapshot: SnapshotFetcher = async (dayIso) => {
  const commit = await latestCommit(`${dayIso}T23:59:59Z`);
  if (!commit) return null;
  const json = await fetchJsonAt(commit.sha);
  return normalizeLiteLlm(json, commit.date);
};

async function latestCommit(untilIso: string): Promise<{ sha: string; date: number } | null> {
  const url = `https://api.github.com/repos/${REPO}/commits?path=${encodeURIComponent(FILE)}&until=${encodeURIComponent(untilIso)}&per_page=1`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`GitHub commits HTTP ${res.status}`);
  const commits = (await res.json()) as Array<{ sha: string; commit?: { committer?: { date?: string } } }>;
  if (!Array.isArray(commits) || commits.length === 0) return null;
  const date = Date.parse(commits[0].commit?.committer?.date ?? untilIso);
  return { sha: commits[0].sha, date: Number.isFinite(date) ? date : Date.parse(untilIso) };
}

async function fetchJsonAt(sha: string): Promise<unknown> {
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/${FILE}`);
  if (!res.ok) throw new Error(`raw file HTTP ${res.status}`);
  return res.json();
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "finius" };
  // Optional: raises the GitHub rate limit (60/hr → 5000/hr) for large backfills.
  const token = process.env.FINIUS_GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
