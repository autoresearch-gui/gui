#!/usr/bin/env node
// Rewrites POSIX-only filesystem commands in workspace package.json scripts to
// call scripts/build-fs.mjs. One-shot migration helper; kept so the rewrite is
// reviewable and repeatable rather than a hand-edited diff.
//
//   node scripts/migrate-build-scripts-to-build-fs.mjs [--check] [--write]

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const write = process.argv.includes("--write");

// POSIX command -> build-fs verb. `rm -rf X Y` maps to `clean X Y`.
const CLEAN = /^rm\s+(?:-[a-zA-Z]+\s+)*(.+)$/;
const CHMOD = /^chmod\s+(?:\+x\s+)?([^\s;&|]+)/;

function findPackages(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "scripts" ||
      entry.name === "tests" ||
      entry.name === "doc" ||
      entry.name === "docs" ||
      entry.name === "evals" ||
      entry.name === "design" ||
      entry.name.startsWith(".")
    ) {
      continue;
    }
    const full = join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    const manifest = join(full, "package.json");
    if (existsSync(manifest)) found.push(manifest);
    // Recurse regardless of whether this directory is itself a package.
    findPackages(full, found);
  }
  return found;
}

const manifests = [join(repoRoot, "package.json")];
for (const pkgDir of ["packages", "server", "ui", "cli", "tools"]) {
  const full = join(repoRoot, pkgDir);
  if (!existsSync(full)) continue;
  // The root of the scan may itself be a package (server, ui, cli).
  const own = join(full, "package.json");
  if (existsSync(own)) manifests.push(own);
  findPackages(full, manifests);
}

let changed = 0;
for (const manifest of new Set(manifests)) {
  const raw = readFileSync(manifest, "utf8");
  const json = JSON.parse(raw);
  if (!json.scripts) continue;

  let touched = false;
  for (const [name, cmd] of Object.entries(json.scripts)) {
    if (typeof cmd !== "string") continue;
    if (!/(^|[;&|]\s*|\s)(cp|mv|rm|mkdir|chmod)\s/.test(cmd)) continue;

    // Depth of the manifest relative to the repo root decides the helper path.
    const depth = relative(repoRoot, dirname(manifest)).split(/[\\/]/).length;
    const prefix = depth === 0 ? "node scripts/build-fs.mjs" : `node ${"../".repeat(depth)}scripts/build-fs.mjs`;

    const parts = cmd.split("&&").map((part) => part.trim()).filter(Boolean);
    const rebuilt = [];
    for (const part of parts) {
      const clean = part.match(CLEAN);
      const chmod = part.match(CHMOD);
      if (clean) {
        rebuilt.push(`${prefix} clean ${clean[1]}`);
        continue;
      }
      if (chmod) {
        rebuilt.push(`${prefix} chmod ${chmod[1]}`);
        continue;
      }
      if (/^mkdir\s+/.test(part)) {
        const dirs = part.replace(/^mkdir\s+-p\s+/, "").split(/\s+/).filter(Boolean);
        rebuilt.push(`${prefix} mkdir ${dirs.join(" ")}`);
        continue;
      }
      if (/^cp\s/.test(part)) {
        const args = part
          .replace(/^cp\s+/, "")
          .replace(/-[a-zA-Z]+\s+/g, "")
          .replace(/\/\.(?=\s|$)/g, "")
          .trim();
        rebuilt.push(`${prefix} copy ${args}`);
        continue;
      }
      rebuilt.push(part);
    }

    const next = rebuilt.join(" && ");
    if (next !== cmd) {
      touched = true;
      json.scripts[name] = next;
      console.log(`${relative(repoRoot, manifest)} :: ${name}`);
      console.log(`  - ${cmd}`);
      console.log(`  + ${next}`);
    }
  }

  if (touched) {
    changed += 1;
    if (write) writeFileSync(manifest, `${JSON.stringify(json, null, 2)}\n`);
  }
}

if (changed === 0) {
  console.log("No POSIX-only build scripts remain.");
} else if (check) {
  console.error(`\n${changed} manifest(s) still need migrating. Re-run with --write.`);
  process.exit(1);
} else {
  console.log(`\nMigrated ${changed} manifest(s).`);
}
