# pi-backtrack

[English](README.md) | **简体中文**

让 Agent 主动收起探索过程，以 checkpoint 为边界调整模型上下文并自动继续。**session 历史连续追加，不切换分支，不回滚文件或外部操作。**

## 使用

需要 Pi SDK 0.85.1 兼容环境（建议 Node 22.19+ 或 24+）。本地加载：

```sh
npm ci
pi -e ./src/index.ts
```

同时启用配套的 dynamic-skill 扩展：

```sh
pi -e ./src/index.ts -e ./node_modules/pi-dynamic-skill/src/index.ts
```

两个功能独立；仅安装包依赖不会自动启用另一个扩展。也可使用单独安装的兼容 dynamic-skill 扩展，勿重复加载两份。

```js
backtrack({
  checkpoint: 2,
  message: "checkpoint 2 之后读取了连接池实现和超时日志，增加诊断日志并复现了问题。确认连接池正常；调大连接池未解决超时，不再沿此方向尝试。诊断日志改动尚未提交。回退后检查 retry.ts 的重试与取消逻辑。"
})
```

工具说明引导主动管理上下文，并在用户明显转移话题、或完成支线工作返回主线时先回退。启动及 reload 时，宿主仅在 dynamic-skill 上下文服务已启用时加入技能保存指引；仅安装依赖不会加入这段，不让模型自行判断是否启用。

只有 `checkpoint` 和 `message` 两个参数：

- `checkpoint`：目标编号；目标 checkpoint 及之前的当前有效上下文完整保留，不改写，也不恢复此前已收起的原始历史。
- `message`：从目标 checkpoint 之后做过哪些事情、看过哪些内容、学到哪些经验、试错得到哪些教训，以及回退后的下一步计划。

旧 `description` / `knowledge` 参数会被明确拒绝，不再自动创建会话知识目录。启用 dynamic-skill 时，回退前保存可复用的知识和经验教训。技能目录不自动展开正文，因此关键信息需在 message 中重复强调，或加入“读取 xxx skill 获取 xxx 信息”的指引。

## Checkpoint 与续跑

```text
稳定前缀 → checkpoint 0 → skills → user → checkpoint 1
→ assistant(tool calls) → 完整工具批次结果 → checkpoint 2
→ assistant(最终回复) → 下一条 user → checkpoint 3
```

- 0 是固定起点，位于初始技能块之前；初始技能块不随后续用户输入移动。
- 真实用户输入后、整个工具批次结束后建立 checkpoint。assistant 纯文本回复、Host 注入和请求重试不单独编号。
- 普通回退保留前缀，编号沿当前轮次继续；回退到 0 类似 compact，收起 0 后的内容，替换旧技能投影并生成一份完整目录，编号从 1 重新开始。0 前的稳定前缀不变，不重载 system、工具或原生 skills，也不额外维护 KV Cache。内部轮次避免旧调用命中新编号。
- 工具必须独占批次。execute 返回 prepared，Host 在完整批次落盘后的 turn_end 提交变换；同一 Agent 循环自然继续，不需要用户再次输入。
- 新输入、排队消息、取消或失效目标会阻止未提交的回退。部分提交失败时停止继续执行并报告，不自动重放。

回退后的有效上下文：

```text
保留前缀 → 技能差分/重建目录 → 分层对话历史 → message → 新 checkpoint
```

与 `/tree` 一样，先定位保存的节点，保留其有效前缀，再追加专属交接输入；区别是不移动 session leaf，也不创建新 session。原始工具过程保留在 session 中，但不再进入后续模型请求。原始节点游标与扩展的临时请求注入分开管理，不通过整段请求一致性比较来批准或拒绝回退。投影、marker 和历史块按不可变 entry 引用持久化，避免复制大型工具输出；支持非持久化会话。

## 对话历史与容量

从原始 session 的回退区间提取所有 user/assistant 正文，包括此前嵌套回退的原始对话，再从后往前分层：

| 输出预算（估算 tokens） | 保留方式 |
| --- | --- |
| 5K | 原文 |
| 3K | 每条首尾各 100 tokens |
| 1K | 每条首尾各 20 tokens |
| 1K | 每条首尾各 10 tokens |
| 更早 | 整轮省略标记 |

消息放不进当前层就整条降级，不拆开跨层。最后一轮 user 全文保留；图片仅随完整原文消息保留，截短或省略的消息不保图。完整有图消息维持原始图文交错顺序；保留图片的容量单独估算。无额外模型摘要调用。空区间不注入历史块或空标题。

```text
[12 turns omitted]
user: beginning[800 tokens omitted]ending
assistant: beginning[2.4K tokens omitted]ending
```

中英文、数字和符号分类估算 token；首尾截取不切坏 Unicode grapheme。大于 2000 的省略数量采用 K。

工具说明建议简短任务维持 0-20%、标准任务 0-40%、困难任务 0-80% 的上下文水位。checkpoint 只标 `context …`：仅估算受管有效视图、system 和 active tools，不包含其他扩展临时注入，不是最终请求实测。它们不是硬门槛；回退后 token 不减反增也允许，真实超窗交给宿主 compact。

## Dynamic-skill 配合

- 成功回退触发一次访问结算，统计真实 session 历史，而不是裁剪后的模型消息。
- 仅注入 active/pending 元数据，不再展示 Root Skills；读取 dynamic-skill 根技能即可发现子技能索引。保留上下文中已经有描述的技能不重复打印 active/pending。
- 描述仍可见的溢出候选留在 active，允许超过容量；不能先移入 pending 再隐藏提示。
- 仅实际展示的 pending 记为已预告。回退到 0 重建目录，但不清空 LRU 或删除文件。
- 使用 `pi-dynamic-skill/context` 的版本化服务接口；事件总线只用于同步发现服务，prepare/commit 错误直接传播，不依赖扩展加载顺序。

## 当前 SDK 适配边界

Pi 0.85.1 的原生 compact 从原始历史准备摘要，并按原始 entry ID 保留尾部，不能直接消费扩展投影。为避免复活已回退的工具过程，本扩展在 compact hook 中将**有效对话（排除可重建的 checkpoint 和技能目录）**交给宿主原有摘要器，并不保留原始 raw tail。仍只有宿主本次 compact 的摘要调用，使用其取消、重试和 usage 逻辑。compact 后重新生成 checkpoint。

这会改变原生 `keepRecentTokens` 的保留效果，是当前版本的重要适配选择。宿主进行文本摘要；当前没有保留原文尾部，因此 compact 后也不保留原图，不设独立图片保留区。恢复到有原生物化有效尾部接口的 SDK 后，可再保留准确的有效尾部。详见 [设计及实现记录](docs/design.md)。

节点引用缺失、数据损坏或持久化失败仍会停止请求，不静默退回原始长历史。其他 context hook 的固定前缀／后缀注入已覆盖两种加载顺序；不承诺任意第三方消息改写或重排的通用兼容。compact 取消时，已完成的新边界仍保留 checkpoint，不再消费消息后漏掉编号。旧快照捕获的外部 custom 前缀按出现次数匹配，避免重复注入，不改写原保留前缀。提交失败后的恢复为该事务补充一次模型可见的失败说明，不声称已回滚。

## 依赖与开发

配套依赖快照保存在 `vendor/`，使两个尚未发布的新实现可以独立安装，不要求相邻工作区或远端未发布提交。更新方式见 `vendor/README.md`。未来发布时可替换为不可变 Git 提交依赖。

```sh
npm ci
npm run typecheck
npm test
```

测试先编译 TypeScript，再使用 Node 测试运行器；无需原生 TS strip 标志或模型凭据。覆盖真实 SDK 工具循环、自动续跑、两种加载顺序、知识保存/读取、恢复、取消、原生 compact 和超窗重试。
