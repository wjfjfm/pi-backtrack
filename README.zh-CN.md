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
backtrack-checkpoint 3 context 48K/200K 24%
```

Agent 感知上下文容量，根据当前任务自主回退到某个 checkpoint，完整保留此前的有效上下文以便复用 KV Cache，携带探索中积累的知识继续工作。

```js
backtrack({
  checkpoint: 1,
  message: "已读连接池实现并添加诊断，排除连接池瓶颈；扩容无效。保留诊断改动，接下来检查重试逻辑。"
})
```

`checkpoint` 指定返回位点。`message` 记录已做工作、查阅内容、结论、试错教训和下一步。

普通 `backtrack({ checkpoint: 0, message: "…" })` 会在完整工具批次结束后重置 Pi 原生工作上下文基线，不调用摘要模型。只保留本区间裁剪后的对话（含保留的图片）和本次 handoff，不继承更早的基线或 handoff；仍需使用的结论应主动写入交接。原始历史继续归档。非零回退和保留尾部的回退行为不变。

## 安装

使用未修改的 Pi 0.99.1 和 Node.js ≥22.19.0。见[运行与迁移说明](docs/public-extension.md)。

```sh
pi install git:github.com/wjfjfm/pi-backtrack
```

执行 `/reload` 或启动新会话。从修改版宿主迁移时必须新建会话，不自动转换旧的 native-backtrack 会话。

配合 [pi-dynamic-skill](https://github.com/wjfjfm/pi-dynamic-skill) 时，先加载 backtrack，使技能留存依据折叠后的上下文，而非原始历史。

<details>
<summary>本地运行</summary>

```sh
git clone https://github.com/wjfjfm/pi-backtrack.git
cd pi-backtrack
npm ci
pi -e ./src/index.ts
```

</details>

## Design reference

- [Kimi CLI / SendDMail](https://github.com/MoonshotAI/kimi-cli/tree/main/src/kimi_cli/tools/dmail)：支持 Agent 主动撰写交接摘要、回退并继续执行，同时将 checkpoint 编号注入上下文。
- [pi-context](https://github.com/ttttmr/pi-context)：提供 timeline 历史展示，让 Agent 通过时间线定位节点并主动折叠，无需逐轮注入 checkpoint 编号。
- [KorenKrita/pi-context](https://github.com/KorenKrita/pi-context)：在上游基础上增加上下文水位提示，为 Agent 判断折叠时机提供反馈。
