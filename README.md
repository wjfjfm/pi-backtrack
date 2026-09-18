# pi-backtrack

Agent-controlled context for recursive thinking and exploration.

**English** · [简体中文](README.zh-CN.md)

```text
      |
      v
      o<--------------------- backtrack -------------------------+
      |                                                          |
      +--> explore --+                                           |
      |              |                                           |
      |              o<------- backtrack -------+                |
      |              |                          |                |
      |              +--> explore --------------+                |
      |              |                                           |
      |              o<------- backtrack -------+                |
      |              |                          |                |
      |              +--> explore --------------+                |
      |              |                                           |
      |              +-------------------------------------------+
      |
      v
```

## How it works

Injects a checkpoint and context usage after each user input and complete tool-result batch:

```text
[checkpoint 3 | context 48K/200K 24%]
```

The agent selects a return point based on task progress and context usage. Backtracking preserves the effective context through that checkpoint, replaces subsequent tool activity with tiered dialogue history and a handoff, then continues automatically.

```js
backtrack({
  checkpoint: 1,
  message: "Read the pool implementation and added diagnostics. Ruled out the pool; increasing its size did not help. Keep the diagnostic changes and inspect retry logic next."
})
```

`checkpoint` selects the return point. `message` records work done, material examined, findings, failed attempts and lessons, and next steps. Call the tool alone in its batch.

## Install

Requires a Pi 0.85.1-compatible environment. Node.js 22.19+ or 24+ is recommended.

Recommended: install with [pi-dynamic-skill](https://github.com/wjfjfm/pi-dynamic-skill).

```sh
pi install git:github.com/wjfjfm/pi-backtrack
pi install git:github.com/wjfjfm/pi-dynamic-skill
```

Run `/reload` or start a new session. Backtrack works independently, but pi-dynamic-skill is recommended for long-term memory.

<details>
<summary>Run locally</summary>

```sh
git clone https://github.com/wjfjfm/pi-backtrack.git
cd pi-backtrack
npm ci
pi -e ./src/index.ts -e ./node_modules/pi-dynamic-skill/src/index.ts
```

Omit the second `-e` to run backtrack alone. Do not load another copy of dynamic-skill if it is already enabled globally.

</details>

## dynamic-skill

**Context is the working set. Skills are long-term memory.**

```text
           working context                     persistent skills
      +------------------------+           +------------------------+
      | explore -> findings    |-- save -->| SKILL.md               |
      |                        |           | knowledge + procedures |
      | checkpoint <- backtrack|<-- read --| lessons + failed paths |
      +-----------+------------+           +------------------------+
                  |
                  v
               continue
```

Before backtracking, the agent uses `write` / `edit` to persist findings, procedures, and failed approaches. Backtrack folds away the exploration. A later task can `read` the skill instead of retracing the same branch.

- **On-demand loading**: only skill names, descriptions, and paths are injected. Read bodies when needed.
- **LRU management**: backtracking settles accesses and updates the skill directory. Eviction removes queue membership, not files.
- **Manual selection**: `/dynamic-skill` → Tab for LRU / All → Space to toggle → Enter to apply.

Skill files persist across sessions. Active queues are session-local.

## Design reference

- [Design & implementation](docs/design.md): checkpoints, context projection, tiered history, backtrack transactions, and SDK adaptation.
- [pi-dynamic-skill](https://github.com/wjfjfm/pi-dynamic-skill): skill trees, LRU, and on-demand loading.
- [Dependency snapshot](vendor/README.md): companion version and update procedure.
