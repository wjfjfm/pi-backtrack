# pi-backtrack

[English](README.md) | **简体中文**

Agent-controlled context backtracking with checkpoints and handoffs.

让 Agent 在长程任务中主动收起已经消化的探索过程，带着结论回到历史节点并继续执行。

## 设计参考

- [Kimi CLI / SendDMail](https://github.com/MoonshotAI/kimi-cli/tree/main/src/kimi_cli/tools/dmail)：支持 Agent 主动撰写交接摘要、回退并继续执行，同时将 checkpoint 编号注入上下文。
- [pi-context](https://github.com/ttttmr/pi-context)：提供 timeline 历史展示，让 Agent 通过时间线定位节点并主动折叠，无需逐轮注入 checkpoint 编号。
- [KorenKrita/pi-context](https://github.com/KorenKrita/pi-context)：在上游基础上增加上下文水位提示，为 Agent 判断折叠时机提供反馈。

## 状态

已实现 Pi 扩展入口与 `backtrack` 工具注册。checkpoint 注入和实际回退逻辑尚未实现；当前调用工具会明确返回错误，不改变上下文。

## 核心交互

Host 在第一次模型生成前、以及每个完整工具批次结束后的下一次生成前，自动建立 checkpoint，并追加模型可见的状态标记：

```text
[checkpoint 20 | context 100K/300K 33%]
```

Agent 判断一段探索已经完成或方向错误后，调用：

```js
backtrack({
  checkpoint: 20,
  description: "数据库排查结论与证据，供后续复查。",
  knowledge: "已排除数据库问题。诊断日志已写入，尚未提交。",
  message: "检查 retry.ts 的重试循环。"
})
```

Host 保留目标之前的历史，以知识条目替换目标之后的当前后缀。本次条目完整展开，旧条目折叠为 description。独立的 message 追加到续跑上下文，不存入知识条目。原始后缀保留用于恢复。

```text
之前：前缀 → 20 → 大量探索 → backtrack 调用
之后：前缀（旧知识折叠）→ 本次知识展开 → message → 新 checkpoint → 继续执行
```

一次用户输入可以触发任意多轮工具交互，不需要用户再次输入，也不需要 Agent 提前调用 checkpoint 工具。

## 初版边界

- 一个模型回复中的多个 tool call 属于一个批次，全部结果到齐后才建立下一个 checkpoint。
- backtrack 必须独占工具批次；Host 强制校验，不能只依赖提示词。
- 只回退上下文，不回滚文件、进程或外部操作；摘要必须交代这些状态。
- 摘要由当前 Agent 撰写，不额外调用模型归纳。
- 知识条目保存 description 和 knowledge，计划支持按需读取；下次 backtrack 时统一收起旧条目及其读取副本。读取条目时不返回续跑 message。
- 旧标记不更新，保持原有前缀稳定；实际回退仍可能导致目标位置之后的缓存失效。
- 占用不精确时明确标记估算，不把 UI 数据或上一轮 usage 冒充当前精确容量。
- 初版只处理后缀回退；区间压缩、历史检索与恢复工具留待后续设计。

实现约束与待验证问题见 [设计说明](docs/design.md)。

## 开发

```sh
npm install
npm run typecheck
```

开发基于 Pi SDK 0.85.1。本地加载扩展：

```sh
pi -e ./src/index.ts
```

加载后仅注册工具，尚不能执行上下文回退。
