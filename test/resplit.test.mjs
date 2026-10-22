import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";

const script = fileURLToPath(new URL("../src/resplit.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "bun-demincer-resplit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function cli(...args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 5000,
  });
}

function manifest(dir, sourceOrder) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ sourceOrder }));
}

test("a bundle without module wrappers executes exactly once after a round trip", (t) => {
  const root = fixture(t);
  const input = join(root, "input.js");
  const dir = join(root, "split files");
  const output = join(root, "output.js");
  writeFileSync(input, "globalThis.runs = (globalThis.runs || 0) + 1;\n");

  const split = cli(input, dir);
  assert.equal(split.status, 0, split.stderr);
  const assembled = cli("--reassemble", dir, output);
  assert.equal(assembled.status, 0, assembled.stderr);
  const context = {};
  runInNewContext(`${readFileSync(output, "utf8")}(exports, null, null, null, null)`, {
    exports: {},
    globalThis: context,
  });
  assert.equal(context.runs, 1);
});

test("reassembly preserves module order, nested paths, headers, and runtime behavior", (t) => {
  const root = fixture(t);
  const dir = join(root, "split");
  const output = join(root, "output.js");
  manifest(dir, [
    { type: "runtime", file: "00-runtime.js" },
    { type: "module", file: "vendor/pkg/0001.js" },
    { type: "main", file: "99-main.js" },
  ]);
  mkdirSync(join(dir, "vendor/pkg"), { recursive: true });
  writeFileSync(join(dir, "00-runtime.js"), "var values = [];\n");
  writeFileSync(join(dir, "vendor/pkg/0001.js"), "// resplit: cjs module a\nvalues.push(42);\n");
  writeFileSync(join(dir, "99-main.js"), "exports.values = values;\n");
  const result = cli("--reassemble", dir, output);
  assert.equal(result.status, 0, result.stderr);
  const source = readFileSync(output, "utf8");
  assert.doesNotMatch(source, /resplit:/);
  const exports = {};
  runInNewContext(`${source}(exports, null, null, null, null)`, { exports });
  assert.equal(JSON.stringify(exports.values), "[42]");
});

test("a missing reassembly module fails without replacing an existing output", (t) => {
  const root = fixture(t);
  const dir = join(root, "split");
  const output = join(root, "output.js");
  manifest(dir, [{ type: "module", file: "missing.js" }]);
  writeFileSync(output, "keep this output");
  const result = cli("--reassemble", dir, output);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing\.js/);
  assert.equal(readFileSync(output, "utf8"), "keep this output");
});

for (const name of [
  "../outside.js",
  "nested/../../outside.js",
  "..\\outside.js",
  "/outside.js",
  "C:\\outside.js",
]) {
  test(`reassembly rejects unsafe manifest path ${JSON.stringify(name)}`, (t) => {
    const root = fixture(t);
    const dir = join(root, "split");
    const output = join(root, "output.js");
    manifest(dir, [{ type: "module", file: name }]);
    writeFileSync(join(root, "outside.js"), "exports.leaked = true;");
    writeFileSync(output, "keep this output");
    const result = cli("--reassemble", dir, output);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /path|relative|outside|escape/i);
    assert.equal(readFileSync(output, "utf8"), "keep this output");
  });
}

test("reassembly rejects a directory symlink outside the split directory", (t) => {
  const root = fixture(t);
  const dir = join(root, "split");
  const output = join(root, "output.js");
  manifest(dir, [{ type: "module", file: "linked/outside.js" }]);
  writeFileSync(join(root, "outside.js"), "exports.leaked = true;");
  symlinkSync(root, join(dir, "linked"), "junction");
  const result = cli("--reassemble", dir, output);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside|escape/i);
});

for (const sourceOrder of [
  null,
  [],
  "module.js",
  {},
  [null],
  [{ type: "bogus", file: "module.js" }],
  [{ type: "module" }],
]) {
  test(`reassembly rejects malformed sourceOrder ${JSON.stringify(sourceOrder)}`, (t) => {
    const root = fixture(t);
    const dir = join(root, "split");
    const output = join(root, "output.js");
    manifest(dir, sourceOrder);
    const result = cli("--reassemble", dir, output);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sourceOrder/);
  });
}

test("--reassemble without a directory prints usage", () => {
  const result = cli("--reassemble");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stderr, /TypeError/);
});
