import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../src/extract.mjs", import.meta.url));

// Minimal fixture in the extractor's documented StandaloneModuleGraph format.
function binary(modules) {
  const payloads = [];
  const table = Buffer.alloc(modules.length * 52);
  let offset = 0;
  for (const [index, mod] of modules.entries()) {
    for (const [field, value] of [
      [0, mod.name],
      [8, mod.content],
      [16, mod.sourcemap || ""],
    ]) {
      const bytes = Buffer.from(value);
      table.writeUInt32LE(offset, index * 52 + field);
      table.writeUInt32LE(bytes.length, index * 52 + field + 4);
      payloads.push(bytes);
      offset += bytes.length;
    }
    table[index * 52 + 48] = 2;
    table[index * 52 + 49] = 1;
    table[index * 52 + 50] = 1;
  }
  const offsets = Buffer.alloc(32);
  const trailer = Buffer.from("\n---- Bun! ----\n");
  offsets.writeBigUInt64LE(BigInt(offset + table.length + offsets.length + trailer.length));
  offsets.writeUInt32LE(offset, 8);
  offsets.writeUInt32LE(table.length, 12);
  return Buffer.concat([
    Buffer.from("synthetic executable\n"),
    ...payloads,
    table,
    offsets,
    trailer,
  ]);
}

function fixture(t, modules) {
  const root = mkdtempSync(join(tmpdir(), "bun-demincer-extract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "binary");
  const output = join(root, "extracted files");
  writeFileSync(input, binary(modules));
  return { root, input, output };
}

function extract(input, output) {
  return spawnSync(process.execPath, [script, input, output], { encoding: "utf8", timeout: 5000 });
}

test("extracts nested Bun paths, binary content, sourcemaps, and the manifest", (t) => {
  const { input, output } = fixture(t, [
    {
      name: "/$bunfs/root/nested/bundle.js",
      content: "console.log(42);",
      sourcemap: '{"version":3}',
    },
    { name: "$bunfs/root/assets/data.bin", content: Buffer.from([0, 255, 1]) },
  ]);
  const result = extract(input, output);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(output, "nested/bundle.js"), "utf8"), "console.log(42);");
  assert.equal(readFileSync(join(output, "nested/bundle.js.map"), "utf8"), '{"version":3}');
  assert.deepEqual(readFileSync(join(output, "assets/data.bin")), Buffer.from([0, 255, 1]));
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.modules.length, 2);
  assert.equal(manifest.entryPoint, "/$bunfs/root/nested/bundle.js");
});

for (const name of [
  "/$bunfs/root/../escaped.js",
  "../escaped.js",
  "..\\escaped.js",
  "/absolute.js",
  "C:\\absolute.js",
  "manifest.json",
]) {
  test(`rejects unsafe or reserved embedded path ${JSON.stringify(name)} before writing modules`, (t) => {
    const { root, input, output } = fixture(t, [
      { name: "/$bunfs/root/bundle.js", content: "changed" },
      { name, content: "outside" },
    ]);
    mkdirSync(output);
    writeFileSync(join(output, "bundle.js"), "keep existing output");
    writeFileSync(join(root, "escaped.js"), "keep outside file");
    const result = extract(input, output);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /path|reserved|collision/i);
    assert.equal(readFileSync(join(output, "bundle.js"), "utf8"), "keep existing output");
    assert.equal(readFileSync(join(root, "escaped.js"), "utf8"), "keep outside file");
    assert.deepEqual(readdirSync(output), ["bundle.js"]);
  });
}

test("rejects an existing output symlink without modifying the target", (t) => {
  const { root, input, output } = fixture(t, [{ name: "linked/escaped.js", content: "changed" }]);
  mkdirSync(output);
  writeFileSync(join(root, "escaped.js"), "keep outside file");
  symlinkSync(root, join(output, "linked"), "junction");
  const result = extract(input, output);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink|symbolic link/i);
  assert.equal(readFileSync(join(root, "escaped.js"), "utf8"), "keep outside file");
});

for (const modules of [
  [
    { name: "bundle.js", content: "first" },
    { name: "bundle.js", content: "second" },
  ],
  [
    { name: "bundle.js", content: "first", sourcemap: "{}" },
    { name: "bundle.js.map", content: "second" },
  ],
  [
    { name: "assets/.", content: "first", sourcemap: "{}" },
    { name: "assets.map", content: "second" },
  ],
  [
    { name: "assets", content: "first" },
    { name: "assets/other.js", content: "second" },
  ],
]) {
  test(`rejects conflicting output paths ${modules.map((mod) => mod.name).join(", ")}`, (t) => {
    const { input, output } = fixture(t, modules);
    const result = extract(input, output);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /path|collision/i);
    assert.deepEqual(readdirSync(output), []);
  });
}
