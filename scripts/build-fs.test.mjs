import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(repoRoot, "scripts", "build-fs.mjs");

function run(...args) {
  return execFileSync(process.execPath, [helper, ...args], { encoding: "utf8" });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "build-fs-"));
  const write = (rel, body = rel) => {
    const full = join(root, rel);
    execFileSync(process.execPath, [helper, "mkdir", join(full, "..").replace(/\\$/, "")], { stdio: "ignore" });
    writeFileSync(full, body);
  };
  write("src/a/one.sql", "1");
  write("src/a/two.sql", "2");
  write("src/a/note.txt", "n");
  write("src/a/b/deep.txt", "d");
  write("src/keep.json", "k");
  write("src/other.txt", "o");
  write("src/meta/_journal.json", "j");
  return root;
}

function tree(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(root, "");
  return out;
}

test("mkdir creates nested directories", () => {
  const root = fixture();
  try {
    run("mkdir", join(root, "out", "a", "b"));
    assert.ok(existsSync(join(root, "out", "a", "b")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copy expands a trailing glob into a destination directory", () => {
  const root = fixture();
  try {
    run("mkdir", join(root, "out"));
    run("copy", join(root, "src", "a", "*.sql"), join(root, "out"));
    assert.deepEqual(tree(join(root, "out")), ["one.sql", "two.sql"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copy with several sources targets the final argument as a directory", () => {
  const root = fixture();
  try {
    run("mkdir", join(root, "out"));
    run("copy", join(root, "src", "keep.json"), join(root, "src", "other.txt"), join(root, "out"));
    assert.deepEqual(tree(join(root, "out")), ["keep.json", "other.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copy renames a single file source onto an explicit destination", () => {
  const root = fixture();
  try {
    run("mkdir", join(root, "out"));
    run("copy", join(root, "src", "keep.json"), join(root, "out", "renamed.json"));
    assert.equal(readFileSync(join(root, "out", "renamed.json"), "utf8"), "k");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copy of a directory merges its contents rather than nesting it", () => {
  const root = fixture();
  try {
    run("copy", join(root, "src"), join(root, "out", "tree"));
    assert.deepEqual(tree(join(root, "out", "tree")), [
      "a/b/deep.txt",
      "a/note.txt",
      "a/one.sql",
      "a/two.sql",
      "keep.json",
      "meta/_journal.json",
      "other.txt",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean removes several paths and tolerates missing ones", () => {
  const root = fixture();
  try {
    run("clean", join(root, "src", "a"), join(root, "does", "not", "exist"));
    assert.equal(existsSync(join(root, "src", "a")), false);
    assert.ok(existsSync(join(root, "src", "keep.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune keeps the lexicographically newest N and deletes the rest", () => {
  const root = fixture();
  try {
    for (const n of ["0001", "0002", "0003", "0004", "0005", "0006"]) {
      writeFileSync(join(root, `${n}_snapshot.json`), n);
    }
    run("prune", root, "*_snapshot.json", "3");
    assert.deepEqual(readdirSync(root).filter((f) => f.endsWith("_snapshot.json")).sort(), [
      "0004_snapshot.json",
      "0005_snapshot.json",
      "0006_snapshot.json",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown verb fails loudly", () => {
  const root = fixture();
  try {
    assert.throws(() => run("frobnicate"), /unknown verb/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing source fails loudly", () => {
  const root = fixture();
  try {
    assert.throws(() => run("copy", join(root, "nope.txt"), join(root, "out.txt")), /missing source/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
