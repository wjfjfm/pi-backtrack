# pi-backtrack

让Agent自主控制上下文，完成递归的思考和探索

[English](README.md) · **简体中文**

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

## 原理

在 user input 和完整 tool result 批次后注入 checkpoint 与上下文用量：

```text
[checkpoint 3 | context 48K/200K 24%]
```

Agent 根据任务进度和上下文状态选择回退位点。回退保留目标 checkpoint 及之前的有效上下文，将后续工具过程替换为分层对话历史和交接信息，然后自动续跑。

```js
backtrack({
  checkpoint: 1,
  message: "已读连接池实现并添加诊断，排除连接池瓶颈；扩容无效。保留诊断改动，接下来检查重试逻辑。"
})
```

`checkpoint` 指定返回位点。`message` 记录已做工作、查阅内容、结论、试错教训和下一步。工具须独占调用批次。

## 安装

需要 Pi 0.85.1 兼容环境，建议 Node.js 22.19+ 或 24+。

推荐同时安装 [pi-dynamic-skill](https://github.com/wjfjfm/pi-dynamic-skill)：

```sh
pi install git:github.com/wjfjfm/pi-backtrack
pi install git:github.com/wjfjfm/pi-dynamic-skill
```

执行 `/reload` 或启动新会话。backtrack 可独立使用，但推荐使用 pi-dynamic-skill 模块承载长期记忆。

<details>
<summary>本地运行</summary>

```sh
git clone https://github.com/wjfjfm/pi-backtrack.git
cd pi-backtrack
npm ci
pi -e ./src/index.ts -e ./node_modules/pi-dynamic-skill/src/index.ts
```

仅运行 backtrack 时去掉第二个 `-e`。若已全局启用 dynamic-skill，不要重复加载。

</details>

## dynamic-skill

**Context 是工作集，skill 是长期记忆。**

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

Agent 在回退前用 `write` / `edit` 固化结论、方法和失败路径。backtrack 收起探索过程；下一次遇到相关任务，再通过 `read` 取回知识，不必重走同一条支线。

- **按需加载**：上下文只注入技能的名称、描述和路径，正文需要时再读。
- **LRU 管理**：回退时结算访问，更新技能目录；技能离开队列，文件仍然保留。
- **手工选择**：`/dynamic-skill` → Tab 切换 LRU / All → Space 勾选 → Enter 应用。

技能文件跨会话复用，活跃队列按会话维护。

## Design reference

- [设计与实现](docs/design.md)：checkpoint、上下文投影、分层历史、回退事务与 SDK 适配。
- [pi-dynamic-skill](https://github.com/wjfjfm/pi-dynamic-skill)：技能树、LRU 与按需加载。
- [依赖快照](vendor/README.md)：配套版本与更新方法。
