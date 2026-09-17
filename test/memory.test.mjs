import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reloadSkills } from "pi-dynamic-skill";
import { createBacktrackMemory, getMemoryDirectory } from "../src/memory.ts";

test("backtrack stores knowledge through its dependency, excluding continuation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "backtrack-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "timestamp_session.jsonl");
  const args = { checkpoint: 20, description: "Consult for retry findings", knowledge: "Database ruled out.", message: "DO_NOT_SAVE_THIS_CONTINUATION" };
  const refs = await Promise.all(Array.from({ length: 4 }, () => createBacktrackMemory(file, args)));
  assert.equal(new Set(refs.map((ref) => ref.name)).size, 4);
  const body = await readFile(refs[0].filePath, "utf8");
  assert.ok(body.endsWith(args.knowledge));
  assert.ok(!body.includes(args.message));
  assert.deepEqual(reloadSkills(getMemoryDirectory(file)).diagnostics, []);
  assert.equal(reloadSkills(getMemoryDirectory(file)).skills.length, 4);
  assert.equal(reloadSkills(getMemoryDirectory(join(root, "other.jsonl"))).skills.length, 0);
  assert.throws(() => getMemoryDirectory(""), /persisted Pi session/);
});
