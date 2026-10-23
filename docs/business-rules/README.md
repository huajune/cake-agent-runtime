# 招聘业务规则

仓库是规则维护依据。这里按业务主题解释当前口径、连接实际实现与测试，并记录待裁定问题；运行时手册仍在 `src`，应用不会读取本目录。首次归档覆盖七个主题，不改变已有招聘口径，不增加数据库配置或飞书同步。

| 主题 | 范围 |
| --- | --- |
| [IB 面试与报名](ib.md) | 预检、报名、时间窗口、改约、取消、复聊 |
| [SW 薪资福利与社保](sw.md) | 薪资展示、结算、保险、福利与缺失事实 |
| [ID 身份与资格](id.md) | 身份归属、健康证、用工形式、筛选边界 |
| [SH 班次与出勤](sh.md) | 班次、工期、出勤与候选人约束 |
| [GEO 地理与城市](geo.md) | 定位、地址、城市意向与地理证据 |
| [GP 岗位与拉群](gp.md) | 查询推荐、品牌、无岗与群邀请 |
| [HO 人工介入边界](ho.md) | 真人沟通、招聘方身份与转交场景 |

## 文件各自负责什么

```text
src/agent/generator/context/sections/procedural/
  candidate-consultation.md   共通规程 + 原顺序的片段引用
  rules/{ib,sw,id,sh,geo,gp,ho}.md   模型读取的业务手册正文
src/tools、src/resolution、src/agent/guardrail、src/agent/reengagement
  各自消费的规则与执行逻辑
docs/business-rules/          业务摘要、来源、实现/测试关联、冲突
docs/prompt-rule-ledger.md    prompt 的放置纪律、容量与居所索引
src/skills/maintain-business-rules/SKILL.md   Claude/Codex 共用维护流程
```

手册加载器按入口中的 `{{rule:IB-01}}` 展开片段并剥离维护注释，保持原有顺序与空白。七份资产必须完整打包；缺失、重复、未引用或格式错误会阻断启动，避免悄悄丢失规则。基线 `12090e6f` 的模型可见正文为 55,988 UTF-8 字节，迁移等价性由 `manual-loader.spec.ts` 校验。

现有数据库红线/阶段策略仍是运行时外部输入，本次不迁移、不扩展其配置能力。文档不据仓库推断生产配置内容；发现冲突时记录具体版本和证据，再裁定。

## 如何维护

Claude 和 Codex 都使用 [maintain-business-rules](../../src/skills/maintain-business-rules/SKILL.md)。
`.claude/skills/maintain-business-rules` 与 `.agents/skills/maintain-business-rules` 均链接到同一源目录。

每个业务编号稳定，例如 `IB-01`。条目写摘要及 `状态`、`来源`、`落点`、`验证`；落点为仓库路径及 `#符号或规则ID`，验证为真实测试路径。同一规则可以包含多处实现。源码头的 `business-rules` 注释、手册片段标记和目录内 `businessRule` 字段均反向关联主题文档。

- **现行基线**：如实归档已有行为，未重新裁定其合理性。
- **已裁定**：有明确业务结论，来源中记录依据和日期。
- **待裁定**：新建议尚未批准，不得挂到运行时执行。
- **已废止**：保留编号和废止原因，不得继续挂到运行时执行。

当前行为存在争议时保留「现行基线」，在「未决与冲突」记录争议；不能把仍在执行的整条规则改成「待裁定」。身份筛退与无证据声称招满的冲突按用户 2026-10-23 裁定仅记录，保持当前行为。

## 校验与测试

```bash
pnpm run business-rules:validate
pnpm run business-rules:test -- IB SW
pnpm run business-rules:test
```

校验直接读取主题文档和现有 Guardrail / final-check 定义，不维护第二份配置清单。它检查编号、来源、状态、文件/符号存在、源码/目录反向关联、技术机制的豁免理由，以及手册片段完整性；已接入 `ci:check` 和 GitHub CI。

主题测试命令先校验关联，再按文档中的测试路径去重执行。关联表示测试可用于核查这个规则，不表示每一条分支均已覆盖；新增或修正规则时仍须审查测试断言是否验证了实际业务条件。现有契约测试、静态校验和机械迁移摘要都不能证明真实 Agent 的业务回复通过；真实链路结果以对应 PR 的验证证据为准。

有意调整口径时，同批更新运行时实现、本文档、prompt 台账和行为测试。更新手册摘要基线需说明具体业务变化；仅调整文件组织则应保持模型可见正文一致。
