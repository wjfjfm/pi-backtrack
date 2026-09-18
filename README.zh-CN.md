# pi-backtrack

让Agent自主控制上下文，完成递归的思考和探索

[English](README.md) · **简体中文**

```text
  │
  │◀── backtrack ───────╮
  │                     │
  │◀── backtrack ─╮     │
  ├──▶ explore ───╯     │
  │                     │
  │◀── backtrack ─╮     │
  ├──▶ explore ───╯     │
  │                     │
  ├──▶ explore ─────────╯
  │
  ▼
```

## 原理

在 user input 和完整 tool result 批次后注入 checkpoint 与上下文用量：

```text
[checkpoint 3 | context 48K/200K 24%]
```

Agent 感知上下文容量，根据当前任务自主回退到某个 checkpoint，完整保留此前的有效上下文以便复用 KV Cache，携带探索中积累的知识继续工作。

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
pi -e ./src/index.ts
```

配合本地 dynamic-skill 时，另加 `-e /path/to/pi-dynamic-skill/src/index.ts`，并在该项目中独立安装依赖。若已全局启用，不要重复加载。

</details>

## dynamic-skill

dynamic-skill 是使用 LRU 维护的 skill 动态装载器。以多层树状结构组织 skill，将 Agent 新创建或近期访问过的 skill 描述维护在上下文中，不常访问的被逐出活跃队列。

dynamic-skill 通过追加上下文信息装载，KV-Cache 友好。使用 `/dynamic-skill` 查看或手动维护装载的 skill。

## Design reference

- [Kimi CLI / SendDMail](https://github.com/MoonshotAI/kimi-cli/tree/main/src/kimi_cli/tools/dmail)：支持 Agent 主动撰写交接摘要、回退并继续执行，同时将 checkpoint 编号注入上下文。
- [pi-context](https://github.com/ttttmr/pi-context)：提供 timeline 历史展示，让 Agent 通过时间线定位节点并主动折叠，无需逐轮注入 checkpoint 编号。
- [KorenKrita/pi-context](https://github.com/KorenKrita/pi-context)：在上游基础上增加上下文水位提示，为 Agent 判断折叠时机提供反馈。
