import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

test("split, deobfuscate, rename, and reassemble preserve a synthetic bundle's behavior", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bun-demincer-pipeline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "bundle.js");
  const dir = join(root, "decoded");
  const output = join(root, "reassembled.js");
  const batch = join(root, "renames.json");
  const source = `// @bun @bytecode @bun-cjs
(function(exports, require, module, __filename, __dirname) {
var y = (fn, cache) => () => (cache || fn((cache = {exports: {}}).exports, cache), cache.exports);
var aa = y((exports) => { exports.answer = !0; });
var bb = y((exports) => { exports.answer = aa().answer; });
exports.result = bb().answer;
})`;
  writeFileSync(input, source);
  writeFileSync(batch, JSON.stringify({ aa: "requireAnswer" }));

  function run(script, args) {
    const result = spawnSync(process.execPath, [join(srcDir, script), ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result;
  }

  run("resplit.mjs", [input, dir]);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.stats.totalModules, 2);
  const runtime = readFileSync(join(dir, "00-runtime.js"), "utf8");
  const processed = run("deobfuscate.mjs", ["--dir", dir, "--batch", batch, "--concurrency", "1"]);
  assert.doesNotMatch(processed.stderr, /failed|Warning:/);
  assert.equal(readFileSync(join(dir, "00-runtime.js"), "utf8"), runtime);
  run("resplit.mjs", ["--reassemble", dir, output]);
  const reconstructed = readFileSync(output, "utf8");
  assert.match(reconstructed, /requireAnswer/);
  assert.match(reconstructed, /true/);

  function execute(code) {
    const exports = {};
    runInNewContext(`${code}(exports, null, null, null, null)`, { exports });
    return exports.result;
  }
  assert.equal(execute(source), true);
  assert.equal(execute(reconstructed), true);
});
