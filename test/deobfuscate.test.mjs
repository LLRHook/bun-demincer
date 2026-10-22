import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../src/deobfuscate.mjs", import.meta.url));
const metacharacters =
  process.platform === "win32"
    ? "%TEMP% $(printf literal)"
    : '" $(printf literal) $HOME `printf literal`';

function fixture(t, name = "decoded") {
  const root = mkdtempSync(join(tmpdir(), "bun-demincer-deobfuscate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "0001.js"), "var a = 1; console.log(a);\n");
  return { root, dir };
}

function cli(args, cwd, env = process.env) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 15000,
  });
}

for (const value of ["0", "-1", "1.5", "garbage", "2files", "9007199254740992"]) {
  test(`--concurrency rejects ${JSON.stringify(value)} before changing files`, (t) => {
    const { dir } = fixture(t);
    const original = readFileSync(join(dir, "0001.js"), "utf8");
    const result = cli(["--dir", dir, "--only", "wakaru", "--concurrency", value]);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /concurrency.*positive.*integer/i);
    assert.equal(readFileSync(join(dir, "0001.js"), "utf8"), original);
  });
}

test("an option cannot consume the next flag as its value", (t) => {
  const { dir } = fixture(t);
  const result = cli(["--dir", dir, "--batch", "--only", "prettier"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--batch requires a value/);
});

test("an empty --only value fails before running the default stages", (t) => {
  const { dir } = fixture(t);
  const result = cli(["--dir", dir, "--only", ""]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--only requires a value/);
});

for (const option of ["--dir", "--batch", "--skip", "--only", "--manifest", "--concurrency"]) {
  test(`${option} requires a value`, (t) => {
    const { dir } = fixture(t);
    const result = cli(["--dir", dir, "--only", "prettier", option]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${option}.*requires a value`));
  });
}

for (const option of ["--only", "--skip"]) {
  test(`${option} rejects misspelled stage names`, (t) => {
    const { dir } = fixture(t);
    const result = cli(["--dir", dir, option, "pretier"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown stage.*pretier/i);
  });
}

test("rename treats shell metacharacters in input and batch paths literally", (t) => {
  const { root, dir } = fixture(t, `decoded space ${metacharacters}`);
  const batch = join(root, `batch ${metacharacters}.json`);
  writeFileSync(batch, JSON.stringify({ a: "meaningfulValue" }));
  const result = cli(["--dir", dir, "--batch", batch, "--only", "rename"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(dir, "0001.js"), "utf8"), /var meaningfulValue = 1/);
  assert.equal(existsSync(join(dir, ".rename-batch-tmp.json")), false);
});

test("extraction subprocesses support metacharacters in paths", (t) => {
  const { root, dir } = fixture(t, `decoded ${metacharacters}`);
  writeFileSync(
    join(dir, "0001.js"),
    "var n = {}; var a = 1; MR(n, { readableValue: () => a });\n",
  );
  const result = cli(["--dir", dir, "--skip", "wakaru", "--skip", "prettier"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /failed, continuing/);
  assert.match(readFileSync(join(dir, "0001.js"), "utf8"), /var readableValue = 1/);
  assert.deepEqual(readdirSync(dir), ["0001.js"]);
});

test("extraction resolves relative exclusion batch paths from the caller's directory", (t) => {
  const { root, dir } = fixture(t);
  const batch = join(root, "batch.json");
  writeFileSync(batch, JSON.stringify({ aa: "preferredName" }));
  writeFileSync(join(dir, "0001.js"), 'var aa = {}; aa.displayName = "InferredName";\n');
  const result = cli(
    ["--dir", "decoded", "--batch", "batch.json", "--skip", "wakaru", "--skip", "prettier"],
    root,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(dir, "0001.js"), "utf8"), /var preferredName/);
  assert.doesNotMatch(readFileSync(join(dir, "0001.js"), "utf8"), /var InferredName/);
});

test("a failed rename cleans generated rename maps and keeps user batch files", (t) => {
  const { root, dir } = fixture(t);
  const batch = join(root, "invalid-batch.json");
  writeFileSync(batch, "{invalid JSON");
  const result = cli(["--dir", dir, "--batch", batch, "--skip", "wakaru", "--skip", "prettier"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Pipeline failed/);
  assert.equal(readFileSync(batch, "utf8"), "{invalid JSON");
  assert.deepEqual(readdirSync(dir), ["0001.js"]);
});

test("a rename subprocess failure is reported and its temporary batch is removed", (t) => {
  const { root, dir } = fixture(t);
  const batch = join(root, "batch.json");
  const badManifest = join(root, "bad-manifest.json");
  const tempRoot = join(root, "temp");
  mkdirSync(tempRoot);
  writeFileSync(batch, JSON.stringify({ a: "meaningfulValue" }));
  writeFileSync(badManifest, JSON.stringify({}));
  const result = cli(
    ["--dir", dir, "--batch", batch, "--manifest", badManifest, "--only", "rename"],
    root,
    { ...process.env, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Rename stage failed/);
  assert.equal(existsSync(join(dir, ".rename-batch-tmp.json")), false);
  assert.equal(readFileSync(batch, "utf8"), JSON.stringify({ a: "meaningfulValue" }));
  assert.deepEqual(readdirSync(tempRoot), []);
});

test("successful pipeline cleanup preserves pre-existing files with former temporary names", (t) => {
  const { root, dir } = fixture(t);
  const batch = join(root, "batch.json");
  const tempRoot = join(root, "temp");
  mkdirSync(tempRoot);
  writeFileSync(batch, JSON.stringify({ a: "meaningfulValue" }));
  const userFiles = [".auto-renames.json", ".auto-names.json", ".rename-batch-tmp.json"];
  for (const name of userFiles) writeFileSync(join(dir, name), "user-owned content");
  const result = cli(
    ["--dir", dir, "--batch", batch, "--skip", "wakaru", "--skip", "prettier"],
    root,
    { ...process.env, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(dir, "0001.js"), "utf8"), /var meaningfulValue/);
  for (const name of userFiles) {
    assert.equal(readFileSync(join(dir, name), "utf8"), "user-owned content");
  }
  assert.deepEqual(readdirSync(tempRoot), []);
});

test("prettier ignores directories ending in .js and preserves runtime files", (t) => {
  const { dir } = fixture(t);
  mkdirSync(join(dir, "assets.js"));
  writeFileSync(join(dir, "00-runtime.js"), "var runtime=1;");
  const result = cli(["--dir", dir, "--only", "prettier"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dir, "00-runtime.js"), "utf8"), "var runtime=1;");
});
