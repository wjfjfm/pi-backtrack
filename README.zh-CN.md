# ⏪ pi-backtrack

### 让Agent自主控制上下文，完成递归的思考和探索

[English](README.md) · **简体中文** · [设计与实现](docs/design.md)

探索一条支线，带回结论，收起过程，再继续主线。

不是等上下文塞满后被动压缩，而是让 Agent 自己决定：**哪些内容继续携带，何时回退，从哪里重新出发。**

```text
主线 ──────●───────────────────────────────▶ 继续推进
           │                              ▲
           └─ 探索 ──●─ 更深的探索 ── 结论 ─┘
                     └─ 试错 → 带回经验 ↗
           checkpoint          backtrack
```

**感知水位 · 自主回退 · 自动续跑 · 知识复用**

## 01 / 原理：给 Agent 一张上下文地图

在 **user input** 和 **tool result** 后注入 checkpoint 与上下文仪表，让 Agent 在每个交互边界感知当前上下文状态，并自主决定是否回退、回退到哪个位点。并行工具调用以**完整工具批次**为边界，而不是每条结果分别打点。

```text
user input
  └─ [checkpoint 1 | context 12K/200K 6%]

Agent → tool calls → tool results
  └─ [checkpoint 2 | context 48K/200K 24%]

Agent → 继续探索，或 backtrack(checkpoint: 1)
```

*以上为示意数值。仪表是 token 估算，不是最终请求的精确计量。*

回退时，保留目标 checkpoint 及之前的**当前有效上下文**，收起后续工具过程，追加分层对话历史与 Agent 的交接信息，然后在同一轮执行中自动继续：

```text
回退前   保留前缀 │ 大量读取、搜索、工具输出、试错过程
回退后   保留前缀 │ 精简对话历史 + 交接信息 → 新 checkpoint → 继续
```

- **Agent 决定路径**：可以逐层探索、逐层返回，不必等到上下文溢出。
- **不额外调用模型做摘要**：backtrack 以确定性规则保留、截取对话，Agent 自己写交接。
- **收起上下文，不撤销工作**：原始 session 历史仍连续保留；不切换分支，不回滚文件或外部操作。

## 02 / 工具：一个调用，返回主线

```js
backtrack({
  checkpoint: 1,
  message: "已读连接池实现并添加诊断，确认瓶颈不在连接池；扩容无效。保留诊断改动，接下来检查重试逻辑。"
})
```

只有两个参数：`checkpoint` 指定返回位点；`message` 交接做过什么、看过什么、结论与试错教训，以及下一步。工具应独占调用批次，成功后自动续跑。返回 `0` 可从固定起点重建上下文，编号重新开始。

## 03 / 安装：推荐搭配 dynamic-skill

需要 Pi 0.85.1 兼容环境，建议 Node.js 22.19+ 或 24+。

**一起安装：一个管理上下文，一个保存可复用知识。**

```sh
pi install git:github.com/wjfjfm/pi-backtrack
pi install git:github.com/wjfjfm/pi-dynamic-skill
```

在已有会话中执行 `/reload`，或启动新会话。只需要上下文回退时，执行第一条即可；backtrack 可以独立使用。

<details>
<summary>从本地源码运行</summary>

```sh
git clone https://github.com/wjfjfm/pi-backtrack.git
cd pi-backtrack
npm ci

# 同时加载 backtrack 与随包提供的 dynamic-skill 快照
pi -e ./src/index.ts -e ./node_modules/pi-dynamic-skill/src/index.ts
```

仅加载 backtrack：`pi -e ./src/index.ts`。安装 npm 依赖本身不会启用配套扩展；若已全局启用 dynamic-skill，不要再加载第二份。

</details>

## 04 / 配合：上下文可以收起，经验不必丢掉

[**pi-dynamic-skill**](https://github.com/wjfjfm/pi-dynamic-skill) 把可复用的知识保存为文件化技能，让探索不止留下本次任务的答案。

| | pi-backtrack | pi-dynamic-skill |
| --- | --- | --- |
| 关注什么 | 当前模型需要携带哪些上下文 | 哪些经验值得保存、再次发现 |
| 如何工作 | checkpoint → 回退 → 交接续跑 | SKILL.md → LRU 管理 → 按需读取 |
| 留下什么 | 有效前缀与继续工作的线索 | 可跨会话复用的知识文件 |

```text
探索 → 总结经验 → write / edit 保存 skill → backtrack
                                              ↓
继续任务 ← 按需读取 skill 正文 ← 活跃技能名称、描述与路径
```

同时启用后，Agent 会收到**回退前保存知识**的指引；成功回退会结算技能访问，并补充尚未出现在保留上下文中的技能描述。它不会自动展开技能正文，因此关键结论仍应写进 `message`，或明确提示“读取 xxx skill 获取 xxx 信息”。

也可以用 `/dynamic-skill` 手工挑选：默认查看 **LRU**，**Tab** 切换 **All** 多级目录，**Space** 勾选，**Enter** 应用。新增项下一模型 turn 注入；取消项静默等待下次 backtrack、compact 或 reload 移出队列。**淘汰不删除技能文件。**

---

<details>
<summary>边界与实现细节</summary>

- checkpoint 0 是固定起点；普通回退延续编号，回退到 0 重建技能目录并从 1 开始。不会恢复此前已收起的原始工具过程。
- 对话按由近到远的预算分层：5K 原文、3K 首尾各 100 tokens、1K 首尾各 20、1K 首尾各 10，更早轮次省略。最新用户输入全文保留。图片仅随完整原文消息保留。
- 水位估算包含有效视图、system 与 active tools，不包含其他扩展的临时注入。回退不保证 token 数必然下降，真实超窗仍由宿主 compact 处理。
- **Pi 0.85.1 compact 适配**：将有效对话交给宿主摘要器，不保留原始 raw tail，避免复活已回退的工具过程。这会改变 `keepRecentTokens` 的原样保尾效果，compact 后也不保留原图。backtrack 本身不增加摘要调用。
- 新输入、取消或失效目标会阻止未提交的回退。持久化失败会停止执行并报告，不声称已回滚。兼容两种扩展加载顺序，不承诺任意第三方上下文重排。

更多内容见 [设计与实现](docs/design.md)，配套依赖快照见 [vendor/README.md](vendor/README.md)。

</details>

<details>
<summary>开发与测试</summary>

```sh
npm ci
npm run typecheck
npm test
```

覆盖真实 Pi SDK 工具循环、续跑、两种加载顺序、技能协作、取消、恢复、compact 和超窗重试。使用脚本 provider，无需模型凭据。

</details>
