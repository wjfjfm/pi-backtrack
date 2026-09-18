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
  message: "已排除数据库问题；诊断日志已写入但未提交。接下来检查 retry.ts。"
})
```

只有 `checkpoint` 和 `message` 两个参数。旧 `description` / `knowledge` 参数会被明确拒绝，不再自动创建会话知识目录。需要长期保留的结论应在回退前用普通 write/edit 保存到 dynamic-skill，并确认成功。

## Checkpoint 与续跑

```text
稳定前缀 → checkpoint 0 → skills → user → checkpoint 1
→ assistant(tool calls) → 完整工具批次结果 → checkpoint 2
→ assistant(最终回复) → 下一条 user → checkpoint 3
```

- 0 是固定起点，位于初始技能块之前；初始技能块不随后续用户输入移动。
- 真实用户输入后、整个工具批次结束后建立 checkpoint。assistant 纯文本回复、Host 注入和请求重试不单独编号。
- 普通回退保留前缀，编号沿当前轮次继续；回退到 0 重建技能块，编号从 1 重新开始。内部轮次避免旧调用命中新编号。
- 工具必须独占批次。execute 返回 prepared，Host 在完整批次落盘后的 turn_end 提交变换；同一 Agent 循环自然继续，不需要用户再次输入。
- 新输入、排队消息、取消或失效目标会阻止未提交的回退。部分提交失败时停止继续执行并报告，不自动重放。

回退后的有效上下文：

```text
保留前缀 → 技能差分/重建目录 → 分层对话历史 → message → 新 checkpoint
```

原始工具过程保留在 session 中，但不再进入后续模型请求。投影、marker 和历史块通过带版本的自定义 session entry 持久化；原始消息用 entry ID 引用，避免重复复制大型工具输出。支持非持久化会话（只在内存中保存）。

## 对话历史与容量

从原始 session 的回退区间提取所有 user/assistant 正文，包括此前嵌套回退的原始对话，再从后往前分层：

| 输出预算（估算 tokens） | 保留方式 |
| --- | --- |
| 5K | 原文 |
| 3K | 每条首尾各 100 tokens |
| 1K | 每条首尾各 20 tokens |
| 1K | 每条首尾各 10 tokens |
| 更早 | 整轮省略标记 |

消息放不进当前层就整条降级，不拆开跨层。最后一轮 user 全文和所有用户原始图片优先保留；图片容量单独估算。无额外模型摘要调用。

```text
[12 turns omitted]
user: beginning[800 tokens omitted]ending
assistant: beginning[2.4K tokens omitted]ending
```

中英文、数字和符号分类估算 token；首尾截取不切坏 Unicode grapheme。大于 2000 的省略数量采用 K。

工具说明建议简短任务维持 0%–20%、标准任务 20%–50%、困难任务 40%–80% 的上下文水位。它们不是硬门槛，不为达到下限填充上下文；回退后 token 不减反增也允许，真实超窗交给宿主 compact。

## Dynamic-skill 配合

- 成功回退触发一次访问结算，统计真实 session 历史，而不是裁剪后的模型消息。
- 保留上下文中已经有描述的技能不重复打印 active/pending。
- 描述仍可见的溢出候选留在 active，允许超过容量；不能先移入 pending 再隐藏提示。
- 仅实际展示的 pending 记为已预告。回退到 0 重建目录，但不清空 LRU 或删除文件。
- 使用 `pi-dynamic-skill/context` 的版本化服务接口；事件总线只用于同步发现服务，prepare/commit 错误直接传播，不依赖扩展加载顺序。

## 当前 SDK 适配边界

Pi 0.85.1 的原生 compact 从原始历史准备摘要，并按原始 entry ID 保留尾部，不能直接消费扩展投影。为避免复活已回退的工具过程，本扩展在 compact hook 中将**完整有效上下文**交给宿主原有摘要器，并不保留原始 raw tail。仍只有宿主本次 compact 的摘要调用，使用其取消、重试和 usage 逻辑。compact 后重新生成 checkpoint。

这会改变原生 `keepRecentTokens` 的保留效果，是当前版本的重要适配选择。恢复到有原生物化有效尾部接口的 SDK 后，可再保留准确的有效尾部。详见 [设计及实现记录](docs/design.md)。

投影失败会停止请求，不静默退回原始长历史。其他扩展若原地改写已保存的消息前缀，会触发此保护；普通追加消息不受影响。

## 依赖与开发

配套依赖快照保存在 `vendor/`，使两个尚未发布的新实现可以独立安装，不要求相邻工作区或远端未发布提交。更新方式见 `vendor/README.md`。未来发布时可替换为不可变 Git 提交依赖。

```sh
npm ci
npm run typecheck
npm test
```

测试先编译 TypeScript，再使用 Node 测试运行器；无需原生 TS strip 标志或模型凭据。覆盖真实 SDK 工具循环、自动续跑、两种加载顺序、知识保存/读取、恢复、取消、原生 compact 和超窗重试。
