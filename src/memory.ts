import { basename, dirname, join } from "node:path";
import { createSkill, SkillExistsError, type SkillReference } from "pi-dynamic-skill";
import type { BacktrackArguments } from "./schema.js";

/** Keep each session's knowledge alongside its JSONL file. */
export function getMemoryDirectory(sessionFile: string): string {
  if (!sessionFile || !sessionFile.endsWith(".jsonl")) {
    throw new Error("A persisted Pi session file is required to store backtrack memory.");
  }
  return join(dirname(sessionFile), basename(sessionFile, ".jsonl"), "skills");
}

/** Storage adapter for the future backtrack transaction; excludes message. */
export async function createBacktrackMemory(
  sessionFile: string,
  args: Pick<BacktrackArguments, "description" | "knowledge">,
): Promise<SkillReference> {
  const directory = getMemoryDirectory(sessionFile);
  const now = new Date();
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
  const baseName = `backtrack-${stamp}`;
  for (let suffix = 0; ; suffix++) {
    try {
      return await createSkill(directory, {
        name: suffix === 0 ? baseName : `${baseName}-${suffix}`,
        description: args.description,
        content: args.knowledge,
      });
    } catch (error) {
      if (!(error instanceof SkillExistsError)) throw error;
    }
  }
}
