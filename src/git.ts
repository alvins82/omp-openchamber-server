import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

export type GitJsonPrimitive = string | number | boolean | null;
export type GitJsonValue = GitJsonPrimitive | GitJsonObject | GitJsonValue[];

export interface GitJsonObject {
  [key: string]: GitJsonValue;
}

export interface GitRequestBody extends GitJsonObject {}

type GitRecord = GitRequestBody;
type GitInput = GitJsonValue | undefined;

export interface GitRouteResult {
  data: GitJsonValue;
  status?: number;
  headers?: HeadersInit;
}

class GitHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHttpError";
    this.status = status;
  }
}

class GitCommandError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;

  constructor(command: string, result: GitCommandResult) {
    const detail = sanitizeGitText(result.stderr || result.stdout || "Git command failed");
    super(`${command} failed${detail ? `: ${detail}` : ""}`);
    this.name = "GitCommandError";
    this.exitCode = result.exitCode;
    this.stderr = result.stderr;
    this.stdout = result.stdout;
  }
}

interface GitCommandResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface GitRunOptions {
  timeout?: number;
}

interface GitStatusFile extends GitJsonObject {
  path: string;
  index: string;
  working_dir: string;
}

interface GitWorktreeEntry extends GitJsonObject {
  worktree: string;
  head: string;
  branch: string;
  prunable: boolean;
}

interface BootstrapState extends GitJsonObject {
  status: "pending" | "ready" | "failed";
  phase: "directory-created" | "git-ready" | "setup-ready";
  error: string | null;
  updatedAt: number;
}

interface BootstrapInputState extends GitJsonObject {
  status: BootstrapState["status"];
  phase: BootstrapState["phase"];
  error: string | null;
}

const MAX_OUTPUT = 50 * 1024 * 1024;
const bootstrapStates = new Map<string, BootstrapState>();

function sanitizeGitText(value: string): string {
  return String(value || "")
    .replace(/(https?:\/\/)([^\s/@]+)@/gi, "$1***@")
    .replace(/(ssh:\/\/)([^\s/@]+)@/gi, "$1***@");
}

function sanitizeRemoteUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString().replace(/\/$/, "");
    }
  } catch {
    // SCP-style remotes are not URLs and normally do not contain credentials.
  }
  return sanitizeGitText(trimmed);
}

function runGit(cwd: string, args: string[], options: GitRunOptions = {}): Promise<GitCommandResult> {
  return new Promise((resolveResult) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: {
          ...process.env,
          GIT_EDITOR: "true",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
        maxBuffer: MAX_OUTPUT,
        timeout: options.timeout,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const numericCode = Number(error?.code);
        const exitCode = error ? (Number.isFinite(numericCode) ? numericCode : 1) : 0;
        resolveResult({
          ok: !error,
          exitCode,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      },
    );
  });
}

const REMOTE_PROBE_TIMEOUT_MS = 3000;

function runGitRemoteProbe(cwd: string, args: string[]): Promise<GitCommandResult> {
  return runGit(cwd, args, { timeout: REMOTE_PROBE_TIMEOUT_MS });
}

function runGitBytes(cwd: string, args: string[]): Promise<Buffer | null> {
  return new Promise((resolveBytes) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: {
          ...process.env,
          GIT_EDITOR: "true",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
        encoding: "buffer",
        maxBuffer: MAX_OUTPUT,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolveBytes(null);
          return;
        }
        resolveBytes(Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || "")));
      },
    );
  });
}

async function runGitChecked(cwd: string, args: string[], label = "git"): Promise<GitCommandResult> {
  const result = await runGit(cwd, args);
  if (!result.ok) {
    throw new GitCommandError(label, result);
  }
  return result;
}

function expandHome(value: string): string {
  const home = process.env.HOME || homedir();
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

function resolveDirectory(value: string | undefined, fallback: string): string {
  const raw = String(value || fallback).trim();
  if (!raw) return resolve(fallback);
  return resolve(expandHome(raw));
}

function pathIsInside(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const remainder = relative(rootPath, candidatePath);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

function isRecord(value: GitInput): value is GitRecord {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isGitString(value: GitInput): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isGitBoolean(value: GitInput): value is boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]";
}

async function readBody(req: Request): Promise<GitRecord> {
  const text = await req.text();
  if (!text.trim()) return {};
  let parsed: GitJsonValue;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GitHttpError(400, "Request body must be valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new GitHttpError(400, "Request body must be a JSON object");
  }
  return parsed;
}

function requiredString(value: GitInput, name: string): string {
  if (!isGitString(value) || !value.trim()) {
    throw new GitHttpError(400, `${name} is required`);
  }
  return value.trim();
}

function optionalString(value: GitInput): string {
  return isGitString(value) ? value.trim() : "";
}

interface StatusHeader extends GitJsonObject {
  current: string;
  tracking: string | null;
  ahead: number;
  behind: number;
}

interface Numstat extends GitJsonObject {
  insertions: number;
  deletions: number;
}

interface NumstatByPath {
  [path: string]: Numstat;
}

interface ShortStat extends GitJsonObject {
  changes: number;
  insertions: number;
  deletions: number;
}

function contextLineCount(value: string | null): number {
  const parsed = Number.parseInt(value || "3", 10);
  return Number.isFinite(parsed) ? parsed : 3;
}

function normalizeBranchName(value: string): string {
  return value
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^heads\//, "");
}

function normalizeRemoteBranchName(value: string): string {
  return value.trim().replace(/^refs\/remotes\//, "").replace(/^remotes\//, "");
}

function validCommitHash(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value.trim());
}

function validIntegrationSha(value: string): boolean {
  return /^[0-9a-f]{4,64}$/i.test(value.trim());
}

async function repositoryRoot(directory: string): Promise<string> {
  const result = await runGitChecked(directory, ["rev-parse", "--show-toplevel"], "Resolve Git repository root");
  const root = result.stdout.trim();
  if (!root) throw new GitHttpError(404, "Directory is not inside a Git repository");
  return canonicalPath(root);
}

async function gitPath(directory: string, name: string): Promise<string> {
  const result = await runGitChecked(directory, ["rev-parse", "--git-path", name], "Resolve Git internal path");
  return resolve(directory, result.stdout.trim());
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

async function canonicalPath(value: string): Promise<string> {
  const candidate = resolve(value);
  const existing = await realpath(candidate).catch(() => "");
  if (existing) return existing;
  const parent = await realpath(dirname(candidate)).catch(() => dirname(candidate));
  return join(parent, basename(candidate));
}

async function isGitRepository(directory: string): Promise<boolean> {
  const result = await runGit(directory, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}

async function resolvePrimaryRoot(directory: string): Promise<{ root: string }> {
  const cwd = resolve(directory);
  try {
    const [gitDirResult, commonDirResult] = await Promise.all([
      runGitChecked(cwd, ["rev-parse", "--absolute-git-dir"], "Resolve Git directory"),
      runGitChecked(cwd, ["rev-parse", "--git-common-dir"], "Resolve Git common directory"),
    ]);
    const gitDir = await canonicalPath(resolve(cwd, gitDirResult.stdout.trim()));
    const commonDir = await canonicalPath(resolve(cwd, commonDirResult.stdout.trim()));
    if (basename(commonDir) === ".git") {
      return { root: dirname(commonDir) };
    }
    const worktreeMarker = `${sep}worktrees${sep}`;
    const markerIndex = gitDir.indexOf(worktreeMarker);
    if (markerIndex >= 0) {
      const common = gitDir.slice(0, markerIndex);
      return { root: dirname(common.endsWith(sep) ? common.slice(0, -1) : common) };
    }
  } catch {
    // A non-repository path is handled as a stable fallback by the standard route.
  }
  return { root: cwd };
}

async function resolveTopLevel(directory: string): Promise<{ root: string }> {
  try {
    return { root: await repositoryRoot(directory) };
  } catch {
    return { root: resolve(directory) };
  }
}

function decodeGitPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    return isGitString(parsed) ? parsed : trimmed;
  } catch {
    return trimmed.slice(1, trimmed.endsWith('"') ? -1 : undefined);
  }
}

function parseStatusLine(value: string): GitStatusFile | null {
  if (value.length < 3 || value.startsWith("##")) return null;
  const index = value[0] || " ";
  const working = value[1] || " ";
  let filePath = decodeGitPath(value.slice(3));
  const renameIndex = filePath.lastIndexOf(" -> ");
  if (renameIndex >= 0) filePath = filePath.slice(renameIndex + 4);
  if (!filePath) return null;
  return {
    path: filePath,
    index,
    working_dir: working,
  };
}

function parseStatusHeader(value: string): StatusHeader {
  const header = value.replace(/^##\s*/, "").trim();
  if (!header || header === "HEAD (no branch)") {
    return { current: "", tracking: null, ahead: 0, behind: 0 };
  }
  const first = header.split(" [", 1)[0] || header;
  const [currentRaw, trackingRaw] = first.split("...", 2);
  const current = currentRaw.replace(/^No commits yet on\s+/, "").trim();
  const tracking = trackingRaw?.trim() || null;
  const aheadMatch = header.match(/ahead\s+(\d+)/);
  const behindMatch = header.match(/behind\s+(\d+)/);
  return {
    current: current === "HEAD" ? "" : current,
    tracking,
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  };
}

function parseNumstat(value: string): NumstatByPath {
  const result: NumstatByPath = {};
  for (const line of value.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const path = parts.slice(2).join("\t");
    if (!path) continue;
    const insertions = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10) || 0;
    const deletions = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10) || 0;
    const current = result[path] || { insertions: 0, deletions: 0 };
    result[path] = {
      insertions: current.insertions + insertions,
      deletions: current.deletions + deletions,
    };
  }
  return result;
}

async function getStatus(directory: string, light = false): Promise<GitRecord> {
  const cwd = resolve(directory);
  if (!(await isGitRepository(cwd))) {
    return {
      isGitRepository: false,
      current: "",
      tracking: null,
      ahead: 0,
      behind: 0,
      files: [],
      isClean: true,
      diffStats: {},
      mergeInProgress: null,
      rebaseInProgress: null,
    };
  }

  const statusResult = await runGitChecked(cwd, ["status", "--porcelain=v1", "--branch", "--untracked-files=all"], "Read Git status");
  const lines = statusResult.stdout.split("\n").filter(Boolean);
  const header = parseStatusHeader(lines.shift() || "");
  const files = lines.map(parseStatusLine).filter((entry): entry is GitStatusFile => entry !== null);
  const diffStats: NumstatByPath = {};
  if (!light) {
    const [cached, working] = await Promise.all([
      runGit(cwd, ["diff", "--cached", "--numstat"]),
      runGit(cwd, ["diff", "--numstat"]),
    ]);
    for (const stats of [parseNumstat(cached.stdout), parseNumstat(working.stdout)]) {
      for (const [path, value] of Object.entries(stats)) {
        const current = diffStats[path] || { insertions: 0, deletions: 0 };
        diffStats[path] = {
          insertions: current.insertions + value.insertions,
          deletions: current.deletions + value.deletions,
        };
      }
    }
    for (const file of files) {
      if ((file.index === "?" || file.working_dir === "?") && !diffStats[file.path]) {
        const absolute = resolve(cwd, file.path);
        const contents = await readFile(absolute).catch(() => Buffer.alloc(0));
        if (!contents.includes(0)) {
          const text = contents.toString("utf8");
          diffStats[file.path] = {
            insertions: text ? text.split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line.length > 0).length : 0,
            deletions: 0,
          };
        }
      }
    }
  }

  let mergeInProgress: GitRecord | null = null;
  const mergeHead = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
  if (mergeHead.ok) {
    const messagePath = await gitPath(cwd, "MERGE_MSG").catch(() => "");
    const message = messagePath ? await readFile(messagePath, "utf8").catch(() => "") : "";
    mergeInProgress = { head: mergeHead.stdout.trim().slice(0, 7), message: message.split("\n")[0] || "" };
  }
  let rebaseInProgress: GitRecord | null = null;
  const rebaseMerge = await gitPath(cwd, "rebase-merge").catch(() => "");
  const rebaseApply = await gitPath(cwd, "rebase-apply").catch(() => "");
  const rebasePath = rebaseMerge && await pathExists(rebaseMerge) ? rebaseMerge : rebaseApply && await pathExists(rebaseApply) ? rebaseApply : "";
  if (rebasePath) {
    const headName = await readFile(join(rebasePath, "head-name"), "utf8").catch(() => "");
    const onto = await readFile(join(rebasePath, "onto"), "utf8").catch(() => "");
    rebaseInProgress = {
      headName: headName.trim().replace(/^refs\/heads\//, ""),
      onto: onto.trim().slice(0, 7),
    };
  }

  const tracking = header.tracking;
  let ahead = header.ahead;
  let behind = header.behind;
  if (!tracking && header.current && !light) {
    const candidates = [
      (await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).stdout.trim(),
      "origin/main",
      "origin/master",
      "main",
      "master",
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (!(await runGit(cwd, ["rev-parse", "--verify", `${candidate}^{commit}`])).ok) continue;
      const count = await runGit(cwd, ["rev-list", "--count", `${candidate}..HEAD`]);
      const value = Number.parseInt(count.stdout.trim(), 10);
      if (Number.isFinite(value)) ahead = value;
      break;
    }
  }
  let upstreamComparison: GitRecord | null = null;
  if (tracking && !tracking.startsWith("upstream/")) {
    const remoteTracking = tracking.replace(/^remotes\//, "");
    const slash = remoteTracking.indexOf("/");
    const [remote, branch] = slash > 0 ? [remoteTracking.slice(0, slash), remoteTracking.slice(slash + 1)] : ["", remoteTracking];
    upstreamComparison = { remote, branch, ahead, behind };
  } else if (!tracking && !light && header.current && (await runGit(cwd, ["remote", "get-url", "upstream"])).ok) {
    const upstreamRef = `refs/remotes/upstream/${header.current}`;
    if ((await runGit(cwd, ["rev-parse", "--verify", upstreamRef])).ok) {
      const counts = await runGit(cwd, ["rev-list", "--left-right", "--count", `HEAD...${upstreamRef}`]);
      const [aheadRaw, behindRaw] = counts.stdout.trim().split(/\s+/);
      const upstreamAhead = Number.parseInt(aheadRaw || "", 10);
      const upstreamBehind = Number.parseInt(behindRaw || "", 10);
      if (Number.isFinite(upstreamAhead) && Number.isFinite(upstreamBehind)) {
        upstreamComparison = { remote: "upstream", branch: header.current, ahead: upstreamAhead, behind: upstreamBehind };
      }
    }
  }

  const staged = files.filter((file) => file.index !== " " && file.index !== "?").map((file) => file.path);
  const unstaged = files.filter((file) => file.working_dir !== " " && file.working_dir !== "?").map((file) => file.path);
  const untracked = files.filter((file) => file.index === "?" || file.working_dir === "?").map((file) => file.path);
  const response: GitRecord = {
    isGitRepository: true,
    current: header.current,
    tracking,
    ahead,
    behind,
    upstreamComparison,
    files,
    isClean: files.length === 0,
    mergeInProgress,
    rebaseInProgress,
    branch: header.current,
    staged,
    unstaged,
    untracked,
  };
  if (!light) response.diffStats = diffStats;
  return response;
}

async function getBranches(directory: string): Promise<GitRecord> {
  const cwd = resolve(directory);
  if (!(await isGitRepository(cwd))) return { all: [], current: "", branches: {}, defaultBranches: {} };
  const result = await runGitChecked(cwd, [
    "for-each-ref",
    "--format=%(refname:short)\t%(refname)\t%(objectname)\t%(HEAD)\t%(upstream:short)\t%(upstream:track)",
    "refs/heads",
    "refs/remotes",
  ], "Read Git branches");
  const local: string[] = [];
  const remote: string[] = [];
  const branches: Record<string, GitRecord> = {};
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const [shortName, fullRef, commit, marker, upstream, track] = line.split("\t");
    if (!shortName || shortName.endsWith("/HEAD")) continue;
    const remoteRef = fullRef?.startsWith("refs/remotes/") === true;
    const name = remoteRef ? `remotes/${shortName}` : shortName;
    (remoteRef ? remote : local).push(name);
    const aheadMatch = track?.match(/ahead\s+(\d+)/);
    const behindMatch = track?.match(/behind\s+(\d+)/);
    const branchInfo: GitRecord = {
      current: marker === "*",
      name,
      commit: commit || "",
      label: name,
      ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
      behind: behindMatch ? Number(behindMatch[1]) : 0,
    };
    if (upstream) branchInfo.tracking = upstream;
    branches[name] = branchInfo;
  }
  const remoteNames = (await runGit(cwd, ["remote"])).stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const remoteStates = new Map<string, { reachable: boolean; branches: Set<string> }>();
  await Promise.all(remoteNames.map(async (remoteName) => {
    const remoteResult = await runGitRemoteProbe(cwd, ["ls-remote", "--heads", remoteName]);
    if (!remoteResult.ok) {
      remoteStates.set(remoteName, { reachable: false, branches: new Set() });
      return;
    }
    const names = new Set<string>();
    for (const line of remoteResult.stdout.split(/\r?\n/).filter(Boolean)) {
      const ref = line.split("\t")[1] || "";
      if (ref.startsWith("refs/heads/")) names.add(ref.slice("refs/heads/".length));
    }
    remoteStates.set(remoteName, { reachable: true, branches: names });
  }));
  const activeRemote = new Set<string>();
  for (const name of remote) {
    const match = name.match(/^remotes\/([^/]+)\/(.+)$/);
    if (!match) continue;
    const state = remoteStates.get(match[1]);
    if (!state || !state.reachable || state.branches.has(match[2])) activeRemote.add(name);
  }
  for (const [remoteName, state] of remoteStates) {
    if (!state.reachable) continue;
    for (const branch of state.branches) {
      const name = `remotes/${remoteName}/${branch}`;
      activeRemote.add(name);
    }
  }
  const currentResult = await runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const current = currentResult.ok ? currentResult.stdout.trim() : "";
  const defaultBranches: Record<string, string> = {};
  const defaultRefs = await runGit(cwd, ["for-each-ref", "--format=%(refname)\t%(symref)", "refs/remotes"]);
  for (const line of defaultRefs.stdout.split("\n").filter(Boolean)) {
    const [ref, symref] = line.split("\t");
    const match = ref?.match(/^refs\/remotes\/([^/]+)\/HEAD$/);
    if (match && symref?.startsWith(`refs/remotes/${match[1]}/`)) {
      defaultBranches[match[1]] = symref.slice(`refs/remotes/${match[1]}/`.length);
    }
  }
  for (const remoteName of remoteNames.filter((name) => !defaultBranches[name])) {
    const head = await runGitRemoteProbe(cwd, ["ls-remote", "--symref", remoteName, "HEAD"]);
    const match = head.stdout.match(/^ref:\s+refs\/heads\/(.+?)\s+HEAD$/m);
    if (head.ok && match) defaultBranches[remoteName] = match[1];
  }
  return { all: [...local, ...activeRemote], current, branches, defaultBranches };
}

async function getUnpushedBranchCounts(directory: string, names: string[]): Promise<GitRecord> {
  const cwd = resolve(directory);
  const counts: Record<string, number> = {};
  const localBranches = new Set((await runGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean));
  for (const name of [...new Set(names)].slice(0, 5)) {
    if (!name) continue;
    if (!localBranches.has(name)) continue;
    const upstream = await runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${name}@{upstream}`]);
    if (!upstream.ok || !upstream.stdout.trim()) continue;
    const count = await runGit(cwd, ["rev-list", "--count", `${upstream.stdout.trim()}..${name}`]);
    const value = Number.parseInt(count.stdout.trim(), 10);
    if (Number.isFinite(value) && value > 0) counts[name] = value;
  }
  return { counts };
}

async function repositoryFile(directory: string, filePath: string): Promise<{ root: string; absolute: string; repoPath: string }> {
  const cwd = resolve(directory);
  const root = await repositoryRoot(cwd);
  const raw = filePath.trim();
  const canonicalCwd = await canonicalPath(cwd);
  const absolute = await canonicalPath(resolve(isAbsolute(raw) ? raw : join(canonicalCwd, raw)));
  if (!pathIsInside(root, absolute) || absolute === root) {
    throw new GitHttpError(400, "Path must be inside the Git repository");
  }
  return { root, absolute, repoPath: relative(root, absolute).split(sep).join("/") };
}

async function getDiff(directory: string, filePath: string, staged: boolean, contextLines: number): Promise<string> {
  const cwd = resolve(directory);
  const file = filePath ? await repositoryFile(cwd, filePath) : null;
  const args = ["diff", "--no-color", `-U${Math.max(0, Math.min(100, contextLines))}`];
  if (staged) args.push("--cached");
  if (file) args.push("--", file.repoPath);
  const diff = await runGitChecked(cwd, args, "Read Git diff");
  if (diff.stdout || staged || !file) return diff.stdout;
  const tracked = await runGit(cwd, ["ls-files", "--error-unmatch", "--", file.repoPath]);
  if (tracked.ok) return "";
  const linkTarget = await readlink(file.absolute, "utf8").catch(() => "");
  if (linkTarget) {
    return [
      `diff --git a/${file.repoPath} b/${file.repoPath}`,
      "new file mode 120000",
      "--- /dev/null",
      `+++ b/${file.repoPath}`,
      "@@ -0,0 +1 @@",
      `+${linkTarget}`,
      "\\ No newline at end of file",
      "",
    ].join("\n");
  }
  const noIndex = await runGit(cwd, ["diff", "--no-color", `-U${Math.max(0, Math.min(100, contextLines))}`, "--no-index", "--", "/dev/null", file.absolute]);
  return noIndex.stdout;
}

function isBinaryBuffer(value: Buffer): boolean {
  return value.includes(0);
}

function imageMimeType(filePath: string): string | null {
  const extension = extname(filePath).toLowerCase();
  return {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
  }[extension] || null;
}

function imageDataUrl(value: Buffer | null, mimeType: string): string {
  return value && value.length > 0 ? `data:${mimeType};base64,${value.toString("base64")}` : "";
}

async function getFileDiff(directory: string, filePath: string, staged: boolean): Promise<GitRecord> {
  const file = await repositoryFile(directory, filePath);
  const current = await readFile(file.absolute).catch(() => Buffer.alloc(0));
  const linkTarget = await readlink(file.absolute, "utf8").catch(() => "");
  const mimeType = imageMimeType(file.repoPath);
  if (mimeType) {
    const original = await runGitBytes(file.root, ["show", `HEAD:${file.repoPath}`]);
    const modified = staged ? await runGitBytes(file.root, ["show", `:${file.repoPath}`]) : current;
    return {
      original: imageDataUrl(original, mimeType),
      modified: imageDataUrl(modified, mimeType),
      path: filePath,
      isBinary: false,
    };
  }
  const originalResult = await runGit(file.root, ["show", `HEAD:${file.repoPath}`]);
  const modifiedResult = staged
    ? await runGit(file.root, ["show", `:${file.repoPath}`])
    : { ok: true, exitCode: 0, stdout: linkTarget || current.toString("utf8"), stderr: "" };
  const binary = isBinaryBuffer(current) || (originalResult.ok && isBinaryBuffer(Buffer.from(originalResult.stdout))) ||
    ((await runGit(file.root, ["diff", "--numstat", ...(staged ? ["--cached"] : []), "--", file.repoPath])).stdout.split("\t")[0] === "-");
  return {
    original: binary ? "" : originalResult.ok ? originalResult.stdout.replace(/\r\n/g, "\n") : "",
    modified: binary ? "" : modifiedResult.ok ? modifiedResult.stdout.replace(/\r\n/g, "\n") : "",
    path: filePath,
    isBinary: binary,
  };
}

async function resolveRangeBase(cwd: string, base: string): Promise<string> {
  let resolved = base;
  if ((await runGit(cwd, ["rev-parse", "--verify", `refs/remotes/origin/${base}^{commit}`])).ok) {
    resolved = `origin/${base}`;
  } else if (!(await runGit(cwd, ["rev-parse", "--verify", `refs/heads/${base}^{commit}`])).ok && !/[*?\[\]^~:\\]/.test(base)) {
    const remoteRef = await runGit(cwd, ["for-each-ref", "--count=1", "--format=%(refname:short)", `refs/remotes/*/${base}`]);
    if (remoteRef.ok && remoteRef.stdout.trim()) resolved = remoteRef.stdout.trim().split(/\r?\n/)[0];
  }
  if (!(await runGit(cwd, ["rev-parse", "--verify", `${resolved}^{commit}`])).ok) {
    throw new GitHttpError(400, `Ref "${base}" is not available locally. Fetch it before comparing.`);
  }
  return resolved;
}

async function getRangeDiff(directory: string, base: string, head: string, filePath: string, contextLines: number): Promise<string> {
  const cwd = resolve(directory);
  if (base.startsWith("-") || head.startsWith("-")) throw new GitHttpError(400, "Base or head ref is invalid");
  const resolvedBase = await resolveRangeBase(cwd, base);
  const refs = await Promise.all([
    runGit(cwd, ["rev-parse", "--verify", `${head}^{commit}`]),
  ]);
  if (!refs[0].ok) throw new GitHttpError(400, `Ref "${head}" is not available locally. Fetch it before comparing.`);
  const args = ["diff", "--no-color", `-U${Math.max(0, Math.min(100, contextLines))}`, `${resolvedBase}...${head}`];
  if (filePath) args.push("--", (await repositoryFile(cwd, filePath)).repoPath);
  return (await runGitChecked(cwd, args, "Read Git range diff")).stdout;
}

async function getRangeFiles(directory: string, base: string, head: string): Promise<GitRecord> {
  const cwd = resolve(directory);
  if (base.startsWith("-") || head.startsWith("-")) throw new GitHttpError(400, "Base or head ref is invalid");
  const resolvedBase = await resolveRangeBase(cwd, base);
  if (!(await runGit(cwd, ["rev-parse", "--verify", `${head}^{commit}`])).ok) {
    throw new GitHttpError(400, `Ref "${head}" is not available locally. Fetch it before comparing.`);
  }
  const result = await runGitChecked(cwd, ["diff", "--name-status", `${resolvedBase}...${head}`], "Read Git range files");
  const files = result.stdout.split("\n").filter(Boolean).map((line) => {
    const [status, ...pathParts] = line.split("\t");
    return { status: status || "M", path: pathParts.at(-1) || "" };
  }).filter((entry) => entry.path);
  return { files };
}

async function getBranchBase(directory: string, branch: string): Promise<GitRecord> {
  const result = await runGit(resolve(directory), ["reflog", "show", "--format=%gs", branch]);
  if (!result.ok) return { base: null };
  const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).reverse();
  const creation = lines.find((line) => line.startsWith("branch: Created from "));
  const source = creation?.slice("branch: Created from ".length).trim() || "";
  if (!source || source === "HEAD" || /^[0-9a-f]{7,40}$/i.test(source)) return { base: null };
  const resolves = await runGit(resolve(directory), ["rev-parse", "--verify", source]);
  return resolves.ok ? { base: source } : { base: null };
}

function parseWorktreePorcelain(value: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  for (const block of value.split(/\n\n+/)) {
    let worktree = "";
    let head = "";
    let branch = "";
    let prunable = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) worktree = line.slice("worktree ".length).trim();
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim();
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      else if (line.startsWith("prunable ")) prunable = true;
    }
    if (worktree) entries.push({ worktree, head, branch, prunable });
  }
  return entries;
}

async function getWorktrees(directory: string): Promise<GitRecord[]> {
  const cwd = resolve(directory);
  if (!(await isGitRepository(cwd))) return [];
  const root = await repositoryRoot(cwd);
  const result = await runGitChecked(root, ["worktree", "list", "--porcelain"], "List Git worktrees");
  return parseWorktreePorcelain(result.stdout).map((entry) => ({
    head: entry.head,
    name: basename(entry.worktree),
    branch: entry.branch,
    path: entry.worktree,
    prunable: entry.prunable,
  }));
}

async function isLinkedWorktree(directory: string): Promise<boolean> {
  const cwd = resolve(directory);
  const [gitDir, commonDir] = await Promise.all([
    runGitChecked(cwd, ["rev-parse", "--git-dir"], "Resolve worktree Git directory"),
    runGitChecked(cwd, ["rev-parse", "--git-common-dir"], "Resolve common Git directory"),
  ]);
  return resolve(cwd, gitDir.stdout.trim()) !== resolve(cwd, commonDir.stdout.trim());
}

async function stageFiles(directory: string, paths: string[]): Promise<void> {
  const filePaths = paths.filter((path) => path.trim());
  if (filePaths.length === 0) throw new GitHttpError(400, "path is required");
  const root = await repositoryRoot(directory);
  const repoPaths = await Promise.all(filePaths.map(async (path) => (await repositoryFile(directory, path)).repoPath));
  await runGitChecked(root, ["add", "--", ...repoPaths], "Stage Git files");
}

async function unstageFiles(directory: string, paths: string[]): Promise<void> {
  const filePaths = paths.filter((path) => path.trim());
  if (filePaths.length === 0) throw new GitHttpError(400, "path is required");
  const root = await repositoryRoot(directory);
  const repoPaths = await Promise.all(filePaths.map(async (path) => (await repositoryFile(directory, path)).repoPath));
  const result = await runGit(root, ["reset", "HEAD", "--", ...repoPaths]);
  if (!result.ok) {
    await runGitChecked(root, ["restore", "--staged", "--", ...repoPaths], "Unstage Git files");
  }
}

async function isTracked(root: string, repoPath: string): Promise<boolean> {
  return (await runGit(root, ["ls-files", "--error-unmatch", "--", repoPath])).ok;
}

async function revertFile(directory: string, filePath: string, scope: string): Promise<void> {
  const file = await repositoryFile(directory, filePath);
  if (!(await isTracked(file.root, file.repoPath))) {
    await runGitChecked(file.root, ["clean", "-f", "-d", "--", file.repoPath], "Remove untracked Git file");
    return;
  }
  if (scope !== "working") {
    await runGit(file.root, ["restore", "--staged", "--", file.repoPath]);
  }
  await runGitChecked(file.root, ["restore", "--", file.repoPath], "Revert Git file");
}

function patchTarget(patch: string): string | null {
  const match = patch.match(/^(?:---|\+\+\+)\s+(.+?)(?:\t.*)?$/m);
  if (!match || match[1] === "/dev/null") return null;
  return match[1].replace(/^[ab]\//, "");
}

async function applyHunk(directory: string, filePath: string, patch: string, action: string): Promise<void> {
  if (!patch.trim() || !/^@@\s/m.test(patch)) throw new GitHttpError(400, "patch must contain a hunk header");
  const file = await repositoryFile(directory, filePath);
  const target = patchTarget(patch);
  if (target && target !== file.repoPath && target !== filePath) {
    throw new GitHttpError(400, "patch target path does not match the requested file");
  }
  const tempRoot = await mkdtemp(join(process.env.TMPDIR || "/tmp", "openchamber-hunk-"));
  const patchPath = join(tempRoot, "change.patch");
  await writeFile(patchPath, patch, "utf8");
  const flags = action === "stage" ? ["--cached"] : action === "unstage" ? ["--cached", "--reverse"] : action === "discard" ? ["--reverse"] : [];
  if (flags.length === 0) throw new GitHttpError(400, "action must be stage, unstage, or discard");
  try {
    const check = await runGit(file.root, ["apply", ...flags, "--check", patchPath]);
    if (!check.ok) throw new GitHttpError(409, "Hunk no longer applies; refresh and try again");
    await runGitChecked(file.root, ["apply", ...flags, patchPath], "Apply Git hunk");
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseShortStat(value: string): ShortStat {
  const line = value.split("\n").find((entry) => /file[s]? changed/.test(entry)) || "";
  const changes = Number.parseInt(line.match(/(\d+)\s+file[s]? changed/)?.[1] || "0", 10);
  const insertions = Number.parseInt(line.match(/(\d+)\s+insertion/)?.[1] || "0", 10);
  const deletions = Number.parseInt(line.match(/(\d+)\s+deletion/)?.[1] || "0", 10);
  return { changes, insertions, deletions };
}

async function commitChanges(directory: string, body: GitRecord): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const message = requiredString(body.message, "message");
  const files = Array.isArray(body.files) ? body.files.filter((value): value is string => isGitString(value) && value.trim().length > 0) : [];
  const stage = Array.isArray(body.stageFiles) ? body.stageFiles.filter((value): value is string => isGitString(value) && value.trim().length > 0) : [];
  if (body.addAll === true) {
    await runGitChecked(root, ["add", "-A"], "Stage all Git files");
  } else if (stage.length > 0) {
    await stageFiles(root, stage);
  } else if (files.length > 0) {
    await stageFiles(root, files);
  }
  const args = ["commit", "-m", message];
  if (files.length > 0 && stage.length === 0) {
    const repoPaths = await Promise.all(files.map(async (path) => (await repositoryFile(directory, path)).repoPath));
    args.push("--", ...repoPaths);
  }
  const result = await runGitChecked(root, args, "Create Git commit");
  const hash = (await runGitChecked(root, ["rev-parse", "HEAD"], "Read Git commit")).stdout.trim();
  const branch = (await runGit(root, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
  const summary = parseShortStat((await runGit(root, ["show", "--shortstat", "--format=", "HEAD"])).stdout);
  return { success: true, commit: hash, branch, summary, output: result.stdout.trim() };
}

function rawGitOptions(value: GitInput): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => isGitString(entry));
  if (!isRecord(value)) return [];
  const args: string[] = [];
  for (const [key, optionValue] of Object.entries(value)) {
    if (!key.startsWith("-")) continue;
    args.push(key);
    if (isGitString(optionValue) && optionValue) args.push(optionValue);
  }
  return args;
}

async function pull(directory: string, body: GitRecord): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const remote = optionalString(body.remote);
  let branch = optionalString(body.branch);
  if (remote && !branch) branch = (await runGit(root, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
  const args = ["pull"];
  if (body.rebase === true) args.push("--rebase");
  args.push(...rawGitOptions(body.options));
  if (remote) {
    args.push(remote);
    if (branch) args.push(branch);
  } else if (branch) {
    args.push("origin", branch);
  }
  const result = await runGitChecked(root, args, "Pull Git changes");
  const summary = parseShortStat(result.stdout);
  return { success: true, summary, files: [], insertions: summary.insertions, deletions: summary.deletions, output: result.stdout.trim() };
}

async function push(directory: string, body: GitRecord): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const remote = optionalString(body.remote);
  const requestedBranch = optionalString(body.branch);
  const branch = requestedBranch || (await runGit(root, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
  const args = ["push", ...rawGitOptions(body.options)];
  if (remote) {
    args.push(remote);
    if (requestedBranch) args.push(branch);
  } else if (requestedBranch) {
    args.push("origin", branch);
  }
  let result = await runGit(root, args);
  if (!result.ok && /upstream|set-upstream|no upstream/i.test(`${result.stderr}\n${result.stdout}`) && branch) {
    const fallbackRemote = remote || (await runGit(root, ["remote"])).stdout.split("\n").map((entry) => entry.trim()).find(Boolean) || "origin";
    result = await runGit(root, ["push", "--set-upstream", fallbackRemote, branch]);
  }
  if (!result.ok) throw new GitCommandError("Push Git changes", result);
  return { success: true, pushed: remote && branch ? [{ local: branch, remote: `${remote}/${branch}` }] : [], repo: root, ref: null, output: result.stdout.trim() };
}

async function fetchRemote(directory: string, body: GitRecord): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const remote = optionalString(body.remote);
  const branch = optionalString(body.branch);
  const args = ["fetch", ...rawGitOptions(body.options)];
  if (remote) args.push(remote);
  if (branch) args.push(branch);
  await runGitChecked(root, args, "Fetch Git changes");
  return { success: true };
}

async function listStashes(directory: string): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const result = await runGitChecked(root, ["stash", "list", "--format=%gd%x1f%gs%x1f%cr%x1f%H"], "List Git stashes");
  const stashes = result.stdout.split("\n").filter(Boolean).map((line) => {
    const [ref = "", message = "", relativeTime = "", hash = ""] = line.split("\x1f");
    return { ref, message, relativeTime, hash };
  }).filter((entry) => entry.ref);
  return { stashes };
}

async function stashPush(directory: string, body: GitRecord): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const message = optionalString(body.message) || `OpenChamber stash ${new Date().toISOString()}`;
  const result = await runGitChecked(root, ["stash", "push", "--include-untracked", "-m", message], "Stash Git changes");
  return { success: true, created: !/no local changes/i.test(result.stdout), message, output: result.stdout.trim() };
}

async function stashRefAction(directory: string, action: "apply" | "pop" | "drop", body: GitRecord): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const ref = optionalString(body.ref) || "stash@{0}";
  if (!/^stash@\{\d+\}$/.test(ref)) throw new GitHttpError(400, "Invalid stash ref");
  if (action === "apply" || action === "pop") {
    const indexed = await runGit(root, ["stash", "apply", "--index", ref]);
    if (!indexed.ok) await runGitChecked(root, ["stash", "apply", ref], "Apply Git stash");
    if (action === "pop") await runGitChecked(root, ["stash", "drop", ref], "Drop Git stash");
  } else {
    await runGitChecked(root, ["stash", action, ref], "Drop Git stash");
  }
  return { success: true, ref };
}

async function stashFileCounts(directory: string, refs: string[]): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const counts: Record<string, number> = {};
  for (const ref of [...new Set(refs)].filter(Boolean)) {
    const result = await runGit(root, ["stash", "show", "--name-only", ref]);
    counts[ref] = result.ok ? result.stdout.split("\n").filter(Boolean).length : 0;
  }
  return { counts };
}

async function refExists(directory: string, ref: string): Promise<boolean> {
  return (await runGit(directory, ["show-ref", "--verify", "--quiet", ref])).ok;
}

async function createBranch(directory: string, name: string, startPoint: string): Promise<GitRecord> {
  const branch = normalizeBranchName(name);
  if (!branch || branch.includes("..") || branch.startsWith("-") || branch.endsWith(".")) {
    throw new GitHttpError(400, "Invalid branch name");
  }
  const root = await repositoryRoot(directory);
  await runGitChecked(root, ["checkout", "-b", branch, startPoint || "HEAD"], "Create Git branch");
  return { success: true, branch };
}

async function deleteBranch(directory: string, name: string, force: boolean): Promise<GitRecord> {
  const branch = normalizeBranchName(name);
  const root = await repositoryRoot(directory);
  await runGitChecked(root, ["branch", force ? "-D" : "-d", branch], "Delete Git branch");
  return { success: true };
}

async function renameBranch(directory: string, oldName: string, newName: string): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  await runGitChecked(root, ["branch", "-m", normalizeBranchName(oldName), normalizeBranchName(newName)], "Rename Git branch");
  return { success: true, branch: normalizeBranchName(newName) };
}

async function checkoutBranch(directory: string, requestedName: string): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const requested = requestedName.trim();
  if (!requested) throw new GitHttpError(400, "branch is required");
  const local = normalizeBranchName(requested);
  if (await refExists(root, `refs/heads/${local}`)) {
    await runGitChecked(root, ["checkout", local], "Checkout Git branch");
    return { success: true, branch: local };
  }
  const remoteRef = normalizeRemoteBranchName(requested);
  const slash = remoteRef.indexOf("/");
  if (slash > 0) {
    const remote = remoteRef.slice(0, slash);
    const branch = remoteRef.slice(slash + 1);
    const fullRemoteRef = `refs/remotes/${remote}/${branch}`;
    if (branch !== "HEAD" && !(await runGit(root, ["remote", "get-url", remote])).ok) {
      await runGitChecked(root, ["checkout", requested], "Checkout Git branch");
      return { success: true, branch: requested };
    }
    if (branch !== "HEAD" && !(await refExists(root, fullRemoteRef))) {
      const fetched = await runGit(root, ["fetch", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
      if (!fetched.ok) throw new GitCommandError("Fetch Git remote branch", fetched);
    }
    if (await refExists(root, fullRemoteRef)) {
      await runGitChecked(root, ["checkout", "-b", branch, "--track", `${remote}/${branch}`], "Checkout Git remote branch");
      return { success: true, branch };
    }
  }
  await runGitChecked(root, ["checkout", requested], "Checkout Git branch");
  return { success: true, branch: requested };
}

async function checkoutCommit(directory: string, hash: string): Promise<GitRecord> {
  if (!validCommitHash(hash)) throw new GitHttpError(400, "Invalid commit hash");
  await runGitChecked(await repositoryRoot(directory), ["checkout", hash], "Checkout Git commit");
  return { success: true };
}

async function conflictFiles(directory: string): Promise<string[]> {
  const root = await repositoryRoot(directory);
  return (await runGit(root, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function conflictAwareCommand(directory: string, args: string[], label: string): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const result = await runGit(root, args);
  if (result.ok) return { success: true, conflict: false };
  const files = await conflictFiles(root).catch(() => []);
  if (files.length > 0 || /conflict|could not apply|automatic merge failed|revert failed/i.test(`${result.stderr}\n${result.stdout}`)) {
    return { success: false, conflict: true, conflictFiles: files };
  }
  throw new GitCommandError(label, result);
}

async function resetToCommit(directory: string, hash: string, mode: string, force: boolean): Promise<GitRecord> {
  if (!validCommitHash(hash)) throw new GitHttpError(400, "Invalid commit hash");
  if (!["soft", "mixed", "hard"].includes(mode)) throw new GitHttpError(400, "mode must be soft, mixed, or hard");
  const root = await repositoryRoot(directory);
  if (mode === "hard" && !force) {
    const status = await getStatus(root, true);
    if (status.isClean !== true) throw new GitHttpError(409, "Cannot hard reset with uncommitted changes; use force to override");
  }
  await runGitChecked(root, ["reset", `--${mode}`, hash], "Reset Git commit");
  return { success: true };
}

async function getRemotes(directory: string): Promise<GitRecord[]> {
  const root = await repositoryRoot(directory);
  const names = (await runGit(root, ["remote"])).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  return Promise.all(names.map(async (name) => {
    const fetchUrl = (await runGit(root, ["remote", "get-url", "--fetch", name])).stdout.trim();
    const pushResult = await runGit(root, ["remote", "get-url", "--push", name]);
    return { name, fetchUrl: sanitizeRemoteUrl(fetchUrl), pushUrl: sanitizeRemoteUrl(pushResult.stdout.trim() || fetchUrl) };
  }));
}

async function getRemoteUrl(directory: string, remote: string): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const result = await runGit(root, ["remote", "get-url", remote || "origin"]);
  return { url: result.ok ? sanitizeRemoteUrl(result.stdout) : null };
}

async function removeRemote(directory: string, remote: string): Promise<GitRecord> {
  if (!remote) throw new GitHttpError(400, "remote is required");
  if (remote === "origin") throw new GitHttpError(400, "Cannot remove origin remote");
  await runGitChecked(await repositoryRoot(directory), ["remote", "remove", remote], "Remove Git remote");
  return { success: true };
}

async function deleteRemoteBranch(directory: string, branch: string, remote: string): Promise<GitRecord> {
  const target = normalizeBranchName(branch);
  if (!target) throw new GitHttpError(400, "branch is required");
  await runGitChecked(await repositoryRoot(directory), ["push", remote || "origin", `:${target}`], "Delete Git remote branch");
  return { success: true };
}

async function continueOperation(directory: string, operation: "merge" | "rebase"): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const args = operation === "merge" ? ["commit", "--no-edit"] : ["rebase", "--continue"];
  const result = await runGit(root, args);
  if (result.ok) return { success: true, conflict: false };
  const files = await conflictFiles(root).catch(() => []);
  if (files.length > 0 || /conflict|unmerged|needs merge|fix conflicts/i.test(`${result.stderr}\n${result.stdout}`)) {
    return { success: false, conflict: true, conflictFiles: files };
  }
  if (operation === "rebase" && /nothing to commit|no changes/i.test(`${result.stderr}\n${result.stdout}`)) {
    const skip = await runGit(root, ["rebase", "--skip"]);
    if (skip.ok) return { success: true, conflict: false };
  }
  throw new GitCommandError(`Continue Git ${operation}`, result);
}

async function getConflictDetails(directory: string): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const status = await runGit(root, ["status", "--porcelain"]);
  const files = await conflictFiles(root);
  const diff = await runGit(root, ["diff"]);
  const mergeHead = await runGit(root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
  const rebaseHead = await runGit(root, ["rev-parse", "--verify", "--quiet", "REBASE_HEAD"]);
  const operation = mergeHead.ok ? "merge" : "rebase";
  const head = mergeHead.ok ? mergeHead.stdout : rebaseHead.stdout;
  return {
    statusPorcelain: status.stdout.trim(),
    unmergedFiles: files,
    diff: diff.stdout.trim(),
    headInfo: head.trim() ? `${operation === "merge" ? "MERGE_HEAD" : "REBASE_HEAD"}: ${head.trim()}` : "",
    operation,
  };
}

function logEntryFromRecord(record: string): GitRecord | null {
  const lines = record.split("\n");
  const header = lines.shift() || "";
  const [hash, parents, authorName, authorEmail, date, message, refs] = header.split("\x1f");
  if (!hash) return null;
  const stats = parseShortStat(lines.join("\n"));
  return {
    hash,
    date: date || "",
    message: message || "",
    refs: refs || "",
    body: "",
    author_name: authorName || "",
    author_email: authorEmail || "",
    filesChanged: stats.changes,
    insertions: stats.insertions,
    deletions: stats.deletions,
    parents: parents ? parents.split(" ").filter(Boolean) : [],
  };
}

async function getLog(directory: string, query: URLSearchParams): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const maxCountRaw = Number.parseInt(query.get("maxCount") || "50", 10);
  const maxCount = Number.isFinite(maxCountRaw) ? Math.max(1, Math.min(500, maxCountRaw)) : 50;
  const args = ["log", `--max-count=${maxCount}`, "--date=iso", "--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D", "--shortstat"];
  if (query.get("all") === "true") args.push("--all", "--topo-order");
  let from = optionalString(query.get("from"));
  const to = optionalString(query.get("to"));
  if (from && !(await runGit(root, ["rev-parse", "--verify", from])).ok && (await runGit(root, ["rev-parse", "--verify", `refs/remotes/origin/${from}`])).ok) {
    from = `origin/${from}`;
  }
  if (from && to) args.push(`${from}..${to}`);
  else if (from) args.push(`${from}..HEAD`);
  else if (to) args.push(to);
  const file = optionalString(query.get("file"));
  if (file) args.push("--", (await repositoryFile(root, file)).repoPath);
  const result = await runGitChecked(root, args, "Read Git log");
  const all = result.stdout.split("\x1e").map(logEntryFromRecord).filter((entry): entry is GitRecord => entry !== null);
  return { all, latest: all[0] || null, total: all.length };
}

async function getCommitSummaries(directory: string, shas: string[]): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const requested = [...new Set(shas)].slice(0, 100);
  if (requested.some((sha) => !validIntegrationSha(sha))) throw new GitHttpError(400, "Invalid commit SHA");
  const commits: GitRecord[] = [];
  for (const sha of requested) {
    const result = await runGit(root, ["show", "-s", "--format=%H%x1f%h%x1f%s", sha]);
    if (!result.ok) continue;
    const [full, short, subject] = result.stdout.trim().split("\x1f");
    commits.push({ sha: full || sha, short: short || sha.slice(0, 7), subject: subject || "" });
  }
  return { commits };
}

async function getCommitFiles(directory: string, hash: string): Promise<GitRecord> {
  if (!validCommitHash(hash)) throw new GitHttpError(400, "hash must be a valid commit SHA");
  const root = await repositoryRoot(directory);
  const numstat = await runGitChecked(root, ["show", "--numstat", "--format=", hash], "Read commit files");
  const statuses = (await runGit(root, ["show", "--name-status", "--format=", hash])).stdout.split("\n").filter(Boolean);
  const statusByPath = new Map<string, string>();
  for (const line of statuses) {
    const [status, ...paths] = line.split("\t");
    const path = paths.at(-1) || "";
    if (path) statusByPath.set(path, status?.[0] || "M");
  }
  const files: GitRecord[] = [];
  for (const line of numstat.stdout.split("\n").filter(Boolean)) {
    const [added, deleted, ...paths] = line.split("\t");
    const path = paths.join("\t");
    if (!path) continue;
    files.push({
      path,
      insertions: added === "-" ? 0 : Number.parseInt(added, 10) || 0,
      deletions: deleted === "-" ? 0 : Number.parseInt(deleted, 10) || 0,
      isBinary: added === "-" && deleted === "-",
      changeType: statusByPath.get(path) || (path.includes(" => ") ? "R" : "M"),
    });
  }
  return { files };
}

async function getCommitFileDiff(directory: string, hash: string, filePath: string, binary: boolean): Promise<GitRecord> {
  if (!validCommitHash(hash)) throw new GitHttpError(400, "hash must be a valid commit SHA");
  if (binary) return { original: "", modified: "", isBinary: true };
  const file = await repositoryFile(directory, filePath);
  const original = await runGit(file.root, ["show", `${hash}^:${file.repoPath}`]);
  const modified = await runGit(file.root, ["show", `${hash}:${file.repoPath}`]);
  if (!original.ok && !modified.ok) throw new GitCommandError("Read commit file diff", modified);
  return { original: original.ok ? original.stdout : "", modified: modified.ok ? modified.stdout : "", isBinary: false };
}

function configRoot(): string {
  return process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "openchamber") : join(process.env.HOME || homedir(), ".config", "openchamber");
}

function profilesPath(): string {
  return join(configRoot(), "git-identities.json");
}

async function readProfiles(): Promise<GitRecord[]> {
  const text = await readFile(profilesPath(), "utf8").catch(() => "");
  if (!text) return [];
  try {
    const parsed: GitJsonValue = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter(isRecord);
    if (isRecord(parsed) && Array.isArray(parsed.profiles)) return parsed.profiles.filter(isRecord);
    return [];
  } catch {
    return [];
  }
}

async function writeProfiles(profiles: GitRecord[]): Promise<void> {
  await mkdir(configRoot(), { recursive: true });
  await writeFile(profilesPath(), `${JSON.stringify({ profiles }, null, 2)}\n`, "utf8");
}

function profileValue(body: GitRecord, key: string): string | null {
  const value = body[key];
  return isGitString(value) ? value.trim() : null;
}

async function createProfile(body: GitRecord): Promise<GitRecord> {
  const id = requiredString(body.id, "id");
  const userName = requiredString(body.userName, "userName");
  const userEmail = requiredString(body.userEmail, "userEmail");
  const name = optionalString(body.name) || userName;
  const profiles = await readProfiles();
  if (profiles.some((profile) => profile.id === id)) throw new GitHttpError(409, `Profile with ID "${id}" already exists`);
  const profile: GitRecord = {
    id,
    name,
    userName,
    userEmail,
    authType: optionalString(body.authType) || "ssh",
    sshKey: profileValue(body, "sshKey"),
    color: optionalString(body.color) || "keyword",
    icon: optionalString(body.icon) || "branch",
  };
  for (const key of ["signingKey", "host"]) {
    const value = profileValue(body, key);
    if (value) profile[key] = value;
  }
  if (isGitBoolean(body.signCommits)) profile.signCommits = body.signCommits;
  profiles.push(profile);
  await writeProfiles(profiles);
  return profile;
}

async function updateProfile(id: string, body: GitRecord): Promise<GitRecord> {
  const profiles = await readProfiles();
  const index = profiles.findIndex((profile) => profile.id === id);
  if (index < 0) throw new GitHttpError(404, "Git identity profile not found");
  const existing = profiles[index];
  const next: GitRecord = { ...existing };
  for (const key of ["name", "userName", "userEmail", "authType", "sshKey", "signingKey", "host", "color", "icon"]) {
    if (body[key] !== undefined) {
      const value = profileValue(body, key);
      if (value) next[key] = value;
      else delete next[key];
    }
  }
  if (isGitBoolean(body.signCommits)) next.signCommits = body.signCommits;
  profiles[index] = next;
  await writeProfiles(profiles);
  return next;
}

async function deleteProfile(id: string): Promise<GitRecord> {
  const profiles = await readProfiles();
  const filtered = profiles.filter((profile) => profile.id !== id);
  if (filtered.length === profiles.length) throw new GitHttpError(404, "Git identity profile not found");
  await writeProfiles(filtered);
  return { success: true };
}

async function configValue(directory: string, scope: "global" | "local", key: string): Promise<string | null> {
  const result = await runGit(directory, ["config", `--${scope}`, "--get", key]);
  return result.ok ? result.stdout.trim() || null : null;
}

async function identitySummary(directory: string, scope: "global" | "local"): Promise<GitRecord> {
  const cwd = scope === "global" ? process.env.HOME || homedir() : directory;
  const [userName, userEmail, sshCommand] = scope === "local"
    ? await Promise.all([
      configValue(cwd, "local", "user.name").then((value) => value || configValue(cwd, "global", "user.name")),
      configValue(cwd, "local", "user.email").then((value) => value || configValue(cwd, "global", "user.email")),
      configValue(cwd, "local", "core.sshCommand").then((value) => value || configValue(cwd, "global", "core.sshCommand")),
    ])
    : await Promise.all([
      configValue(cwd, scope, "user.name"),
      configValue(cwd, scope, "user.email"),
      configValue(cwd, scope, "core.sshCommand"),
    ]);
  return { userName, userEmail, sshCommand };
}

async function hasLocalIdentity(directory: string): Promise<GitRecord> {
  const root = await repositoryRoot(directory).catch(() => resolve(directory));
  const name = await configValue(root, "local", "user.name");
  const email = await configValue(root, "local", "user.email");
  return { hasLocalIdentity: Boolean(name || email) };
}

async function setIdentity(directory: string, profileId: string): Promise<GitRecord> {
  const profiles = await readProfiles();
  let profile = profiles.find((entry) => entry.id === profileId);
  if (!profile && profileId === "global") {
    const global = await identitySummary(directory, "global");
    if (!global.userName && !global.userEmail) throw new GitHttpError(404, "Global identity is not configured");
    profile = { id: "global", name: "Global Identity", userName: global.userName, userEmail: global.userEmail, sshKey: global.sshCommand };
  }
  if (!profile) throw new GitHttpError(404, "Git identity profile not found");
  const root = await repositoryRoot(directory);
  await runGitChecked(root, ["config", "--local", "user.name", requiredString(profile.userName, "userName")], "Set local Git identity");
  await runGitChecked(root, ["config", "--local", "user.email", requiredString(profile.userEmail, "userEmail")], "Set local Git identity");
  if (profile.authType === "token" && isGitString(profile.host) && profile.host.trim()) {
    await runGitChecked(root, ["config", "--local", "credential.helper", "store"], "Set Git credential identity");
    await runGit(root, ["config", "--local", "--unset", "core.sshCommand"]);
  } else if (isGitString(profile.sshKey) && profile.sshKey.trim()) {
    const keyPath = expandHome(profile.sshKey.trim());
    await runGitChecked(root, ["config", "--local", "core.sshCommand", `ssh -i ${keyPath} -o IdentitiesOnly=yes`], "Set Git SSH identity");
    await runGit(root, ["config", "--local", "--unset", "credential.helper"]);
  }
  if (profile.signCommits === true) {
    await runGitChecked(root, ["config", "--local", "gpg.format", "ssh"], "Set Git signing identity");
    await runGitChecked(root, ["config", "--local", "commit.gpgSign", "true"], "Set Git signing identity");
    if (isGitString(profile.signingKey) && profile.signingKey.trim()) {
      await runGitChecked(root, ["config", "--local", "user.signingKey", profile.signingKey.trim()], "Set Git signing key");
    }
  }
  return { success: true, profile };
}

async function discoverCredentials(): Promise<GitRecord[]> {
  const credentialFile = join(process.env.HOME || homedir(), ".git-credentials");
  const text = await readFile(credentialFile, "utf8").catch(() => "");
  const results: GitRecord[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    try {
      const parsed = new URL(line);
      const key = `${parsed.host}\x1f${parsed.username}`;
      if (parsed.hostname && parsed.username && !seen.has(key)) {
        seen.add(key);
        const host = `${parsed.hostname}${parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : ""}`;
        results.push({ host, username: decodeURIComponent(parsed.username) });
      }
    } catch {
      // Ignore malformed credential entries without returning their contents.
    }
  }
  return results;
}

async function worktreeStorageRoot(repoRoot: string): Promise<string> {
  const root = resolve(repoRoot);
  const commonResult = await runGit(root, ["rev-parse", "--git-common-dir"]);
  const commonDir = await canonicalPath(resolve(root, commonResult.stdout.trim() || ".git"));
  const projectIdPath = join(commonDir, "opencode");
  let projectId = await readFile(projectIdPath, "utf8").then((value) => value.trim()).catch(() => "");
  if (!projectId) {
    const roots = (await runGit(root, ["rev-list", "--max-parents=0", "--all"])).stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort();
    projectId = roots[0] || createHash("sha256").update(root).digest("hex");
    await writeFile(projectIdPath, `${projectId}\n`, "utf8").catch(() => undefined);
  }
  const dataHome = process.env.XDG_DATA_HOME || join(process.env.HOME || homedir(), ".local", "share");
  return join(dataHome, "opencode", "worktree", projectId);
}

function slugWorktreeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72);
}

async function worktreeCandidate(repoRoot: string, requestedName: string, requestedBranch: string, mode: string): Promise<{ name: string; branch: string; path: string }> {
  const root = await worktreeStorageRoot(repoRoot);
  const base = slugWorktreeName(requestedName) || slugWorktreeName(requestedBranch) || "worktree";
  const branch = mode === "new" ? normalizeBranchName(requestedBranch) || `openchamber/${base}` : `openchamber/${base}`;
  for (let index = 0; index < 100; index += 1) {
    const name = index === 0 ? base : `${base}-${index}`;
    const path = join(root, name);
    if (!(await pathExists(path)) && !(await refExists(repoRoot, `refs/heads/${branch}`))) {
      return { name, branch, path };
    }
    if (mode === "existing" && !(await pathExists(path))) {
      return { name, branch, path };
    }
  }
  throw new GitHttpError(409, "Could not allocate a unique Git worktree name");
}

function parseRemoteBranchRef(value: string): { remote: string; branch: string; ref: string } | null {
  const normalized = normalizeRemoteBranchName(value);
  const separator = normalized.indexOf("/");
  if (separator <= 0 || separator === normalized.length - 1) return null;
  const remote = normalized.slice(0, separator);
  const branch = normalized.slice(separator + 1);
  return { remote, branch, ref: `${remote}/${branch}` };
}

async function remoteBranchFromRef(repoRoot: string, value: string): Promise<{ remote: string; branch: string; ref: string } | null> {
  const parsed = parseRemoteBranchRef(value);
  if (!parsed || !(await runGit(repoRoot, ["remote", "get-url", parsed.remote])).ok) return null;
  return parsed;
}

async function ensureRemoteWithUrl(repoRoot: string, remote: string, url: string): Promise<void> {
  if (!remote || !url) return;
  const current = await runGit(repoRoot, ["remote", "get-url", remote]);
  if (current.ok) {
    if (current.stdout.trim() !== url) await runGitChecked(repoRoot, ["remote", "set-url", remote, url], "Update Git remote URL");
    return;
  }
  await runGitChecked(repoRoot, ["remote", "add", remote, url], "Add Git remote");
}

async function fetchRemoteBranch(repoRoot: string, remote: string, branch: string): Promise<void> {
  const result = await runGit(repoRoot, ["fetch", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  if (!result.ok) throw new GitCommandError(`Fetch ${remote}/${branch}`, result);
}

async function worktreeBranchInUse(repoRoot: string, branch: string): Promise<string | null> {
  const entries = parseWorktreePorcelain((await runGit(repoRoot, ["worktree", "list", "--porcelain"])).stdout);
  const target = normalizeBranchName(branch);
  return entries.find((entry) => entry.branch === target)?.worktree || null;
}

async function worktreeBootstrapStatus(directory: string): Promise<BootstrapState> {
  const key = resolve(directory);
  return bootstrapStates.get(key) || {
    status: "ready",
    phase: "setup-ready",
    error: null,
    updatedAt: Date.now(),
  };
}

function setBootstrap(directory: string, state: BootstrapInputState): BootstrapState {
  const next = { ...state, updatedAt: Date.now() };
  bootstrapStates.set(resolve(directory), next);
  return next;
}

function runSetupCommand(directory: string, command: string): Promise<void> {
  return new Promise((resolveSetup, rejectSetup) => {
    execFile("/bin/sh", ["-lc", command], { cwd: directory, env: process.env, maxBuffer: MAX_OUTPUT }, (error, _stdout, stderr) => {
      if (error) {
        rejectSetup(new Error(sanitizeGitText(String(stderr || error.message || "setup command failed"))));
        return;
      }
      resolveSetup();
    });
  });
}

async function validateWorktreeCreate(directory: string, body: GitRecord): Promise<GitRecord> {
  const errors: GitRecord[] = [];
  const mode = body.mode === "existing" ? "existing" : "new";
  try {
    const root = await repositoryRoot(directory);
    const preferredBranch = normalizeBranchName(optionalString(body.branchName));
    const existingSource = optionalString(body.existingBranch) || preferredBranch;
    let localBranch = preferredBranch;
    if (mode === "existing") {
      if (!existingSource) {
        errors.push({ code: "branch_not_found", message: "existingBranch is required" });
      } else if (await refExists(root, `refs/heads/${normalizeBranchName(existingSource)}`)) {
        localBranch = normalizeBranchName(existingSource);
      } else {
        const remoteSource = parseRemoteBranchRef(existingSource);
        const remoteAvailable = remoteSource && (
          (await runGit(root, ["remote", "get-url", remoteSource.remote])).ok
          || (remoteSource.remote === optionalString(body.ensureRemoteName) && Boolean(optionalString(body.ensureRemoteUrl)))
        );
        const remoteRefExists = remoteSource && await refExists(root, `refs/remotes/${remoteSource.remote}/${remoteSource.branch}`);
        if (!remoteAvailable || (!remoteRefExists && !(remoteSource.remote === optionalString(body.ensureRemoteName) && Boolean(optionalString(body.ensureRemoteUrl))))) {
          errors.push({ code: "branch_not_found", message: `Branch not found: ${existingSource}` });
        } else {
          localBranch = preferredBranch || remoteSource.branch;
        }
      }
    } else if (preferredBranch && await refExists(root, `refs/heads/${preferredBranch}`)) {
      errors.push({ code: "branch_exists", message: `Branch already exists: ${preferredBranch}` });
    }
    if (localBranch) {
      const inUse = await worktreeBranchInUse(root, localBranch);
      if (inUse) errors.push({ code: "branch_in_use", message: `Branch is already checked out in ${inUse}` });
    }
    const startRef = optionalString(body.startRef);
    if (mode === "new" && startRef && startRef !== "HEAD") {
      const remoteStart = parseRemoteBranchRef(startRef);
      const localStart = await runGit(root, ["rev-parse", "--verify", `${startRef}^{commit}`]);
      const remoteStartExists = remoteStart && await refExists(root, `refs/remotes/${remoteStart.remote}/${remoteStart.branch}`);
      const remoteConfigured = remoteStart && remoteStart.remote === optionalString(body.ensureRemoteName) && Boolean(optionalString(body.ensureRemoteUrl));
      if (!localStart.ok && !remoteStartExists && !remoteConfigured) errors.push({ code: "start_ref_not_found", message: `Start ref not found: ${startRef}` });
    }
    if ((optionalString(body.ensureRemoteName) && !optionalString(body.ensureRemoteUrl)) || (!optionalString(body.ensureRemoteName) && optionalString(body.ensureRemoteUrl))) {
      errors.push({ code: "invalid_remote_config", message: "Both ensureRemoteName and ensureRemoteUrl are required together" });
    }
    if (body.setUpstream === true) {
      const upstreamRemote = optionalString(body.upstreamRemote) || optionalString(body.ensureRemoteName);
      const upstreamBranch = optionalString(body.upstreamBranch) || localBranch;
      if (!upstreamRemote || !upstreamBranch) {
        errors.push({ code: "upstream_incomplete", message: "upstreamRemote and upstreamBranch are required when setUpstream is true" });
      } else if (!(await runGit(root, ["remote", "get-url", upstreamRemote])).ok && upstreamRemote !== optionalString(body.ensureRemoteName)) {
        errors.push({ code: "remote_not_found", message: `Remote not found: ${upstreamRemote}` });
      }
    }
    return { ok: errors.length === 0, errors, resolved: { mode, localBranch: localBranch || null } };
  } catch (error) {
    errors.push({ code: "validation_failed", message: error instanceof Error ? error.message : "Failed to validate worktree creation" });
    return { ok: false, errors };
  }
}

async function previewWorktree(directory: string, body: GitRecord): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const mode = body.mode === "existing" ? "existing" : "new";
  const branch = normalizeBranchName(optionalString(body.branchName) || optionalString(body.existingBranch));
  const candidate = await worktreeCandidate(root, optionalString(body.worktreeName) || optionalString(body.name), branch, mode);
  return { name: candidate.name, branch: mode === "new" ? candidate.branch : branch, path: candidate.path };
}

async function createWorktree(directory: string, body: GitRecord): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const mode = body.mode === "existing" ? "existing" : "new";
  const preferredBranch = normalizeBranchName(optionalString(body.branchName));
  const requestedSource = optionalString(body.existingBranch) || preferredBranch;
  const candidate = await worktreeCandidate(
    root,
    optionalString(body.worktreeName) || optionalString(body.name) || requestedSource,
    mode === "new" ? preferredBranch : "",
    mode,
  );
  const remoteName = optionalString(body.ensureRemoteName);
  const remoteUrl = optionalString(body.ensureRemoteUrl);
  if (remoteName && remoteUrl) {
    await ensureRemoteWithUrl(root, remoteName, remoteUrl);
  }
  if (body.returnAfterDirectoryCreated === true) {
    const validation = await validateWorktreeCreate(directory, body);
    if (validation.ok !== true) {
      const messages = Array.isArray(validation.errors)
        ? validation.errors.map((entry) => isRecord(entry) ? optionalString(entry.message) : "").filter(Boolean)
        : [];
      throw new GitHttpError(400, messages.join("\n") || "Failed to validate worktree creation");
    }
  }
  let effectiveStartRef = optionalString(body.startRef);
  let sourceFetchFailed = false;
  if (mode === "new") {
    const remoteStart = await remoteBranchFromRef(root, effectiveStartRef);
    if (remoteStart && !(await refExists(root, `refs/remotes/${remoteStart.remote}/${remoteStart.branch}`))) {
      try {
        await fetchRemoteBranch(root, remoteStart.remote, remoteStart.branch);
      } catch (error) {
        const status = await getStatus(root, true).catch(() => null);
        const tracking = status && isGitString(status.tracking) ? parseRemoteBranchRef(status.tracking) : null;
        const currentBranch = status && isGitString(status.current) ? status.current : "";
        const canUseCurrent = currentBranch && status && status.ahead === 0
          && tracking?.remote === remoteStart.remote && tracking.branch === remoteStart.branch;
        if (!canUseCurrent) throw error;
        effectiveStartRef = currentBranch;
        sourceFetchFailed = true;
      }
    }
  }

  const attach = async (): Promise<GitRecord> => {
    let branch = candidate.branch;
    let args: string[];
    let inferredUpstream: { remote: string; branch: string } | null = null;
    if (mode === "existing") {
      const source = requiredString(requestedSource, "existingBranch");
      const localSource = normalizeBranchName(source);
      const localExists = await refExists(root, `refs/heads/${localSource}`);
      const remoteSource = await remoteBranchFromRef(root, source);
      if (remoteSource && !localExists) {
        const remoteRefExists = await refExists(root, `refs/remotes/${remoteSource.remote}/${remoteSource.branch}`);
        if (!remoteRefExists) await fetchRemoteBranch(root, remoteSource.remote, remoteSource.branch);
        branch = preferredBranch || remoteSource.branch;
        inferredUpstream = { remote: remoteSource.remote, branch: remoteSource.branch };
        if (await worktreeBranchInUse(root, branch)) {
          throw new GitHttpError(409, `Branch is already checked out: ${branch}`);
        }
        args = ["worktree", "add", "-b", branch, candidate.path, remoteSource.ref];
      } else {
        branch = localSource;
        if (await worktreeBranchInUse(root, branch)) {
          throw new GitHttpError(409, `Branch is already checked out: ${branch}`);
        }
        args = ["worktree", "add", candidate.path, branch];
      }
    } else {
      branch = candidate.branch;
      if (await worktreeBranchInUse(root, branch)) {
        throw new GitHttpError(409, `Branch is already checked out: ${branch}`);
      }
      args = ["worktree", "add", "-b", branch, candidate.path];
      const startRef = effectiveStartRef;
      if (startRef && startRef !== "HEAD") {
        const remoteStart = await remoteBranchFromRef(root, startRef);
        if (remoteStart) {
          args.splice(2, 0, "--no-track");
          inferredUpstream = { remote: remoteStart.remote, branch: remoteStart.branch };
        }
        args.push(startRef);
      }
    }

    await runGitChecked(root, args, "Create Git worktree");
    if (body.setUpstream === true) {
      const upstreamRemote = optionalString(body.upstreamRemote) || inferredUpstream?.remote || remoteName;
      const upstreamBranch = optionalString(body.upstreamBranch) || inferredUpstream?.branch || branch;
      if (upstreamRemote && upstreamBranch) {
        await fetchRemoteBranch(root, upstreamRemote, upstreamBranch).catch(() => undefined);
        await runGit(candidate.path, ["branch", `--set-upstream-to=${upstreamRemote}/${upstreamBranch}`, branch]);
      }
    }
    const headResult = await runGit(candidate.path, ["rev-parse", "HEAD"]);
    const head = headResult.ok ? headResult.stdout.trim() : "";
    setBootstrap(candidate.path, { status: "pending", phase: "git-ready", error: null });
    const setup = optionalString(body.startCommand);
    if (setup) await runSetupCommand(candidate.path, setup).catch(() => undefined);
    setBootstrap(candidate.path, { status: "ready", phase: "setup-ready", error: null });
    return { head, name: candidate.name, branch, path: candidate.path, directoryCreated: true, bootstrapStatus: await worktreeBootstrapStatus(candidate.path) };
  };

  if (body.returnAfterDirectoryCreated === true) {
    await mkdir(dirname(candidate.path), { recursive: true });
    await mkdir(candidate.path, { recursive: false });
    const pending = setBootstrap(candidate.path, { status: "pending", phase: "directory-created", error: null });
    void attach().catch(async (error) => {
      await runGit(root, ["worktree", "remove", "--force", candidate.path]);
      await rm(candidate.path, { recursive: true, force: true }).catch(() => undefined);
      setBootstrap(candidate.path, { status: "failed", phase: "directory-created", error: error instanceof Error ? sanitizeGitText(error.message) : "Worktree creation failed" });
    });
    const response: GitRecord = {
      head: "",
      name: candidate.name,
      branch: mode === "new" ? candidate.branch : preferredBranch || requestedSource,
      path: candidate.path,
      directoryCreated: true,
      bootstrapStatus: pending,
    };
    if (sourceFetchFailed) response.sourceFetchFailed = true;
    return response;
  }

  await mkdir(dirname(candidate.path), { recursive: true });
  const result = await attach();
  return sourceFetchFailed ? { ...result, sourceFetchFailed: true } : result;
}

async function removeWorktree(directory: string, body: GitRecord): Promise<GitRecord> {
  const root = await repositoryRoot(directory);
  const target = requiredString(body.directory, "worktree directory");
  const targetPath = await canonicalPath(resolve(expandHome(target)));
  const entries = parseWorktreePorcelain((await runGitChecked(root, ["worktree", "list", "--porcelain"], "List Git worktrees")).stdout);
  let matchedEntry: GitWorktreeEntry | undefined;
  for (const entry of entries) {
    if (await canonicalPath(entry.worktree) === targetPath || resolve(entry.worktree) === targetPath) {
      matchedEntry = entry;
      break;
    }
  }
  if (matchedEntry && targetPath !== resolve(root)) {
    await runGitChecked(root, ["worktree", "remove", "--force", targetPath], "Remove Git worktree");
    if (body.deleteLocalBranch === true && matchedEntry.branch) await runGit(root, ["branch", "-D", matchedEntry.branch]);
  } else if (!matchedEntry && pathIsInside(await worktreeStorageRoot(root), targetPath)) {
    await rm(targetPath, { recursive: true, force: true });
  } else if (targetPath === resolve(root)) {
    throw new GitHttpError(400, "Cannot remove the primary workspace");
  }
  bootstrapStates.delete(targetPath);
  return { success: true };
}

async function validateWorktreeDirectory(directory: string, worktreeRoot: string): Promise<GitRecord> {
  const cwd = await canonicalPath(resolve(expandHome(directory)));
  const root = await canonicalPath(resolve(expandHome(worktreeRoot)));
  const valid = await isGitRepository(cwd);
  return {
    valid,
    insideWorktreeRoot: valid && pathIsInside(root, cwd),
    resolvedWorktreeRoot: valid ? root : null,
    resolvedCwd: valid ? cwd : null,
  };
}

async function canonicalizeWorktreeState(directory: string): Promise<GitRecord> {
  const cwd = resolve(directory);
  if (!(await isGitRepository(cwd))) {
    return { worktreeRoot: null, cwd: null, branch: null, headState: "detached", worktreeStatus: "not-a-repo", legacy: false, degraded: false, attentionReason: null };
  }
  const primary = (await resolvePrimaryRoot(cwd)).root;
  const branchResult = await runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const headResult = await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
  const mergeHead = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
  const rebaseHead = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "REBASE_HEAD"]);
  return {
    worktreeRoot: await worktreeStorageRoot(primary),
    cwd,
    branch: branchResult.ok ? branchResult.stdout.trim() : null,
    headState: branchResult.ok ? "branch" : headResult.ok ? "detached" : "unborn",
    worktreeStatus: "ready",
    legacy: false,
    degraded: false,
    attentionReason: mergeHead.ok ? "merge" : rebaseHead.ok ? "rebase" : null,
  };
}

function normalizeIntegratePath(value: GitInput, name: string): string {
  if (!isGitString(value) || !value.trim()) throw new GitHttpError(400, `${name} is required`);
  return resolve(expandHome(value.trim()));
}

function normalizeIntegrateBranch(value: GitInput, name: string): string {
  const branch = isGitString(value) ? value.trim() : "";
  if (!branch) throw new GitHttpError(400, `${name} is required`);
  if (branch.startsWith("-") || branch.includes("\0")) throw new GitHttpError(400, `Invalid ${name}`);
  return branch;
}

async function ensureLocalIntegrateBranch(repoRoot: string, candidate: string): Promise<string> {
  if (candidate === "HEAD") return candidate;
  if ((await runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`])).ok) return candidate;

  const remoteCandidate = candidate.startsWith("remotes/") ? candidate.slice("remotes/".length) : candidate;
  const separator = remoteCandidate.indexOf("/");
  if (separator <= 0) return candidate;
  const remote = remoteCandidate.slice(0, separator);
  const branch = remoteCandidate.slice(separator + 1);
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  if (!(await runGit(repoRoot, ["show-ref", "--verify", "--quiet", remoteRef])).ok) return candidate;
  await runGitChecked(repoRoot, ["branch", "--track", branch, `${remote}/${branch}`], "Track Git integration target branch");
  return branch;
}

function normalizeIntegrateSha(value: GitInput): string {
  if (!isGitString(value) || !validIntegrationSha(value)) throw new GitHttpError(400, "Invalid integration commit SHA");
  return value.trim();
}

async function computeIntegratePlan(body: GitRecord): Promise<GitRecord> {
  const root = normalizeIntegratePath(body.repoRoot, "repoRoot");
  const source = normalizeIntegrateBranch(body.sourceBranch, "sourceBranch");
  const targetRaw = normalizeIntegrateBranch(body.targetBranch, "targetBranch");
  if (source === "HEAD" || targetRaw === "HEAD") {
    return { repoRoot: root, sourceBranch: source, targetBranch: targetRaw, commits: [] };
  }

  const target = await ensureLocalIntegrateBranch(root, targetRaw);
  const cherry = await runGitChecked(root, ["cherry", target, source], "Compute Git integration plan");
  const equivalent = new Set<string>();
  for (const line of cherry.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    const match = line.match(/^\+\s+([0-9a-f]{4,64})\b/i);
    if (match) equivalent.add(match[1].toLowerCase());
  }
  const revList = await runGitChecked(root, ["rev-list", "--reverse", `${target}..${source}`], "Compute Git integration plan");
  const commits = revList.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((sha) => sha && [...equivalent].some((candidate) => sha.toLowerCase() === candidate || sha.toLowerCase().startsWith(candidate) || candidate.startsWith(sha.toLowerCase())));
  return { repoRoot: root, sourceBranch: source, targetBranch: target, commits };
}

async function integrateConflictDetails(tempWorktreePath: string): Promise<GitRecord> {
  const target = normalizeIntegratePath(tempWorktreePath, "tempWorktreePath");
  const [status, unmerged, diff, meta, patch] = await Promise.all([
    runGit(target, ["status", "--porcelain"]),
    runGit(target, ["diff", "--name-only", "--diff-filter=U"]),
    runGit(target, ["diff"]),
    runGit(target, ["show", "--no-patch", "--pretty=fuller", "CHERRY_PICK_HEAD"]),
    runGit(target, ["show", "CHERRY_PICK_HEAD"]),
  ]);
  return {
    statusPorcelain: status.stdout || status.stderr,
    unmergedFiles: unmerged.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    diff: diff.stdout || diff.stderr,
    currentPatchMeta: meta.stdout || meta.stderr,
    currentPatch: patch.stdout || patch.stderr,
  };
}

async function cherryPickStatus(tempWorktreePath: string): Promise<GitRecord> {
  const path = normalizeIntegratePath(tempWorktreePath, "tempWorktreePath");
  const result = await runGit(path, ["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"]);
  return { inProgress: result.ok };
}

async function createIntegrationTempWorktree(root: string, target: string): Promise<string> {
  const parent = join(configRoot(), "tmp");
  await mkdir(parent, { recursive: true });
  const temp = await mkdtemp(join(parent, "oc-integrate-"));
  const result = await runGit(root, ["worktree", "add", "--force", temp, target]);
  if (!result.ok) {
    await rm(temp, { recursive: true, force: true });
    throw new GitCommandError("Create integration worktree", result);
  }
  return temp;
}

async function removeIntegrationTempWorktree(root: string, temp: string): Promise<void> {
  await runGit(root, ["worktree", "remove", "--force", temp]);
  await runGit(root, ["worktree", "prune"]);
}

async function maybeFastForwardIntegrateUpstream(temp: string): Promise<void> {
  const upstream = await runGit(temp, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const upstreamRef = upstream.stdout.trim();
  if (!upstream.ok || !upstreamRef) return;
  await runGitChecked(temp, ["fetch"], "Fetch Git integration target");
  await runGitChecked(temp, ["merge", "--ff-only", upstreamRef], "Fast-forward Git integration target");
}

async function cleanTargetIntegrateWorktrees(repoRoot: string, targetBranch: string, excluded: string[]): Promise<string[]> {
  const excludedPaths = new Set(await Promise.all(excluded.map((entry) => canonicalPath(entry))));
  const entries = await getWorktrees(repoRoot);
  const clean: string[] = [];
  for (const entry of entries) {
    const worktreePath = optionalString(entry.path);
    if (entry.branch !== targetBranch || !worktreePath) continue;
    const path = await canonicalPath(worktreePath);
    if (excludedPaths.has(path)) continue;
    const status = await runGit(path, ["status", "--porcelain"]);
    if (status.ok && !status.stdout.trim()) clean.push(path);
  }
  return clean;
}

async function syncCleanTargetIntegrateWorktrees(paths: string[]): Promise<void> {
  for (const path of paths) {
    await runGit(path, ["reset", "--hard"]);
  }
}

async function integrateWorktreeCommits(body: GitRecord): Promise<GitRecord> {
  const plan = isRecord(body.plan) ? body.plan : body;
  const root = normalizeIntegratePath(plan.repoRoot, "repoRoot");
  const source = normalizeIntegrateBranch(plan.sourceBranch, "sourceBranch");
  const target = normalizeIntegrateBranch(plan.targetBranch, "targetBranch");
  const commits = Array.isArray(plan.commits) ? plan.commits.map(normalizeIntegrateSha) : [];
  if (commits.length === 0) return { kind: "noop", reason: "No commits to move" };
  const temp = await createIntegrationTempWorktree(root, target);
  let cleanTargetWorktrees: string[] = [];
  try {
    await maybeFastForwardIntegrateUpstream(temp);
    const targetStatus = await runGit(temp, ["status", "--porcelain"]);
    if (!targetStatus.ok) throw new GitCommandError("Read Git integration target status", targetStatus);
    if (targetStatus.stdout.trim()) throw new GitHttpError(409, "Target branch has local changes; abort integration and retry");
    cleanTargetWorktrees = await cleanTargetIntegrateWorktrees(root, target, [temp]).catch(() => []);

    for (let index = 0; index < commits.length; index += 1) {
      const commit = commits[index];
      const result = await runGit(temp, ["cherry-pick", commit]);
      if (result.ok) continue;
      const files = await conflictFiles(temp).catch(() => []);
      if (files.length > 0) {
        return {
          kind: "conflict",
          state: { repoRoot: root, tempWorktreePath: temp, sourceBranch: source, targetBranch: target, cleanTargetWorktrees, remainingCommits: commits.slice(index), currentCommit: commit },
          details: await integrateConflictDetails(temp),
        };
      }
      throw new GitCommandError("Integrate Git commits", result);
    }
    await removeIntegrationTempWorktree(root, temp);
    await syncCleanTargetIntegrateWorktrees(cleanTargetWorktrees);
    return { kind: "success", moved: commits.length };
  } catch (error) {
    await removeIntegrationTempWorktree(root, temp).catch(() => undefined);
    throw error;
  }
}

async function abortIntegrate(body: GitRecord): Promise<GitRecord> {
  const state = isRecord(body.state) ? body.state : body;
  const root = normalizeIntegratePath(state.repoRoot, "repoRoot");
  const temp = normalizeIntegratePath(state.tempWorktreePath, "tempWorktreePath");
  await runGit(temp, ["cherry-pick", "--abort"]);
  await removeIntegrationTempWorktree(root, temp);
  return { success: true };
}

async function continueIntegrate(body: GitRecord): Promise<GitRecord> {
  const state = isRecord(body.state) ? body.state : body;
  const root = normalizeIntegratePath(state.repoRoot, "repoRoot");
  const temp = normalizeIntegratePath(state.tempWorktreePath, "tempWorktreePath");
  const remaining = Array.isArray(state.remainingCommits) ? state.remainingCommits.map(normalizeIntegrateSha) : [];
  const current = state.currentCommit === undefined ? "" : normalizeIntegrateSha(state.currentCommit);
  const first = await runGit(temp, ["cherry-pick", "--continue"]);
  if (!first.ok) {
    const files = await conflictFiles(temp).catch(() => []);
    if (files.length > 0) return { kind: "conflict", state, details: await integrateConflictDetails(temp) };
    throw new GitCommandError("Continue Git integration", first);
  }
  const pending = remaining[0] === current ? remaining.slice(1) : remaining;
  for (let index = 0; index < pending.length; index += 1) {
    const commit = pending[index];
    const result = await runGit(temp, ["cherry-pick", commit]);
    if (result.ok) continue;
    const files = await conflictFiles(temp).catch(() => []);
    if (files.length > 0) {
      return {
        kind: "conflict",
        state: { ...state, remainingCommits: pending.slice(index), currentCommit: commit },
        details: await integrateConflictDetails(temp),
      };
    }
    throw new GitCommandError("Continue Git integration", result);
  }
  await removeIntegrationTempWorktree(root, temp);
  const cleanTargetWorktrees = Array.isArray(state.cleanTargetWorktrees)
    ? state.cleanTargetWorktrees.filter((entry): entry is string => isGitString(entry))
    : [];
  await syncCleanTargetIntegrateWorktrees(cleanTargetWorktrees);
  return { kind: "success", moved: remaining.length };
}

function route(data: GitJsonValue, status = 200): GitRouteResult {
  return { data, status };
}

function methodError(): GitRouteResult {
  return route({ error: "Method not allowed" }, 405);
}

function errorRoute(error: Error): GitRouteResult {
  if (error instanceof GitHttpError) return route({ error: error.message }, error.status);
  if (error instanceof GitCommandError) return route({ error: sanitizeGitText(error.message) }, 500);
  return route({ error: sanitizeGitText(error.message || "Git operation failed") }, 500);
}

async function generateCommitMessage(directory: string, body: GitRecord): Promise<GitRecord> {
  const files = Array.isArray(body.files) ? body.files.filter((value): value is string => isGitString(value) && value.trim().length > 0) : [];
  if (files.length === 0) throw new GitHttpError(400, "No files provided to generate commit message");
  const names = files.map((file) => basename(file)).slice(0, 5);
  const subject = names.length === 1 ? `Update ${names[0]}` : `Update ${files.length} files`;
  return { message: { subject, highlights: names.map((name) => `Changed ${name}`) } };
}

async function generatePullRequestDescription(directory: string, body: GitRecord): Promise<GitRecord> {
  const base = requiredString(body.base, "base");
  const head = requiredString(body.head, "head");
  const diff = await getRangeDiff(directory, base, head, "", 0);
  const files = diff.split("\n").filter((line) => line.startsWith("diff --git ")).length;
  return {
    title: `${head} changes`,
    body: `This change updates ${files || "the selected"} file${files === 1 ? "" : "s"}.\n\n${optionalString(body.context)}`.trim(),
  };
}

/**
 * Handle the OpenChamber Git HTTP contract without importing the web package.
 * The main sidecar keeps ownership of CORS and response logging; this module
 * only returns JSON data and an HTTP status.
 */
export async function handleGitRequest(req: Request, url: URL, effectiveDir: string): Promise<GitRouteResult | null> {
  const path = url.pathname;
  if (path !== "/api/git" && !path.startsWith("/api/git/")) return null;

  let cachedBody: Promise<GitRecord> | null = null;
  const body = (): Promise<GitRecord> => {
    cachedBody ||= readBody(req);
    return cachedBody;
  };
  const directory = resolveDirectory(url.searchParams.get("directory") || undefined, effectiveDir);
  const method = req.method;

  try {
    if (path === "/api/git/identities") {
      if (method === "GET") return route(await readProfiles());
      if (method === "POST") return route(await createProfile(await body()));
      if (method === "DELETE") return route(await deleteProfile(requiredString((await body()).id, "id")));
      return methodError();
    }

    const identityMatch = path.match(/^\/api\/git\/identities\/([^/]+)$/);
    if (identityMatch) {
      const id = decodeURIComponent(identityMatch[1]);
      if (method === "PUT") return route(await updateProfile(id, await body()));
      if (method === "DELETE") return route(await deleteProfile(id));
      return methodError();
    }

    if (path === "/api/git/global-identity") return method === "GET" ? route(await identitySummary(directory, "global")) : methodError();
    if (path === "/api/git/current-identity") return method === "GET" ? route(await identitySummary(directory, "local")) : methodError();
    if (path === "/api/git/has-local-identity") return method === "GET" ? route(await hasLocalIdentity(directory)) : methodError();
    if (path === "/api/git/discover-credentials") return method === "GET" ? route(await discoverCredentials()) : methodError();

    if (path === "/api/git/check") return method === "GET" ? route({ isGitRepository: await isGitRepository(directory) }) : methodError();
    if (path === "/api/git/status") return method === "GET" ? route(await getStatus(directory, url.searchParams.get("mode") === "light")) : methodError();
    if (path === "/api/git/primary-root") return method === "GET" ? route(await resolvePrimaryRoot(directory)) : methodError();
    if (path === "/api/git/toplevel") return method === "GET" ? route(await resolveTopLevel(directory)) : methodError();
    if (path === "/api/git/worktree-type") return method === "GET" ? route({ linked: await isLinkedWorktree(directory) }) : methodError();

    if (path === "/api/git/commit-summaries") {
      if (method !== "POST") return methodError();
      const values = (await body()).shas;
      if (!Array.isArray(values)) throw new GitHttpError(400, "shas must be an array");
      return route(await getCommitSummaries(directory, values.filter((value): value is string => isGitString(value))));
    }
    if (path === "/api/git/diff") {
      if (method !== "GET") return methodError();
      return route({ diff: await getDiff(directory, requiredString(url.searchParams.get("path"), "path"), url.searchParams.get("staged") === "true", contextLineCount(url.searchParams.get("context"))) });
    }
    if (path === "/api/git/file-diff") {
      if (method !== "GET") return methodError();
      return route(await getFileDiff(directory, requiredString(url.searchParams.get("path"), "path"), url.searchParams.get("staged") === "true"));
    }
    if (path === "/api/git/range-diff") {
      if (method !== "GET") return methodError();
      return route({ diff: await getRangeDiff(directory, requiredString(url.searchParams.get("base"), "base"), requiredString(url.searchParams.get("head"), "head"), optionalString(url.searchParams.get("path")), contextLineCount(url.searchParams.get("context"))) });
    }
    if (path === "/api/git/range-files") {
      if (method !== "GET") return methodError();
      return route(await getRangeFiles(directory, requiredString(url.searchParams.get("base"), "base"), requiredString(url.searchParams.get("head"), "head")));
    }
    if (path === "/api/git/branch-base") {
      if (method !== "GET") return methodError();
      return route(await getBranchBase(directory, requiredString(url.searchParams.get("branch"), "branch")));
    }

    if (path === "/api/git/stage" || path === "/api/git/unstage") {
      if (method !== "POST") return methodError();
      const data = await body();
      const values = Array.isArray(data.paths) ? data.paths : [data.path];
      const paths = values.filter((value): value is string => isGitString(value));
      if (path.endsWith("/stage")) await stageFiles(directory, paths);
      else await unstageFiles(directory, paths);
      return route({ success: true });
    }
    if (path === "/api/git/revert") {
      if (method !== "POST") return methodError();
      const data = await body();
      await revertFile(directory, requiredString(data.path, "path"), optionalString(data.scope));
      return route({ success: true });
    }
    if (path === "/api/git/apply-hunk") {
      if (method !== "POST") return methodError();
      const data = await body();
      await applyHunk(directory, requiredString(data.path, "path"), requiredString(data.patch, "patch"), requiredString(data.action, "action"));
      return route({ success: true });
    }

    if (path === "/api/git/branches") {
      if (method === "GET") return route(await getBranches(directory));
      if (method === "POST") {
        const data = await body();
        return route(await createBranch(directory, requiredString(data.name, "name"), optionalString(data.startPoint) || "HEAD"));
      }
      if (method === "DELETE") {
        const data = await body();
        return route(await deleteBranch(directory, requiredString(data.branch, "branch"), data.force === true));
      }
      return methodError();
    }
    if (path === "/api/git/branches/rename") {
      if (method !== "PUT" && method !== "POST") return methodError();
      const data = await body();
      return route(await renameBranch(directory, requiredString(data.oldName, "oldName"), requiredString(data.newName, "newName")));
    }
    if (path === "/api/git/branch-push-status") {
      if (method !== "POST") return methodError();
      const values = (await body()).branches;
      if (!Array.isArray(values)) throw new GitHttpError(400, "branches must be an array of branch names");
      return route(await getUnpushedBranchCounts(directory, values.filter((value): value is string => isGitString(value))));
    }
    if (path === "/api/git/remote-branches") {
      if (method !== "DELETE") return methodError();
      const data = await body();
      return route(await deleteRemoteBranch(directory, requiredString(data.branch, "branch"), optionalString(data.remote) || "origin"));
    }
    if (path === "/api/git/checkout") {
      if (method !== "POST") return methodError();
      return route(await checkoutBranch(directory, requiredString((await body()).branch, "branch")));
    }
    if (path === "/api/git/checkout-commit") {
      if (method !== "POST") return methodError();
      await checkoutCommit(directory, requiredString((await body()).hash, "hash"));
      return route({ success: true });
    }
    if (path === "/api/git/cherry-pick") {
      if (method !== "POST") return methodError();
      return route(await conflictAwareCommand(directory, ["cherry-pick", requiredString((await body()).hash, "hash")], "Cherry-pick Git commit"));
    }
    if (path === "/api/git/revert-commit") {
      if (method !== "POST") return methodError();
      return route(await conflictAwareCommand(directory, ["revert", "--no-commit", requiredString((await body()).hash, "hash")], "Revert Git commit"));
    }
    if (path === "/api/git/reset-to-commit") {
      if (method !== "POST") return methodError();
      const data = await body();
      return route(await resetToCommit(directory, requiredString(data.hash, "hash"), optionalString(data.mode) || "mixed", data.force === true));
    }

    if (path === "/api/git/remotes") {
      if (method === "GET") return route(await getRemotes(directory));
      if (method === "DELETE") return route(await removeRemote(directory, requiredString((await body()).remote, "remote")));
      return methodError();
    }
    if (path === "/api/git/remote-url") {
      if (method !== "GET") return methodError();
      return route(await getRemoteUrl(directory, optionalString(url.searchParams.get("remote")) || "origin"));
    }
    if (path === "/api/git/pull") {
      if (method !== "POST") return methodError();
      return route(await pull(directory, await body()));
    }
    if (path === "/api/git/push") {
      if (method !== "POST") return methodError();
      return route(await push(directory, await body()));
    }
    if (path === "/api/git/fetch") {
      if (method !== "POST") return methodError();
      return route(await fetchRemote(directory, await body()));
    }
    if (path === "/api/git/commit") {
      if (method !== "POST") return methodError();
      return route(await commitChanges(directory, await body()));
    }

    if (path === "/api/git/stashes") return method === "GET" ? route(await listStashes(directory)) : methodError();
    if (path === "/api/git/stashes/file-counts") {
      if (method !== "POST") return methodError();
      const values = (await body()).refs;
      if (!Array.isArray(values)) throw new GitHttpError(400, "refs must be an array");
      return route(await stashFileCounts(directory, values.filter((value): value is string => isGitString(value))));
    }
    if (path === "/api/git/stash") {
      if (method !== "POST") return methodError();
      return route(await stashPush(directory, await body()));
    }
    if (path === "/api/git/stash/apply" || path === "/api/git/stash/pop" || path === "/api/git/stash/drop") {
      if (method !== "POST") return methodError();
      const action = path.endsWith("/apply") ? "apply" : path.endsWith("/pop") ? "pop" : "drop";
      return route(await stashRefAction(directory, action, await body()));
    }

    if (path === "/api/git/rebase") {
      if (method !== "POST") return methodError();
      return route(await conflictAwareCommand(directory, ["rebase", requiredString((await body()).onto, "onto")], "Rebase Git branch"));
    }
    if (path === "/api/git/rebase/abort") {
      if (method !== "POST") return methodError();
      await runGitChecked(await repositoryRoot(directory), ["rebase", "--abort"], "Abort Git rebase");
      return route({ success: true });
    }
    if (path === "/api/git/rebase/continue") return method === "POST" ? route(await continueOperation(directory, "rebase")) : methodError();
    if (path === "/api/git/merge") {
      if (method !== "POST") return methodError();
      return route(await conflictAwareCommand(directory, ["merge", requiredString((await body()).branch, "branch")], "Merge Git branch"));
    }
    if (path === "/api/git/merge/abort") {
      if (method !== "POST") return methodError();
      await runGitChecked(await repositoryRoot(directory), ["merge", "--abort"], "Abort Git merge");
      return route({ success: true });
    }
    if (path === "/api/git/merge/continue") return method === "POST" ? route(await continueOperation(directory, "merge")) : methodError();
    if (path === "/api/git/conflict-details") return method === "GET" ? route(await getConflictDetails(directory)) : methodError();

    if (path === "/api/git/set-identity") {
      if (method !== "POST") return methodError();
      return route(await setIdentity(directory, requiredString((await body()).profileId, "profileId")));
    }
    if (path === "/api/git/identities") return method === "GET" ? route(await readProfiles()) : methodError();

    if (path === "/api/git/worktrees") {
      if (method === "GET") return route(await getWorktrees(directory));
      if (method === "POST") return route(await createWorktree(directory, await body()));
      if (method === "DELETE") return route(await removeWorktree(directory, await body()));
      return methodError();
    }
    if (path === "/api/git/worktrees/validate") {
      if (method !== "POST") return methodError();
      return route(await validateWorktreeCreate(directory, await body()));
    }
    if (path === "/api/git/worktrees/preview") {
      if (method !== "POST") return methodError();
      return route(await previewWorktree(directory, await body()));
    }
    if (path === "/api/git/worktrees/bootstrap-status") {
      if (method !== "GET") return methodError();
      return route(await worktreeBootstrapStatus(directory));
    }
    if (path === "/api/git/validate-directory") {
      if (method !== "POST") return methodError();
      const data = await body();
      return route(await validateWorktreeDirectory(requiredString(data.directory, "directory"), requiredString(data.worktreeRoot, "worktreeRoot")));
    }
    if (path === "/api/git/canonicalize-worktree-state") {
      if (method !== "POST") return methodError();
      return route(await canonicalizeWorktreeState(requiredString((await body()).directory, "directory")));
    }

    if (path === "/api/git/log") return method === "GET" ? route(await getLog(directory, url.searchParams)) : methodError();
    if (path === "/api/git/commit-files") {
      if (method !== "GET") return methodError();
      return route(await getCommitFiles(directory, requiredString(url.searchParams.get("hash"), "hash")));
    }
    if (path === "/api/git/commit-file-diff") {
      if (method !== "GET") return methodError();
      return route(await getCommitFileDiff(directory, requiredString(url.searchParams.get("hash"), "hash"), requiredString(url.searchParams.get("path"), "path"), url.searchParams.get("binary") === "true"));
    }
    if (path === "/api/git/commit-message") {
      if (method !== "POST") return methodError();
      return route(await generateCommitMessage(directory, await body()));
    }
    if (path === "/api/git/pr-description") {
      if (method !== "POST") return methodError();
      return route(await generatePullRequestDescription(directory, await body()));
    }

    if (path === "/api/git/integrate/plan" || path === "/api/git/integrate/conflict-details" || path === "/api/git/integrate/cherry-pick-status" || path === "/api/git/integrate/run" || path === "/api/git/integrate/abort" || path === "/api/git/integrate/continue") {
      if (method !== "POST") return methodError();
      const data = await body();
      if (path.endsWith("/plan")) return route(await computeIntegratePlan(data));
      if (path.endsWith("/conflict-details")) return route(await integrateConflictDetails(requiredString(data.tempWorktreePath, "tempWorktreePath")));
      if (path.endsWith("/cherry-pick-status")) return route(await cherryPickStatus(requiredString(data.tempWorktreePath, "tempWorktreePath")));
      if (path.endsWith("/run")) return route(await integrateWorktreeCommits(data));
      if (path.endsWith("/abort")) return route(await abortIntegrate(data));
      return route(await continueIntegrate(data));
    }

    return route({ error: "Git route not found" }, 404);
  } catch (error) {
    return errorRoute(error instanceof Error ? error : new Error("Git operation failed"));
  }
}
