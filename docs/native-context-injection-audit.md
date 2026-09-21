# 原生迁移：上下文注入审计

本记录说明**为什么改变模型输入**及审计位置，不复制文案、schema 或测试结果。精确文本以源码为准。

| 变化 | 理由与审计入口 |
| --- | --- |
| 新增保留尾部的参数与使用场景；交接参数可选、允许空白 | 用户明确确认的工具契约。只在工具定义说明，不增加运行时指导。见 `src/tool-description.ts`、`src/schema.ts`。 |
| checkpoint 改为原生上下文上的请求注释 | 保留格式，不再依靠独立 view。marker 不进入 compact 摘要；用量不含 marker 和请求期临时消息，仍是估算。见 `src/engine.ts`。 |
| 默认模式保留 handoff；尾部模式不另行注入 | 尾部已保留当前调用，避免交接重复。默认模式未传 message 也保留空正文，显式空白不隐藏。见 `src/engine.ts`。 |
| 成功结果不再声称仅完成准备；尾部结果说明保留范围与交接位置 | 用户确认的结果提示，须在宿主提交后发布。见 `src/index.ts`。 |
| 失败原位替换结果，删除独立取消／恢复通知 | 避免先报成功再补救、重复提示或伪造结果。见宿主 `agent-session.ts` 批次 finalizer。 |
| 删除 backtrack 中 dynamic-skill 专属指导与兼容注入 | 技能策略属于技能扩展，backtrack 不判断其存在与否。见 `src/tool-description.ts`、`src/context.ts`、`src/index.ts`。 |
| dynamic-skill 移除 context hook 补消息，改由原生生命周期补缺失描述 | 宿主负责刷新，扩展不修复旧消息快照；保留描述不重写。见该项目 `src/index.ts`、`src/runtime.ts`。 |
| 技能待淘汰提示与描述分别去重 | 描述仍在不代表已经告知淘汰状态；必要时补名称／路径列表而非重复描述。这是新增可见内容，不应称为零文本变化。见 dynamic-skill `src/prompt.ts`。 |
| compact 摘要输入改为有效上下文 | 防止折叠内容复活；超预算的不可拆分替代块允许整体进入摘要。原摘要 prompt 和 wrapper 不改。见宿主 compaction 实现。 |

未改动历史裁剪策略及来源 header；没有新增 fold wrapper、边界说明消息或宿主成功通知。旧 view 拒绝走 UI/stderr 与 abort，不注入恢复指导。

审计应检查实际下一轮模型请求，而不只看持久化记录或 TUI。相关断言在 native-host、native-skills、native-failure、native-runtime 集成测试中；包括空白交接、交接不重复、描述补缺、失败不误报及加载顺序。
