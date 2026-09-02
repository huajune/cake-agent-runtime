# TODO：LLM 判官标定（自迭代循环的唯一欠账）

> 2026-08-13 自 agent-self-iteration-loop-plan.md（2026-07-08 稿，整体未落码已删，原文见 git 历史）
> 萃取。循环本身已由 Claude 定时任务体系承接；**真正还欠的只有这一件**。
>
> **状态（2026-09-02）：首次标定已完成，制度已可执行，待用户裁定阈值并注册周任务。**

## 欠什么

现有定时任务（badcase 分析、shadow 观测、复聊审计等）直接消费 LLM 判读结论，
但**判官自身从未过标定考核**——循环的质量上限 = 评估器精度，判官未标定前，
它的产出只是"看起来像结论的文本"。

## 要做什么

每周人工抽检 ~20 条 LLM 判读（badcase 归因 / shadow 假阳判定 / 复聊 blockReason），
与人工裁定对账算判官精确率；不达标的判读维度降级为"需人工复核"。
即 LLM-as-a-judge（见 glossary）的发牌制（P8）：判官的裁决权同样租来的，租金是精确率。

## 已做（2026-09-02 首次标定）

报告：`logs/analysis/judge-calibration-2026-09-02.md`（gitignore 目录，本地）；台账：`logs/observability/judge-calibration.md`。

- **判官点盘点**：10 个裁决/判读点逐一核实输入、消费方、落库位置、14 天量级、现有精度检查（报告附录 A）。
  出站守卫语义审查器已于 08-28 起在生产退役（`guardrail_review_records.semantic_reviews` 归零），不再是判官。
- **首次标定**（Claude 代理人工重判，事先固定 rubric，报告附录 B/C）：
  - 复聊 blockReason：31 次判决 30 一致、1 灰；skip 7/7 归因全对。对比 07-21 审计（35 条错 11）已修好。
  - test-suite Claude 评审：28 条重判 20 一致；58 条里 0 条 failed，宽判形态=拿不准就带技术理由 skipped（2 条已复现缺陷被跳过）、passed 有空证。
  - 回归验证评估器：14 天 0 运行；60 天 10 条里 2 条高分实错（工具结果当真相、加权过线）。
  - 入站词表：生产命中 7/9；离线回放 25/33；**4 种残障自述句式漏拦**（合规敏感）。
- **制度方案**（报告附录 E）：周频口径/分层/检查表、台账格式、降级阈值建议（≥90 正常 / 80~90 需人工复核 / <80 停用自动消费 / 残障召回 <80 置顶）、接入方式与 `weekly-judge-calibration` 任务书草稿（**未注册**）。

## 用户裁定（2026-09-02 下午，报告附录 H）

- test-suite Claude 评审偏宽：**无妨，维持现状，不降级**。
- 回归验证评估器（`src/evaluation/`）：用户判"废的"，已随 PR #1168 删除（回归验证只剩重放 + 人工/Claude 评审）；评估体系口径页 `docs/architecture/agent-quality-evaluation.md` 同 PR 新增，整线下线另开任务。
- 入站词表：确定性修法已落 PR `fix/risk-intercept-wordlist`（残障自述句式补召回、"宝妈的/他妈妈的"不算骂人、扫描前剥引用块）。"给主聊模型拦截能力"另议。
- 复聊样本里"候选人提问无人回"经核实**不是候选人停托管**，是机器人转人工后的设计性静默（request_handoff / 守卫拦下改约回复）+ 暂停托管固定 3 天；用户裁定临时暂停改**次日零点自动恢复**，已落 PR `fix/hosting-pause-resume-at-midnight`。

## 剩什么（按顺序）

1. **用户裁定**：① 阈值取值；② 台账放 `logs/observability/`（易丢）还是 `docs/observability/`（每周一个 PR）；③ 注册周二 07:00 任务（草稿在报告附录 E5）；④ 报告附录 F 的 10 条拿不准样本亲自复核。
2. **待合入**：PR #1165 `fix/hosting-pause-resume-at-midnight`、PR #1166 `fix/risk-intercept-wordlist`、PR #1168 `refactor/remove-llm-similarity-scorer`。
3. **管道观察项（非判官，报告附录 C1/H1）**：复聊发送与候选人来消息同分钟撞车 3 例；守卫 `interview_time_change_unconfirmed` 两次把改约回复整条拦成静默（交 weekly-guardrail-analysis 复核真假阳）；入职跟进缺"真人已问过"停止条件。

## 与现有机制的衔接

- 复聊语义判定已做过一次 35 条抽样审计（错误率 ~31%，三处已修）——本次复测 31 条 0 错，缺的是**周频化、口径固定、结果落台账**，三者已在报告附录 E 落成可执行方案；
- fact-adjudication 日频任务的"公证三问分项精确率抽查"（判据④）是同族动作，已并入周任务的 J9 一栏（每周从定时任务报告抽 5 条结论回库复核）。

## 同族欠账收编（2026-08-17，自 prompt-guardrail-and-naming-alignment.md C3 移入，原文档已完结删除）

- **input 词表精确率补票**：本次已补（报告附录 C4 + SQL-E/F）：生产口径 7/9、离线口径 25/33、残障自述召回约 6/10；结论已入台账。后续随周任务 J4 一栏滚动。

## 现状（2026-09-02）

- 口径：首次标定报告 `logs/analysis/judge-calibration-2026-09-02.md` 附录 B（rubric R1 / R2 / R4）与附录 D（SQL）是唯一口径源，任务书只引用不复制。
- 台账：精确率数字落 [docs/quality-metrics-ledger.md](../quality-metrics-ledger.md)（metric=`判官精确率`，每个判官点一行），首次标定四行已登记；样本明细留在报告。
- 任务：`weekly-judge-calibration` 已注册（每周二 07:00，任务书在 `~/.claude/scheduled-tasks/`）；降级阈值已裁定，正式居所在口径页 §2（≥90% 正常 / 80%~90% 需人工复核 / <80% 停用自动消费 / 残障召回 <80% 置顶）。等首次自动运行在台账落行后即可删除本 todo。
- 回归验证评估器（原 J3）已删除，不再是判官点；test-suite Claude 评审（J2）用户裁定偏宽无妨、不降级。
