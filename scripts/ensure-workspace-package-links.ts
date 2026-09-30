#!/usr/bin/env -S node --import tsx
import fs from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./dev-service-profile.ts";

type WorkspaceLinkMismatch = {
  workspaceDir: string;
  packageName: string;
  expectedPath: string;
  actualPath: string | null;
};

type WorkspaceExclusion = { base: string; recursive: boolean };

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

/**
 * Reads the `!`-prefixed entries from the `packages:` block of
 * pnpm-workspace.yaml. Those directories are deliberately outside the
 * workspace, so pnpm never links their `workspace:` dependencies and this script
 * must not try to repair them. Without this, a host that cannot create
 * symlinks fails the whole preflight on a package pnpm was never going to link.
 *
 * The file is machine-shaped (a flat list of plain globs under one key), so a
 * line matcher is sufficient and avoids a YAML dependency at the repo root.
 */
function readWorkspaceExclusions(rootDir: string): WorkspaceExclusion[] {
  const yamlPath = path.join(rootDir, "pnpm-workspace.yaml");
  if (!existsSync(yamlPath)) return [];

  const exclusions: WorkspaceExclusion[] = [];
  let inPackagesBlock = false;
  for (const rawLine of readFileSync(yamlPath, "utf8").split(/\r?\n/)) {
    if (/^packages:\s*$/.test(rawLine)) {
      inPackagesBlock = true;
      continue;
    }
    // Any unindented, non-empty line starts the next top-level key.
    if (inPackagesBlock && /^\S/.test(rawLine) && rawLine.trim().length > 0) break;
    if (!inPackagesBlock) continue;

    const entry = rawLine.match(/^\s*-\s*["']?(!?)([^"']+)["']?\s*$/);
    if (!entry || entry[1] !== "!") continue;
    const pattern = entry[2]!.trim();
    if (pattern.endsWith("/**")) {
      exclusions.push({ base: pattern.slice(0, -"/**".length), recursive: true });
    } else {
      exclusions.push({ base: pattern, recursive: false });
    }
  }
  return exclusions;
}

function isWorkspaceExcluded(workspaceDir: string, exclusions: WorkspaceExclusion[]): boolean {
  const normalized = workspaceDir.split(path.sep).join("/");
  return exclusions.some(({ base, recursive }) =>
    recursive ? normalized === base || normalized.startsWith(`${base}/`) : normalized === base,
  );
}

function discoverWorkspacePackagePaths(rootDir: string): Map<string, string> {
  const packagePaths = new Map<string, string>();
  const ignoredDirNames = new Set([".git", ".paperclip", "dist", "node_modules"]);

  function visit(dirPath: string) {
    const packageJsonPath = path.join(dirPath, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = readJsonFile(packageJsonPath);
      if (typeof packageJson.name === "string" && packageJson.name.length > 0) {
        packagePaths.set(packageJson.name, dirPath);
      }
    }

    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (ignoredDirNames.has(entry.name)) continue;
      visit(path.join(dirPath, entry.name));
    }
  }

  visit(path.join(rootDir, "packages"));
  visit(path.join(rootDir, "server"));
  visit(path.join(rootDir, "ui"));
  visit(path.join(rootDir, "cli"));

  return packagePaths;
}

const workspacePackagePaths = discoverWorkspacePackagePaths(repoRoot);
const workspaceExclusions = readWorkspaceExclusions(repoRoot);
const excludedWorkspaceDirs = Array.from(
  new Set(
    Array.from(workspacePackagePaths.values()).map((packagePath) =>
      path.relative(repoRoot, packagePath).split(path.sep).join("/"),
    ),
  ),
)
  .filter((workspaceDir) => workspaceDir.length > 0 && isWorkspaceExcluded(workspaceDir, workspaceExclusions))
  .sort();
const workspaceDirs = Array.from(
  new Set(
    Array.from(workspacePackagePaths.values())
      .map((packagePath) => path.relative(repoRoot, packagePath))
      .filter((workspaceDir) => workspaceDir.length > 0),
  ),
)
  .filter((workspaceDir) => !isWorkspaceExcluded(workspaceDir.split(path.sep).join("/"), workspaceExclusions))
  .sort();

function findWorkspaceLinkMismatches(workspaceDir: string): WorkspaceLinkMismatch[] {
  const nodeModulesDir = path.join(repoRoot, workspaceDir, "node_modules");
  if (!existsSync(nodeModulesDir)) {
    return [];
  }

  const packageJson = readJsonFile(path.join(repoRoot, workspaceDir, "package.json"));
  const dependencies = {
    ...(packageJson.dependencies as Record<string, unknown> | undefined),
    ...(packageJson.devDependencies as Record<string, unknown> | undefined),
  };
  const mismatches: WorkspaceLinkMismatch[] = [];

  for (const [packageName, version] of Object.entries(dependencies)) {
    if (typeof version !== "string" || !version.startsWith("workspace:")) continue;

    const expectedPath = workspacePackagePaths.get(packageName);
    if (!expectedPath) continue;

    const linkPath = path.join(repoRoot, workspaceDir, "node_modules", ...packageName.split("/"));
    const actualPath = existsSync(linkPath) ? path.resolve(realpathSync(linkPath)) : null;
    if (actualPath === path.resolve(expectedPath)) continue;

    mismatches.push({
      workspaceDir,
      packageName,
      expectedPath: path.resolve(expectedPath),
      actualPath,
    });
  }

  return mismatches;
}

async function ensureWorkspaceLinksCurrent(workspaceDir: string) {
  const mismatches = findWorkspaceLinkMismatches(workspaceDir);
  if (mismatches.length === 0) return;

  console.log(`[paperclip] detected stale workspace package links for ${workspaceDir}; relinking dependencies...`);
  for (const mismatch of mismatches) {
    console.log(
      `[paperclip]   ${mismatch.packageName}: ${mismatch.actualPath ?? "missing"} -> ${mismatch.expectedPath}`,
    );
  }

  for (const mismatch of mismatches) {
    const linkPath = path.join(repoRoot, mismatch.workspaceDir, "node_modules", ...mismatch.packageName.split("/"));
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.rm(linkPath, { recursive: true, force: true });
    await fs.symlink(mismatch.expectedPath, linkPath);
  }

  const remainingMismatches = findWorkspaceLinkMismatches(workspaceDir);
  if (remainingMismatches.length === 0) return;

  throw new Error(
    `Workspace relink did not repair all ${workspaceDir} package links: ${remainingMismatches.map((item) => item.packageName).join(", ")}`,
  );
}

for (const workspaceDir of workspaceDirs) {
  await ensureWorkspaceLinksCurrent(workspaceDir);
}

if (excludedWorkspaceDirs.length > 0) {
  // Not an error. These packages sit outside the pnpm workspace by design, so
  // pnpm does not manage their `workspace:` links. `link-plugin-dev-sdk.mjs`
  // handles the ones that need the in-repo SDK, and tolerates hosts without
  // symlink support.
  console.log(
    `[paperclip] skipped ${excludedWorkspaceDirs.length} workspace-excluded package(s): ${excludedWorkspaceDirs.join(", ")}`,
  );
}
