---
name: analyze-guardrail
description: 分析出站守卫（output guardrail）的生产效果，产出一份口径正确、可执行的优化清单——哪些规则该收窄/下线/升档、repair 链路哪里在漏。用户说"分析守卫""guardrail 效果怎么样""守卫还有哪些要优化""守卫假阳""规则精度""看守卫数据"时使用。只要目标是评估或改进 guardrail 本身（而非单条对话排障），都应触发本 skill。
---

# 守卫效果分析

产出物是**优化清单**，不是数字堆砌。每个结论必须落到"哪条规则、什么证据、建议什么动作"。

## 为什么必须用本 skill 的口径

历史上守卫分析反复出错，根因是口径每次重新推导。以下口径全部经生产数据验证（2026-08-20 校准），**不要凭表名和列名望文生义**。

### 数据源真相

**`guardrail_review_records` 有两个写入者，行数不等于命中数：**

1. **runner**（`agent-runner.service.ts` 的 `persistReviewRecord`）：只在有硬规则信号时落行——`first_decision <> 'pass'` 或 `first_rule_ids` 非空。干净通过的回合**不落行**。
2. **语义影子 recorder**：每个被语义评审的回合都落/更新行（`semantic_reviews` 字段），即使零硬规则命中。这类行 `first_decision='pass'` 且 `first_rule_ids` 为空，占表的大多数。

因此：
- **硬规则信号行** = `first_decision <> 'pass' OR array_length(first_rule_ids,1) > 0`
- **拦截率/命中率的分母**来自 `message_processing_records`（每回合都有，join 键 `mpr.batch_id = grr.trace_id`），绝不能用守卫表自身行数当分母。
- `mpr.created_at` 无索引，按时间过滤**必须用 `received_at`**，大窗口配 `WITH ... AS MATERIALIZED` 两段式。

### 决策语义表

| 字段/值 | 含义 | 分析时怎么算 |
|---|---|---|
| `first_decision='pass'` + rules 非空 | **observe 档命中**（只记录不动手） | 升档候选池，不是拦截 |
| `first_decision='revise'/'block'` | enforce 档首审命中 | 拦截尝试 |
| `revised_decision <> 'pass'` | **二审复燃**：修复版仍命中 | 假阳嫌疑 or repair 无效，须抽样分辨 |
| `final_decision='block'` | 整轮静默，候选人收不到回复 | 杀伤最大，最优先人工核查 |
| `reason_code='repair_exhausted_fail_open'` | 复燃但 P1/P2 可恢复 → 投递修复版 | 复燃即假阳嫌疑重灾区 |
| `reason_code='repair_exhausted'` | 复燃且高风险/不可恢复 → 静默 | 真事故或高杀伤假阳 |
| `repair_regression_*` | 修复版退化被回归闸拦下 | repair 质量问题 |
| `fence_stripped` / `envelope_unwrapped` | 确定性机械剥离修复 | 不是 LLM 重写，单独归类 |
| `semantic_reviews` | **shadow 档**，不 enforce | 只作形状勘探，绝不能算"防住了 N 起事故"（0811 裁定：语义层是勘探器；0805 清算：大簇几乎全假阳） |

### 判真假阳的铁律

`first_violations` 里的 `evidence`/`suggestion` 是 **output-rule-catalog 的静态文案**（规则命中就原样落档），不是逐案证据。判断一条命中是真阳还是假阳，必须读 `user_message` + `first_reply` + `revised_reply` 原文，必要时 join mpr 取 `tool_calls`（同名 `batch_id`）。

**复燃行的分辨法**：读 `revised_reply`——修复版业务上已正确（如实拒绝/如实转述）却仍被拦 → 规则假阳（典型：不理解否定/复述语境，见 trace `batch_6a86626bce406a6aee0e0aa0`，已修 PR#1021）；修复版确实还违规 → repair 反馈质量问题（`feedbackToGenerator` 静态文案不够具体）。

## 安全纪律（生产库）

- 每条查询自带 `BEGIN; SET LOCAL statement_timeout = '25s'; ...; COMMIT;`
- 严格串行，任一条超时立即停手（生产连接池被打满过，全线 522）。
- 抽样 LIMIT ≤ 10，长文本用 `left(col, N)` 截断。

## 分析流程

### Step 1 — 窗口与分母

默认近 7 天；用户给窗口以用户为准。注意保留期：mpr 仅 30 天，更长趋势不可回填。

```sql
BEGIN; SET LOCAL statement_timeout = '25s';
WITH w AS MATERIALIZED (
  SELECT status FROM message_processing_records
  WHERE received_at >= now() - interval '7 days'
)
SELECT status, count(*) AS n FROM w GROUP BY 1 ORDER BY n DESC;
COMMIT;
```

`status='success'` 行数是回合分母。

### Step 2 — 决策分桶总览

```sql
BEGIN; SET LOCAL statement_timeout = '25s';
SELECT first_decision, final_decision, coalesce(reason_code,'-') AS reason_code, count(*) AS n
FROM guardrail_review_records
WHERE created_at >= now() - interval '7 days'
GROUP BY 1,2,3 ORDER BY n DESC;
COMMIT;
```

解读要点：`revise→pass` 无 reason_code = repair 一次成功（健康主流）；`repair_exhausted_fail_open` 与 `final=block` 两桶是后续抽样重点。

### Step 3 — 规则效能榜（优化清单的骨架）

```sql
BEGIN; SET LOCAL statement_timeout = '25s';
WITH hits AS (
  SELECT unnest(first_blocked_rule_ids) AS rule_id,
         (revised_decision IS NOT NULL AND revised_decision <> 'pass') AS reflagged,
         final_decision, reason_code
  FROM guardrail_review_records
  WHERE created_at >= now() - interval '7 days'
    AND first_decision <> 'pass'
)
SELECT rule_id, count(*) AS hits,
       count(*) FILTER (WHERE reflagged) AS second_review_reflagged,
       count(*) FILTER (WHERE reason_code LIKE 'repair_exhausted_fail_open%') AS fail_open,
       count(*) FILTER (WHERE final_decision = 'block') AS silenced
FROM hits GROUP BY 1 ORDER BY hits DESC LIMIT 20;
COMMIT;
```

排查优先级（不是按 hits 排，按杀伤×嫌疑排）：
1. `silenced > 0` 的规则——静默丢单，每条都值得看原文；
2. 复燃率（reflagged/hits）> 20% 的规则——假阳或 repair 失效；
3. hits 断崖式高于其他规则的——口径过宽嫌疑。

**立案前必须过存续期核验**（2026-08-20 首跑实战教训：榜首 `job_facts_without_any_lookup`
97 次命中，实为 8-11 已下线、随 v10.44.0 于 8-19 才部署的僵尸规则）：
- 对每条候选规则先 `grep -rn "<rule_id>" src/agent/guardrail`——查无此 id 即已删；
- 再按天分布对照最近发版日（`git tag` / releases）——命中在发版日归零的，属旧版遗产，
  只做"确认已终结"结论，禁止立为优化目标；
- 窗口横跨发版日时，报告必须按发版日分段陈述，当前结论只能基于发版后数据。

observe 档单独看（升档候选池）：

```sql
BEGIN; SET LOCAL statement_timeout = '25s';
SELECT unnest(first_rule_ids) AS rule_id, count(*) AS observe_hits
FROM guardrail_review_records
WHERE created_at >= now() - interval '7 days' AND first_decision = 'pass'
GROUP BY 1 ORDER BY observe_hits DESC LIMIT 12;
COMMIT;
```

### Step 4 — 高嫌疑规则抽样定性（本 skill 的核心价值）

对 Step 3 圈出的每条高嫌疑规则，抽最近 5 条读原文：

```sql
BEGIN; SET LOCAL statement_timeout = '25s';
SELECT trace_id, created_at, final_decision, coalesce(reason_code,'-') AS reason_code,
       left(user_message, 200) AS user_message,
       left(first_reply, 400) AS first_reply,
       left(coalesce(revised_reply,''), 400) AS revised_reply
FROM guardrail_review_records
WHERE created_at >= now() - interval '7 days'
  AND '<rule_id>' = ANY(first_blocked_rule_ids)
ORDER BY created_at DESC LIMIT 5;
COMMIT;
```

每条给出判定：真阳（首版确实违规）/ 假阳（首版没问题被误拦）/ 复燃假阳（修复版正确仍被拦）/ repair 无效（修复版仍违规）。**5 条里 ≥2 条假阳即可立案**，写进优化清单；样本不足下结论时明说"样本 N 条，置信度低"。

### Step 5 — 语义影子勘探（可选，只作线索）

```sql
BEGIN; SET LOCAL statement_timeout = '25s';
SELECT f->>'code' AS finding_code, count(*) AS n
FROM guardrail_review_records g,
     jsonb_array_elements(g.semantic_reviews) r,
     jsonb_array_elements(r->'findings') f
WHERE g.created_at >= now() - interval '7 days'
GROUP BY 1 ORDER BY n DESC LIMIT 12;
COMMIT;
```

只回答"哪些形状高频出现、值得孵化成硬规则或收资需求"，抽 3 条 findings 看 `evidenceQuote` 验形状。禁止把 shadow 命中数当效果或事故数报。

### Step 6 — 按天趋势（可选）

```sql
BEGIN; SET LOCAL statement_timeout = '25s';
SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
       count(*) FILTER (WHERE first_decision <> 'pass') AS enforce_hits,
       count(*) FILTER (WHERE final_decision = 'block') AS silenced,
       count(*) FILTER (WHERE reason_code LIKE 'repair_exhausted_fail_open%') AS fail_open
FROM guardrail_review_records
WHERE created_at >= now() - interval '7 days'
GROUP BY 1 ORDER BY 1;
COMMIT;
```

按天聚合**必须** `AT TIME ZONE 'Asia/Shanghai'`（默认 UTC 出过错报）。趋势解读前先对照 Step 1 的回合量——周末量跌导致的命中下降不是"守卫变好了"。

## 报告格式

```markdown
# 守卫效果分析 <日期>（窗口：<起>—<止>）

## 总览
回合 N，硬规则信号 N（enforce N / observe N），repair 一次成功 N，
fail-open N，静默 N。一句话定性。

## 优化清单（按优先级）
| # | 规则/簇 | 证据 | 建议动作 | 置信度 |
证据必须含数字 + 至少 1 个 trace_id；建议动作限于：
收窄口径（修 regex/加豁免）｜降档 observe｜升档 revise｜下线｜
改 repair 反馈（feedbackToGenerator）｜孵化新硬规则｜保持观察。

## 健康项（简短）
正面效果两三句带数字，不展开。

## 局限
样本量、窗口、未覆盖的维度，如实写。
```

## 已知坑与历史裁定（引用前先核对是否被推翻）

- **升降档治理条款**（output-rule-catalog.ts 头注）：新规则 observe 入场；升 revise 需 ≥2 周 observe + 抽标精确率 ≥90%；revise 档精确率 <70% 应自动降 observe。建议升降档时引用这个标准。
- **2026-07-10 用户裁定**批量下线 17+ 条规则（ungrounded_job_recommendation 等族）：**勿建议重加**，岗位/预约事实治理归语义档。
- 精度快照会过期：0721 快照已被 08-05 审计推翻。引用任何历史精度数字须带日期，与当期抽样冲突时以当期为准。
- `agent_execution_events` 工具调用漏采约 2/3，工具统计一律用 `mpr.tool_calls`。
- 已有三个定时审计在跑（`guardrail-accuracy-audit` 每 2 天、`daily-auto-scan-report`、`daily-badcase-triage`，均为 Claude scheduled task 而非 src/ 代码）；它们的报告是人工核对过的抽标，与本分析冲突时先怀疑自己的口径。
- 深挖单条对话的链路根因时切换到 `analyze-chat-badcases` skill，本 skill 只管守卫面。
- 治理体系全貌与各期审计结论见 `docs/architecture/guardrail-quality-system.md`。
