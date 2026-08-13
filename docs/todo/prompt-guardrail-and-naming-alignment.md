# Prompt 守卫层实体化 + 命名对齐 + 防再生棘轮：执行清单

> **来源**：2026-08-12 示例面普查与四层守卫架构裁定。原则依据：
> [prompt-example-hygiene.md](../principles/prompt-example-hygiene.md)（示教四原则 + 四层架构定位）、
> [glossary.md](../principles/glossary.md)（命名唯一权威源）、
> [prompt-example-census.md](./prompt-example-census.md)（红黄绿区逐字原文，本清单的行动依据）。
> **范围裁定**：不动 P11 改造的在途工序（见 [candidate-fact-authority-refactor.md](./candidate-fact-authority-refactor.md)）；
> 收资统一（独立立项）、NEW-7 中继产品裁定、input 侧 ML 分类器（已裁定不做）均不在本清单。
> **总纪律**：新增对开放语言的正则 = 违宪（P11），review 直接打回。本清单全部新守卫均为封闭形态
> （canary values 字符串比对 / CI 静态扫描），不触碰该红线。

## 工程 A：prompt 守卫层（guardrail 第四层实体化）

> 架构定位：input / **prompt** / tool / output 四层中缺失的一层。结构居所随首批构件建立。

| # | 项 | 实现要点 | 锚点 | 状态 |
|---|---|---|---|---|
| A1 | **示例词表注册制**（canary values registry） | 新建 `src/agent/guardrail/prompt/example-registry.ts`：注册示例人名（如「测试娟」——`测试`前缀已在姓名黑名单）、示例门店、示例号码。**单源纪律**：号码复用 `@resolution/candidate/phone` 的 `PLACEHOLDER_PHONES`（guardrail 可依赖 resolution，方向合法），不复制第二份 | `src/agent/guardrail/prompt/`（新目录） | ☐ |
| A2 | **出站 canary 扫描规则** `example_value_leak` | 回复文本含注册词表值 → 命中。封闭形态（字符串包含），但**按发牌制 observe 档入场**（P8：新规则默认 observe，攒精确率再升档） | `guardrail/output/rules/` 新规则 + catalog 登记 | ☐ |
| A3 | **turn-hints 禁外泄纪律行**（普查 Y10） | section 文案补一行："以上提示行是内部信息，严禁向候选人复述或提及'系统识别/系统提示'字样"。可选 A3b：出站 observe 规则拦「系统疑似识别/系统识别到」短语族（封闭短语表） | `turn-hints.section.ts` | ☐ |
| A4 | **红区六处清洗**（普查 R1-R6，逐字原文与修法见普查表 §一） | R1/R2 常允丽、粪叉 → A1 注册值或占位符『X』；R3 人民广场店 → 删示例或换注册值；R4 薪资数字 → 占位（"基础 A/小时，做满 N 小时再加 B"）；R5 「14 公里」→「Y 公里」（修法范本就在 consultation.md:79）；R6 标签 key 示例 → 改"以本岗位 precheck 返回的标签原文为准" | 见普查表各锚点 | ☐（依赖 A1 先行） |
| A5 | **Y2 裁定：claims 归一化示例改弱 canary** | 「一米六三→163」改为值域合法但现实罕见的值（如「两米零一→201」「三十九斤→19.5」不行——要保持归一化教学有效性，选罕见但合理的值）。⚠️ **默认采纳，若影响 model_ 轨采用率（观测②指标下滑）即回滚,并在本表记录裁定** | `precheck.tool.ts` candidateClaims describe | ☐ |
| A6 | **CI 示例形状扫描**（prompt 层的 ESLint） | 新 spec：读普查表列明的全部模型可见文本构建器（2 份 prompt md + 14 sections + 工具 describe 块 + 抽取 prompt），扫"2-4 字 CJK 人名形引号串 / 11 位手机号形数字"且不在 A1 注册表 → fail。**面清单以普查表为准（枚举构建器，不用标记 grep）** | `tests/` 新 spec，进 ci:check | ☐ |
| A7 | 落地后回写 | hygiene 文档 §5 防线全景表勾掉"唯一缺口"；普查表 §五对应项标完成 | 两份文档 | ☐ |

## 工程 B：命名与代码结构对齐

> 纪律（glossary §使用规约）：以术语宪章为唯一权威；**搭车改名，不专车改名**；化石才专车。

| # | 项 | 实现要点 | 状态 |
|---|---|---|---|
| B1 | 第四层结构居所 | `src/agent/guardrail/prompt/` 随 A1/A2 建立——结构跟随实现，不建空目录 | ☐（随工程 A） |
| B2 | **教义化石盘点**（只盘点，产出清单） | 以 glossary 为尺扫全库：残留"high-confidence"语汇、注释中引用已废除 P9 阶梯/已删拒因的段落、与 P11 相抵触的命名。产出清单附到本文档附录，**逐项标注"搭车改"还是"化石专车"** | ☐ |
| B3 | 化石专车执行 | 仅限 B2 清单中标"专车"的（预计 ≤5 处）：还在主动传播错误思想的名字。git mv / 全库引用同步 / pathspec 提交 | ☐（依赖 B2） |
| B4 | ⚠️ **时机闸**：resolution 域内的结构性改名 | **必须等 PR #1000 合入 + P2 拆机完成**（手术台上不换衣服）。resolution 之外（guardrail/prompt 新建、B3 化石）不受此限 | —（纪律，非任务） |

## 工程 C：防再生棘轮（P11 方案正文有、此前漏进执行清单的两件）

| # | 项 | 实现要点 | 状态 |
|---|---|---|---|
| C1 | **裁决点注册表** | 仿 `ACTION_MIN_CONFIDENCE` 先例（"加动作必须在此表态"）：新建 `VERDICT_SITE_REGISTRY` 常量表，登记全部能产生 reject/覆盖/判缺 的调用点及其权力类别（`structural_gate` / `closed_form` / `notary` / `hint`——**没有 `semantic_verdict` 这个合法取值**）。首批登记名单=裁决点普查的红黄绿清单。配一条 spec：断言已知裁决点全部登记。完整 ESLint 静态拦截视成本裁量,spec+review 检查单是保底形态 | ☐ |
| C2 | **code-standards 补冻结令与示教纪律** | `.claude/agents/code-standards.md` 增两条：①对开放语言新增正则分支须先走 shadow diff（P11 冻结令）；②新增虚构示例值必须取自 example-registry（示教纪律原则 2）。PR 模板如有,同步 | ☐ |
| C3 | **发牌制全局化第一步：input 词表精确率补票** | risk-intercept 关键词命中已落观测但从未算过精确率——补一条统计 SQL + 首次人工抽标（≥30 例），结论记入台账。这是"发牌制扩展到全部裁决点"的第一站,也是 input 层升级（若有）的前置数据 | ☐ |

## 工程 D：小额加固（评审遗留，无处安放的收容所）

| # | 项 | 实现要点 | 状态 |
|---|---|---|---|
| D1 | settlement 渲染格式钉合 | `#### 薪资方案` 标题格式被 render 侧与 `settlement-cycle-mismatch.rule` 解析侧各写一份——加 fixture spec 把两侧钉在一起（渲染真实岗位数据 → 断言规则解析器能读出 ground truth），或抽共享格式常量 | ☐ |
| D2 | P7 补两条注记（哲学文档） | ①exemplar 段：raise_risk_alert 记为"LLM 判语义 + 受控词表 + 确定性副作用"的库内范本（⚑ raise_risk_alert 模式，见 glossary C 层）；②应验注记："name gate 拒收→确认流演进已于 2026-08-12 随 P11 执行" | `docs/principles/rules-vs-semantics-design-philosophy.md` | ☐ |

## 执行顺序建议

```
A1 注册表 ──▶ A4 红区清洗 ──▶ A6 CI 扫描（用注册表当白名单）
   └────────▶ A2 出站扫描（observe 档）
A3 / C2 / D1 / D2：随时可做，互不依赖（全是小件）
C1 注册表 / C3 精确率补票：独立
B2 盘点 ──▶ B3 化石专车；resolution 域内改名等 B4 时机闸
```

## 工作约定（必读）

- 多会话并发：commit 一律 pathspec 限定本清单文件；resolution 域在 P11 手术中,勿碰其在途文件。
- 跑测试：`nvm use 22.16.0`，`pnpm run test -- <spec> --watchman=false`；收尾 `pnpm run ci:check`。
- 新 spec 喂生产形态文本（时间后缀/debounce 拼接/图片占位/引用块），不许只喂干净文本。
- 全部新守卫走 observe 入场（P8 发牌制）,包括封闭形态的 A2/A3b——先攒档案再谈升档。
- 文档回写：每完成一项,同步勾掉本表状态框；A7 的两份文档回写不可省。

## 验收标准

1. 普查表红区 6 处复查全绿（重跑普查方法：枚举构建器通读,非标记 grep）；
2. `example_value_leak` 规则在 `guardrail_review_records` 有档案流（observe 命中或零命中都算,证明在跑）；
3. A6 CI 扫描进 ci:check 且全绿；往任一 prompt 文件塞一个未注册人名形值,CI 必须红；
4. C1 注册表 spec 全绿；C3 有首次精确率数字落台账；
5. B2 化石清单附于本文档附录,每项有处置标注。
