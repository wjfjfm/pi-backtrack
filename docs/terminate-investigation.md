# final 后未出现 backtrack：调查记录

## 历史证据

2026-09-29 当前会话的 assistant entries `cd0f475a`、`518778f2` 都只包含 thinking/text，stopReason=stop、rawStopReason=completed；textSignature.phase=final_answer。没有 toolCall、对应工具结果或 backtrack 提交记录。

这只能证明工具调用没有到达会话/执行层，不能证明服务端原始响应没有包含调用。未取得这两次请求的原始 SSE/WebSocket 事件，不能从解析后记录排除丢失。

## 当前安装版解析器的隔离复现

脚本：`/tmp/pi-final-tool-parser-matrix.mjs`，直接加载已部署 runtime 的 `pi-ai/dist/api/openai-responses-shared.js`，无网络、无认证信息、无执行工具。

三个输入均先发送 final_answer 正文，最终 response.completed.output 均包含 backtrack function_call：

| 工具调用增量事件 | 解析得到工具调用 | stopReason |
| --- | --- | --- |
| output_item.added + output_item.done | 1 | toolUse |
| 只有 output_item.done | 1 | toolUse |
| 没有工具 item 事件，仅 completed.output 含调用 | 0 | stop |

第三种情况下确实会漏读最终响应中存在的工具调用，且与历史表现相同。但尚无原始响应证明历史两次属于第三种输入。

## 代码位置与边界

- `pi-native-backtrack/packages/ai/src/api/openai-responses-shared.ts` 的 finalizeResponse（约 552 行）：最终 response.output 只用于补 reasoning signature，没有补缺失的 function_call/custom_tool_call；stopReason 根据已构建的 output.content 决定，因此遗漏后为 stop。
- 同文件 output_item.added/done 正常创建工具块；不会仅因 final_answer 正文出现就停止解析。
- `openai-codex-responses.ts` 的 mapCodexEvents 在 response.completed/done 后结束，这是终止事件处理，不是遇到正文就终止。完成事件之后才出现工具 item 属于另一种需要原始事件证明的时序异常。
- Agent loop 从 content 中提取 toolCall；历史记录没有该块，不能归因于 backtrack 的 terminate 返回值或回退提交。

## 真实网络对照（后续已完成）

脚本 `/tmp/pi-live-final-tool-trace.mjs` 使用当前安装版 ModelRuntime、当前配置的 openai-codex/gpt-6-astra，独立 SSE 请求，不执行返回工具。通过自定义 fetch 记录进入解析器之前的事件结构；仅保存事件类型、ID、phase、工具名，不保存认证、正文或工具参数。独立 Node 初次未配置 CLI 的代理 dispatcher 时 fetch failed；配置相同 dispatcher 后四次请求均 HTTP 200。

两种提示各重复两次，结果一致：

| 提示 | 原始网络事件 | Pi 解析 |
| --- | --- | --- |
| 先输出 final answer，再 backtrack | message(final_answer) → completed；无 function_call | text，stop |
| 先输出 user-visible text，再 backtrack | message(commentary) → function_call(backtrack) → completed | text + toolCall，toolUse；terminate=true |

四次 completed.output 都为空，因此这组真实复现不符合上面的 completed-only 漏读条件。证据文件 `/tmp/pi-live-final-tool-trace-first.json`、`/tmp/pi-live-final-tool-trace.json`，均仅含脱敏结构。

目前最有力的解释是：要求 final answer 先输出，会让本 provider 进入 final_answer 阶段并结束响应，调用没有发送到 Pi；不是本地工具执行层丢弃。改成用户可见正文再调用，可生成 commentary+toolCall，原有 terminate 机制无需更改。

边界：两次历史请求没有原始流；本实验只有同模型隔离 SSE 的四个样本，不能断言所有 provider 都如此，也不能证明服务端内部是模型、网关还是其他终止机制决定停止。当前真实会话若使用 WebSocket，仍不能由 SSE 对照完全排除其特有问题。建议参数描述避免“final answer, followed by tool call”，改为“answer text, then call backtrack with terminate:true”；正式文案修改待用户确认。

本轮未修改宿主、provider 或扩展行为。即使后续确认需要 SDK 修复，也应作为上游解析兼容问题处理，不能让 backtrack 猜测正文并伪造一次调用。

## 反向顺序：工具调用在前、回答在后

后续经用户同意，用 `/tmp/pi-live-tool-first-trace.mjs` 对同一模型做四次独立 SSE 请求，不执行工具。测试工具说明同步改为先调用再回答，避免与用户提示冲突：

- “先调用，再输出 answer text”：两次均只有 function_call → completed，没有正文。
- “先调用，再输出 final answer”：两次均只有 function_call → completed，没有正文。
- 四次均 HTTP 200，Pi 均解析为单个 backtrack toolCall、terminate=true、stopReason=toolUse；没有正文被解析器丢弃的证据。

脱敏事件结构保存在 `/tmp/pi-live-tool-first-trace.json`。只能说明当前模型与本组提示下未实现该顺序，不能断言所有 provider 都不允许；但不适合作为当前正式提示策略，否则终止后会缺少回答。

另据 interactive-mode.ts 的 message_start/message_update 和 assistant-message.ts 的 updateContent：TUI 先创建一个 assistant 容器，正文始终更新进该容器；工具组件另行追加在其后。即使消息块为 toolCall→text，也不意味着正文会显示在工具组件下面。这是源码结论，未做此次场景的真实 PTY 验收。

结论：维持 answer text→backtrack(terminate:true)，不修改现有文案。若要回答在视觉上最后，应另行审查公开工具 renderer 的展示精简能力，而不是假定调整模型生成顺序即可重排 TUI。没有修改运行代码。
