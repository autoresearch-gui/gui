#!/usr/bin/env node

// Cross-platform replacements for the POSIX `mkdir`/`cp`/`rm`/`chmod` invocations
// that package build scripts used to shell out to.
//
// Package scripts run under `cmd.exe` on Windows, where `mkdir -p`, `cp`, `rm`,
// and `chmod` do not exist. Rather than duplicating each build script per
// platform, every script routes its filesystem work through this helper, which
// uses only Node built-ins and behaves identically on every OS.
//
//   node scripts/build-fs.mjs mkdir <dir> [...]
//   node scripts/build-fs.mjs copy  <src> [...] <dest>
//   node scripts/build-fs.mjs clean <path> [...]
//   node scripts/build-fs.mjs prune <dir> <glob> <keepNewest>
//   node scripts/build-fs.mjs chmod <file> [...]
//
// `copy` uses classic `cp` semantics: the last argument is the destination and
// everything before it is a source. A single directory source copies its
// *contents* into the destination directory (the `cp -R src/. dest/` idiom). A
// source whose basename contains `*` is treated as a suffix glob and expands
// within its own directory, which is how `cp src/migrations/*.sql dest/` is
// expressed without shell globbing.

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const [verb, ...args] = process.argv.slice(2);

function fail(message) {
  console.error(`build-fs: ${message}`);
  process.exit(1);
}

/** Expands a single `*` in a basename into matching entries in that directory. */
function expandGlob(pattern) {
  const dir = dirname(pattern);
  const name = basename(pattern);
  const star = name.indexOf("*");
  if (star === -1) return [pattern];

  const prefix = name.slice(0, star);
  const suffix = name.slice(star + 1);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(suffix))
    .sort()
    .map((entry) => join(dir, entry));
}

function copyOne(src, dest) {
  const matches = expandGlob(src);
  if (matches.length === 0) fail(`no matches for ${src}`);

  for (const match of matches) {
    if (!existsSync(match)) fail(`missing source ${match}`);
    if (lstatSync(match).isDirectory()) {
      // Directory source: merge its contents into dest, like `cp -R src/. dest/`.
      mkdirSync(dest, { recursive: true });
      cpSync(match, dest, { recursive: true, force: true });
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(match, dest);
    }
  }
}
function chmodOne(target) {
  // Windows has no executable bit. npm sets it from the package `bin` field at
  // install time, so this is a no-op there rather than an error.
  if (process.platform === "win32") return;
  chmodSync(target, 0o755);
}

switch (verb) {
  case "mkdir":
    for (const dir of args) mkdirSync(dir, { recursive: true });
    break;

  case "copy":
    if (args.length < 2) {
      fail("copy expects at least one source and a destination");
    }
    {
      const dest = args[args.length - 1];
      const sources = args.slice(0, -1);
      // With several sources the destination is a directory, matching `cp a b c/`.
      const destIsDir = sources.length > 1 || (existsSync(dest) && lstatSync(dest).isDirectory());
      for (const src of sources) {
        for (const match of expandGlob(src)) {
          if (!existsSync(match)) fail(`missing source ${match}`);
          if (lstatSync(match).isDirectory()) {
            // `cp -R src/. dest/` - merge the directory's contents into dest
            // rather than nesting it under dest/<srcName>.
            mkdirSync(dest, { recursive: true });
            cpSync(match, dest, { recursive: true, force: true });
          } else if (destIsDir) {
            copyOne(match, join(dest, basename(match)));
          } else {
            copyOne(match, dest);
          }
        }
      }
    }
    break;

  case "clean":
    for (const target of args) {
      // `rm -rf` is intentionally forgiving: a missing path is not an error.
      rmSync(resolve(target), { recursive: true, force: true });
    }
    break;

  case "prune":
    // Replaces `ls <dir>/<glob> | sort -r | tail -n +<keep+1> | xargs rm -f`:
    // keep the N lexicographically-last matches and delete the rest.
    if (args.length !== 3) fail("prune expects <dir> <glob> <keepNewest>");
    {
      const [dir, pattern, keepRaw] = args;
      const keep = Number.parseInt(keepRaw, 10);
      if (!Number.isInteger(keep) || keep < 0) fail(`invalid keepNewest ${keepRaw}`);
      if (!existsSync(dir)) break;
      const matched = expandGlob(join(dir, pattern))
        .map((match) => basename(match))
        .sort()
        .reverse();
      for (const entry of matched.slice(keep)) {
        rmSync(join(dir, entry), { recursive: true, force: true });
      }
    }
    break;

  case "chmod":
    for (const target of args) {
      if (!existsSync(target)) fail(`missing file ${target}`);
      chmodOne(target);
    }
    break;

  default:
    fail(`unknown verb ${verb ? `"${verb}"` : "(none)"}; expected mkdir|copy|clean|prune|chmod`);
}
