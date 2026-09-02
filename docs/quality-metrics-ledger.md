# 质量指标台账（Quality Metrics Ledger）

> 定时观测任务量化结论的**唯一落点**：一个任务一次运行 → 若干行，追加到文末「台账」表。
> 指标名与阶段名只准取自口径页 [Agent 质量评估体系](architecture/agent-quality-evaluation.md) §1；
> `pnpm run quality-ledger:validate` 校验白名单与行格式（已挂 `ci:check`）。
> 样本明细、SQL、定性分析留在各任务自己的报告里，本表只收数字和一句大白话。

## 列定义

| 列          | 填什么                                                                                                                                                 | 校验                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| date        | 运行日，北京时间 `YYYY-MM-DD`（与任务报告文件名同一天）                                                                                                | 合法日期             |
| source_task | 产出任务：`weekly-guardrail-analysis` / `weekly-handoff-analysis` / `fact-adjudication-shadow-daily` / `weekly-judge-calibration`；人工补录写 `manual` | 白名单               |
| stage       | 口径页 §1 五个阶段之一：`trust_building` / `job_consultation` / `qualify_candidate` / `interview_scheduling` / `onboard_followup`；横切或全阶段写 `-`  | 白名单               |
| metric      | 口径页 §1 横切指标：`硬错误率` / `转人工精确率` / `稳定率` / `判官精确率`                                                                              | 白名单               |
| value       | `numerator / denominator`，保留 4 位小数（0~1）                                                                                                        | 必须等于分子除分母   |
| numerator   | 分子，整数                                                                                                                                             | ≤ 分母               |
| denominator | 分母，整数                                                                                                                                             | > 0；为 0 就不写行   |
| note        | 一句大白话（≤120 字）：这行数字的具体口径 + 本期最该知道的一件事；不含姓名/手机号                                                                      | 非空、无 11 位手机号 |
| trace_ref   | 证据指针：报告路径、trace_id / batch_id / chat_id 前 8 位，`;` 分隔                                                                                    | 非空                 |

同一天同一任务同一阶段同一指标可以多行（如判官标定的多个判官点），靠 note 区分；
(date, source_task, stage, metric, note) 五元组不得重复。单元格里不要用竖线。

## 写入纪律

1. 只追加、不改历史行、不重排。数字写错了追加一行更正，note 写明「更正 YYYY-MM-DD 那行」。
2. 没有样本、分母为 0、查询超时 → 不写行、不编数字，在报告里说明。
3. 定时任务不动主工作树：从 `origin/develop` 开独立 worktree，只改本文件，跑校验，
   `docs(quality-ledger): …` 提交，PR 目标 `develop`。命令在各任务书「结论落账」一节。
4. 阈值与降级动作不在本表（见口径页与各任务书）；本表只记数。

## 各任务落什么

| source_task                    | metric       | stage                                                    | 分子 / 分母                                                                                                   | 频率 |
| ------------------------------ | ------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---- |
| weekly-guardrail-analysis      | 硬错误率     | `-`                                                      | enforce 档首审命中的回合（剔除本期立案为假阳的规则）/ 窗口内 `message_processing_records` status=success 回合 | 周   |
| weekly-handoff-analysis        | 转人工精确率 | `-`；某阶段样本 ≥5 时另加该阶段一行                      | 抽样里 reason_code 与对话事实一致的条数 / 抽样条数（把握不足不进分母）                                        | 周   |
| fact-adjudication-shadow-daily | 判官精确率   | `qualify_candidate`                                      | 判据④公证抽查里「候选人确实没说过」的条数 / 抽查条数（7 天合计，周一写）                                      | 周   |
| weekly-judge-calibration       | 判官精确率   | J1 复聊 `onboard_followup`；J2 测试评审、J4 入站词表 `-` | 判官说"是"里真是 / 判官说"是"（每个判官点一行）                                                               | 周   |
| （无自动生产者）               | 稳定率       | `-`                                                      | 重跑 3 次结论一致的 case / 参与重跑的 case；手工跑批次后以 `manual` 登记                                      | 按需 |

## 台账

| date       | source_task              | stage            | metric     | value  | numerator | denominator | note                                                                                                               | trace_ref                                        |
| ---------- | ------------------------ | ---------------- | ---------- | ------ | --------- | ----------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 2026-09-02 | weekly-judge-calibration | onboard_followup | 判官精确率 | 0.9677 | 30        | 31          | 首次标定（人工触发）J1 复聊 blockReason：31 次判决 30 一致、1 条把握不足；skip 7/7 归因全对                        | logs/analysis/judge-calibration-2026-09-02.md#C1 |
| 2026-09-02 | weekly-judge-calibration | -                | 判官精确率 | 0.7143 | 20        | 28          | 首次标定 J2 test-suite Claude 评审：28 条重判 20 一致（宽判 1、skip 误用 2、把握不足 5）；用户裁定偏宽无妨、不降级 | logs/analysis/judge-calibration-2026-09-02.md#C2 |
| 2026-09-02 | weekly-judge-calibration | -                | 判官精确率 | 0.7778 | 7         | 9           | 首次标定 J4 入站词表生产命中 35 天：9 条 7 真阳，假阳=「宝妈的」子串、引用块；残障自述 4 句式漏拦已提修复 PR       | logs/analysis/judge-calibration-2026-09-02.md#C4 |
| 2026-09-02 | weekly-judge-calibration | -                | 判官精确率 | 0.7576 | 25        | 33          | 首次标定 J4 入站词表离线回放 45 天：33 条会命中、25 真阳                                                           | logs/analysis/judge-calibration-2026-09-02.md#C4 |
