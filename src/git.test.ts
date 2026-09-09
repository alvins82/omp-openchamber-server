import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleGitRequest } from "./git";
import type { GitJsonObject, GitJsonValue, GitRequestBody } from "./git";

interface StatusFile extends GitJsonObject {
  path: string;
}

interface StatusResponse extends GitJsonObject {
  files: StatusFile[];
}

interface WorktreeResponseEntry extends GitJsonObject {
  path: string;
  branch: string;
}

interface BranchesResponse extends GitJsonObject {
  all: string[];
  current: string;
}

interface BootstrapResponse extends GitJsonObject {
  status: string;
}

interface WorktreeResponse extends GitJsonObject {
  path: string;
  branch: string;
  bootstrapStatus: BootstrapResponse;
}

interface IntegrationState extends GitJsonObject {
  repoRoot: string;
  tempWorktreePath: string;
  sourceBranch: string;
  targetBranch: string;
  cleanTargetWorktrees: string[];
  remainingCommits: string[];
  currentCommit: string;
}

interface IntegrationDetails extends GitJsonObject {
  currentPatchMeta: string;
  currentPatch: string;
  unmergedFiles: string[];
}

interface IntegrationConflict extends GitJsonObject {
  kind: string;
  state: IntegrationState;
  details: IntegrationDetails;
}

function isGitObject(value: GitJsonValue): value is GitJsonObject {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isGitStringValue(value: GitJsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isStatusResponse(value: GitJsonValue): value is StatusResponse {
  return isGitObject(value) && Array.isArray(value.files) && value.files.every((entry) => isGitObject(entry) && isGitStringValue(entry.path));
}

function isWorktreeResponseEntry(value: GitJsonValue): value is WorktreeResponseEntry {
  return isGitObject(value) && isGitStringValue(value.path) && isGitStringValue(value.branch);
}

function isBranchesResponse(value: GitJsonValue): value is BranchesResponse {
  return isGitObject(value) && Array.isArray(value.all) && value.all.every((entry) => isGitStringValue(entry)) && isGitStringValue(value.current);
}

function isWorktreeResponse(value: GitJsonValue): value is WorktreeResponse {
  return isGitObject(value)
    && isGitStringValue(value.path)
    && isGitStringValue(value.branch)
    && isGitObject(value.bootstrapStatus)
    && isGitStringValue(value.bootstrapStatus.status);
}

function isIntegrationState(value: GitJsonValue): value is IntegrationState {
  return isGitObject(value)
    && isGitStringValue(value.repoRoot)
    && isGitStringValue(value.tempWorktreePath)
    && isGitStringValue(value.sourceBranch)
    && isGitStringValue(value.targetBranch)
    && Array.isArray(value.cleanTargetWorktrees)
    && value.cleanTargetWorktrees.every((entry) => isGitStringValue(entry))
    && Array.isArray(value.remainingCommits)
    && value.remainingCommits.every((entry) => isGitStringValue(entry))
    && isGitStringValue(value.currentCommit);
}

function isIntegrationDetails(value: GitJsonValue): value is IntegrationDetails {
  return isGitObject(value)
    && isGitStringValue(value.currentPatchMeta)
    && isGitStringValue(value.currentPatch)
    && Array.isArray(value.unmergedFiles)
    && value.unmergedFiles.every((entry) => isGitStringValue(entry));
}

function isIntegrationConflict(value: GitJsonValue): value is IntegrationConflict {
  return isGitObject(value)
    && isGitStringValue(value.kind)
    && isIntegrationState(value.state)
    && isIntegrationDetails(value.details);
}

async function runGit(directory: string, args: string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...globalThis.process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${args.join(" ")}: ${stderr}`);
  return stdout;
}

async function request(directory: string, route: string, method = "GET", payload?: GitRequestBody): Promise<{ status: number; data: GitJsonValue }> {
  const url = new URL(`http://sidecar.test${route}`);
  const response = await handleGitRequest(new Request(url, {
    method,
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }), url, directory);
  if (!response) throw new Error(`No route for ${route}`);
  return { status: response.status || 200, data: response.data };
}

describe("sidecar Git HTTP contract", () => {
  test("reports real status, primary roots, branches, and linked worktrees", async () => {
    const root = await mkdtemp(join(tmpdir(), "openchamber-git-test-"));
    const linked = join(root, "linked");
    try {
      await runGit(root, ["init", "-b", "main"]);
      await runGit(root, ["config", "user.name", "OpenChamber Test"]);
      await runGit(root, ["config", "user.email", "test@example.invalid"]);
      await writeFile(join(root, "README.md"), "initial\n", "utf8");
      await runGit(root, ["add", "README.md"]);
      await runGit(root, ["commit", "-m", "initial"]);
      await runGit(root, ["branch", "feature"]);
      await runGit(root, ["worktree", "add", "-b", "linked", linked, "main"]);

      await writeFile(join(root, "README.md"), "changed\n", "utf8");
      await writeFile(join(root, "new.txt"), "new file\n", "utf8");

      const status = await request(root, `/api/git/status?directory=${encodeURIComponent(root)}`);
      expect(status.status).toBe(200);
      expect(status.data).toMatchObject({ isGitRepository: true, current: "main", isClean: false });
      if (!isStatusResponse(status.data)) throw new Error("Unexpected status response");
      const statusData = status.data;
      expect(statusData.files.map((file) => file.path)).toEqual(expect.arrayContaining(["README.md", "new.txt"]));

      const primary = await request(linked, `/api/git/primary-root?directory=${encodeURIComponent(linked)}`);
      expect(primary.data).toEqual({ root: await realpath(root) });

      const worktrees = await request(linked, `/api/git/worktrees?directory=${encodeURIComponent(linked)}`);
      if (!Array.isArray(worktrees.data) || !worktrees.data.every((entry) => isWorktreeResponseEntry(entry))) throw new Error("Unexpected worktrees response");
      const worktreeData = worktrees.data;
      expect(worktreeData.map((entry) => entry.branch)).toEqual(expect.arrayContaining(["main", "linked"]));

      const branches = await request(root, `/api/git/branches?directory=${encodeURIComponent(root)}`);
      if (!isBranchesResponse(branches.data)) throw new Error("Unexpected branches response");
      const branchesData = branches.data;
      expect(branchesData.all).toEqual(expect.arrayContaining(["main", "feature", "linked"]));
      expect(branchesData.current).toBe("main");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stages, diffs, commits, and creates/removes a managed worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "openchamber-git-mutate-"));
    try {
      await runGit(root, ["init", "-b", "main"]);
      await runGit(root, ["config", "user.name", "OpenChamber Test"]);
      await runGit(root, ["config", "user.email", "test@example.invalid"]);
      await writeFile(join(root, "file.txt"), "one\n", "utf8");
      await runGit(root, ["add", "file.txt"]);
      await runGit(root, ["commit", "-m", "initial"]);
      await writeFile(join(root, "file.txt"), "one\ntwo\n", "utf8");

      const stage = await request(root, `/api/git/stage?directory=${encodeURIComponent(root)}`, "POST", { paths: ["file.txt"] });
      expect(stage.data).toEqual({ success: true });
      const diff = await request(root, `/api/git/diff?directory=${encodeURIComponent(root)}&path=file.txt&staged=true`, "GET");
      if (!isGitObject(diff.data) || !isGitStringValue(diff.data.diff)) throw new Error("Unexpected diff response");
      const diffData = diff.data;
      expect(diffData.diff).toContain("+two");
      const commit = await request(root, `/api/git/commit?directory=${encodeURIComponent(root)}`, "POST", { message: "add second line" });
      expect(commit.data).toMatchObject({ success: true, branch: "main" });

      const created = await request(root, `/api/git/worktrees?directory=${encodeURIComponent(root)}`, "POST", {
        mode: "new",
        worktreeName: "api-test",
        branchName: "api-test",
        startRef: "main",
      });
      if (!isWorktreeResponse(created.data)) throw new Error("Unexpected worktree response");
      const worktree = created.data;
      expect(created.data).toMatchObject({ branch: "api-test" });
      expect(worktree.bootstrapStatus.status).toBe("ready");
      expect(await readFile(join(worktree.path, "file.txt"), "utf8")).toContain("two");

      const removed = await request(root, `/api/git/worktrees?directory=${encodeURIComponent(root)}`, "DELETE", { directory: worktree.path });
      expect(removed.data).toEqual({ success: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns directory-first worktree creation with a live bootstrap state", async () => {
    const root = await mkdtemp(join(tmpdir(), "openchamber-git-bootstrap-"));
    try {
      await runGit(root, ["init", "-b", "main"]);
      await runGit(root, ["config", "user.name", "OpenChamber Test"]);
      await runGit(root, ["config", "user.email", "test@example.invalid"]);
      await writeFile(join(root, "README.md"), "initial\n", "utf8");
      await runGit(root, ["add", "README.md"]);
      await runGit(root, ["commit", "-m", "initial"]);

      const created = await request(root, `/api/git/worktrees?directory=${encodeURIComponent(root)}`, "POST", {
        mode: "new",
        worktreeName: "bootstrap-test",
        branchName: "bootstrap-test",
        startRef: "main",
        returnAfterDirectoryCreated: true,
      });
      if (!isWorktreeResponse(created.data)) throw new Error("Unexpected worktree response");
      const worktree = created.data;
      expect(worktree.bootstrapStatus.status).toBe("pending");
      expect(worktree.branch).toBe("bootstrap-test");

      await new Promise((resolve) => setTimeout(resolve, 150));
      const bootstrap = await request(root, `/api/git/worktrees/bootstrap-status?directory=${encodeURIComponent(worktree.path)}`);
      expect(bootstrap.data).toMatchObject({ status: "ready", phase: "setup-ready" });
      expect(await readFile(join(worktree.path, "README.md"), "utf8")).toBe("initial\n");

      const removed = await request(root, `/api/git/worktrees?directory=${encodeURIComponent(root)}`, "DELETE", { directory: worktree.path, deleteLocalBranch: true });
      expect(removed.data).toEqual({ success: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("plans equivalent commits and reports integration conflicts with the UI payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "openchamber-git-integrate-"));
    try {
      await runGit(root, ["init", "-b", "main"]);
      await runGit(root, ["config", "user.name", "OpenChamber Test"]);
      await runGit(root, ["config", "user.email", "test@example.invalid"]);
      await writeFile(join(root, "shared.txt"), "base\n", "utf8");
      await runGit(root, ["add", "shared.txt"]);
      await runGit(root, ["commit", "-m", "initial"]);

      await runGit(root, ["checkout", "-b", "feature"]);
      await writeFile(join(root, "shared.txt"), "feature\n", "utf8");
      await runGit(root, ["commit", "-am", "feature change"]);
      const featureSha = (await runGit(root, ["rev-parse", "HEAD"])).trim();

      await runGit(root, ["checkout", "main"]);
      await runGit(root, ["checkout", "-b", "equivalent"]);
      await runGit(root, ["cherry-pick", featureSha]);
      const equivalentPlan = await request(root, "/api/git/integrate/plan", "POST", {
        repoRoot: root,
        sourceBranch: "feature",
        targetBranch: "equivalent",
      });
      expect(equivalentPlan.data).toMatchObject({ commits: [] });

      await runGit(root, ["checkout", "-b", "target", "main"]);
      await writeFile(join(root, "shared.txt"), "target\n", "utf8");
      await runGit(root, ["commit", "-am", "target change"]);

      const integrated = await request(root, "/api/git/integrate/run", "POST", {
        plan: {
          repoRoot: root,
          sourceBranch: "feature",
          targetBranch: "target",
          commits: [featureSha],
        },
      });
      if (!isIntegrationConflict(integrated.data)) throw new Error("Unexpected integration conflict response");
      const conflict = integrated.data;
      expect(conflict.kind).toBe("conflict");
      expect(conflict.details).toHaveProperty("currentPatchMeta");
      expect(conflict.details).toHaveProperty("currentPatch");
      expect(conflict.details).toHaveProperty("unmergedFiles");

      const aborted = await request(root, "/api/git/integrate/abort", "POST", { state: conflict.state });
      expect(aborted.data).toEqual({ success: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
