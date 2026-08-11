# 生产记忆数据质量基线（2026-08）

> 执行时间：2026-08-11 13:47–13:52（Asia/Shanghai）
> 生产状态：candidate-profile campaign 尚未发版，本报告是旧链路的发版前基线。
> 性质：全程只读；未修改 Supabase、Redis、环境开关或生产日志。

## 1. 执行摘要

| 度量                | 灯号 | 结论                                                                                                                                                                     |
| ------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A · 档案信封质量    | 🟢   | 50/50 Redis key 命中，49 份含 facts；581 个已填字段的 confidence/source/evidence 三元组覆盖率 100%。本批裸串 city、unknown/memory 档、非空 `preferences.brands` 均为 0。 |
| B · 可追溯复算率    | 🟡   | 581 个字段中 211 个 evidence 可确定性提取候选人摘录；其中 160 个能在同会话候选人原文中复算命中，命中率 75.8%。                                                           |
| C · medium 升档空档 | 🔴   | 排除 phone 后有 434 个 LLM medium 字段；101 个值可直接作原文探针，52 个命中候选人手打原文。占全部 medium 12.0%，占可探针值 51.5%。                                       |
| D · 垃圾值存量      | 🟢   | 37 个 high city 全在城市白名单内；纯数字姓名、占位手机号均为 0。                                                                                                         |
| E · 裁决拒因基线    | 🔴   | 7 天 600 个 `fact_adjudication` 事件、4,233 条 decision，全部处于 shadow；拒绝 809 条，name 拒绝率 153/514=29.8%。当前不具备无观察期直接翻 enforce 的数据条件。          |
| F · resume 判定分歧 | 🟡   | 当前生产容器日志内 0 条，但容器仅连续覆盖 92h23m，不足完整 7 天；不能据此删除 legacy 判据。                                                                              |
| G · 存储兼容存量    | 🟡   | 7 天 217 行 `visual_facts`，degraded=0；43 行含已砍旧 key。838 行 active_booking 中 145 行仍带死 key。运行时已静默兼容，但存量并非 0。                                   |

直接决策：收尾-8A 可立即删除转发空壳；收尾-8B 暂缓删除；收尾-8C 三处兼容代码继续保留并钉拆除判据。未翻 D4 或任何其他环境开关。

## 2. 取样与安全边界

- Supabase/Upstash MCP 在本会话不可用；改用仓库既有生产 DSN 与 Upstash REST 凭据直连，保持同等只读纪律。
- 所有 PostgreSQL 查询严格串行，均在 `BEGIN TRANSACTION READ ONLY` 内执行，并在同一事务中执行 `SET LOCAL statement_timeout = '8s'`；无查询超时。
- `message_processing_records` 只按 `received_at` 过滤，并用 MATERIALIZED 两段式取样；`chat_messages` 只按有索引的 `"timestamp"` 过滤。
- 从近 7 天活跃会话中取最新 50 个有效 `(corp_id,user_id,session_id)`。高流量使实际样本时间落在 2026-08-11 11:44–13:46（约 2 小时），因此适合作为当前热路径基线，不足以单独证明长尾旧存量已经清零。
- Redis 仅对这 50 个 `production:factsv2:{corpId}:{userId}:{sessionId}` 做严格串行 HGETALL，共 50 次；未使用 SCAN、pipeline 或任何写命令。
- 可追溯复算在生产库内通过 `EXISTS` 完成，只返回按字段聚合的命中数；聊天原文未导出到工作区或报告。
- 日志只做固定文本计数，不提取消息内容。容器启动于 `2026-08-07T09:29:23Z`，故 F 的有效覆盖止于审计时的 92h23m。

取样 SQL 的核心形态如下：

```sql
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '8s';

WITH recent_sessions AS MATERIALIZED (
  SELECT chat_id, user_id, max(received_at) AS last_received_at
  FROM message_processing_records
  WHERE received_at >= now() - interval '7 days'
  GROUP BY chat_id, user_id
  ORDER BY max(received_at) DESC
  LIMIT 200
), sessions_with_corp AS MATERIALIZED (
  SELECT recent.*,
    (SELECT org_id
     FROM chat_messages
     WHERE chat_id = recent.chat_id
       AND "timestamp" >= now() - interval '14 days'
       AND org_id IS NOT NULL
     ORDER BY "timestamp" DESC
     LIMIT 1) AS corp_id
  FROM recent_sessions AS recent
)
SELECT corp_id, user_id, chat_id AS session_id, last_received_at
FROM sessions_with_corp
WHERE corp_id IS NOT NULL
ORDER BY last_received_at DESC
LIMIT 50;

COMMIT;
```

## 3. A · 档案信封质量

### 3.1 总体覆盖

- 已填字段：581
- 信封形态：581/581（100%）
- confidence：581/581（100%）
- source：581/581（100%）
- evidence：581/581（100%）
- 三元组同时完整：581/581（100%）
- confidence 分布：medium 435（74.9%），high 146（25.1%）
- source 分布：llm 435（74.9%），rule 135（23.2%），derived 10（1.7%），tool 1（0.2%）

### 3.2 逐字段三元组覆盖

| 字段                                       | 已填数 | confidence/source/evidence 完整 |
| ------------------------------------------ | -----: | ------------------------------: |
| interview_info.name                        |     24 |                   24/24（100%） |
| interview_info.gender                      |     26 |                   26/26（100%） |
| interview_info.applied_store               |     23 |                   23/23（100%） |
| interview_info.applied_position            |     24 |                   24/24（100%） |
| interview_info.interview_time              |     24 |                   24/24（100%） |
| interview_info.education                   |     24 |                   24/24（100%） |
| interview_info.has_health_certificate      |     12 |                   12/12（100%） |
| interview_info.experience                  |     26 |                   26/26（100%） |
| interview_info.height                      |     21 |                   21/21（100%） |
| interview_info.weight                      |     21 |                   21/21（100%） |
| interview_info.household_register_province |     20 |                   20/20（100%） |
| interview_info.phone                       |      7 |                     7/7（100%） |
| interview_info.age                         |     11 |                   11/11（100%） |
| interview_info.is_student                  |      8 |                     8/8（100%） |
| interview_info.gender_source               |      5 |                     5/5（100%） |
| interview_info.upload_resume               |      1 |                     1/1（100%） |
| preferences.brand_ids                      |     41 |                   41/41（100%） |
| preferences.salary                         |     24 |                   24/24（100%） |
| preferences.schedule                       |     25 |                   25/25（100%） |
| preferences.city                           |     37 |                   37/37（100%） |
| preferences.district                       |     30 |                   30/30（100%） |
| preferences.labor_form                     |     26 |                   26/26（100%） |
| preferences.delayed_intent                 |     15 |                   15/15（100%） |
| preferences.short_term                     |     14 |                   14/14（100%） |
| preferences.open_position                  |     20 |                   20/20（100%） |
| preferences.schedule_constraint            |     13 |                   13/13（100%） |
| preferences.position                       |     10 |                   10/10（100%） |
| preferences.location                       |     16 |                   16/16（100%） |
| preferences.available_after                |      1 |                     1/1（100%） |
| preferences.time_windows                   |     32 |                   32/32（100%） |

### 3.3 旧形态存量

| 旧形态                                  |            样本命中 |
| --------------------------------------- | ------------------: |
| 裸字符串 `preferences.city`             |                   0 |
| 缺 source 的旧 CityFact 对象            |                   0 |
| confidence=`unknown` 或 source=`memory` | 0 个字段 / 0 个会话 |
| 非空 `preferences.brands`               |                   0 |

结论：热路径已完全信封化，但这 50 个样本集中在最新约 2 小时。收尾-8C 约定要求“A1 及后续复扫归零”，本轮只满足第一次扫描，三处读兼容不能立即删除。

## 4. B · 可追溯复算率

### 4.1 口径

仅把以下 evidence 视为可确定性复算：明确引号中的候选人摘录，或规则 evidence 标签中可无歧义剥出的原文/值。系统标签、聚合推理、geocode/城市证据码不进入分母。对摘录先做逐字匹配，再做仅去空白和标点的归一匹配；不做语义相似推断。

- evidence 字段存在：581/581
- 可提取候选人摘录：211/581（36.3%）
- 逐字命中：159/211（75.4%）
- 归一命中：160/211（75.8%）

| 字段                                       | 可复算摘录 | 命中 | 命中率 |
| ------------------------------------------ | ---------: | ---: | -----: |
| interview_info.age                         |          6 |    6 | 100.0% |
| interview_info.applied_position            |          7 |    5 |  71.4% |
| interview_info.applied_store               |          7 |    5 |  71.4% |
| interview_info.education                   |         10 |    5 |  50.0% |
| interview_info.experience                  |         10 |    7 |  70.0% |
| interview_info.gender                      |         11 |    6 |  54.5% |
| interview_info.has_health_certificate      |          4 |    3 |  75.0% |
| interview_info.height                      |          9 |    7 |  77.8% |
| interview_info.household_register_province |          7 |    4 |  57.1% |
| interview_info.interview_time              |          7 |    5 |  71.4% |
| interview_info.is_student                  |          1 |    0 |   0.0% |
| interview_info.name                        |          9 |    8 |  88.9% |
| interview_info.phone                       |          6 |    6 | 100.0% |
| interview_info.upload_resume               |          1 |    1 | 100.0% |
| interview_info.weight                      |          9 |    7 |  77.8% |
| preferences.available_after                |          1 |    0 |   0.0% |
| preferences.brand_ids                      |         22 |   18 |  81.8% |
| preferences.delayed_intent                 |          7 |    4 |  57.1% |
| preferences.district                       |          1 |    0 |   0.0% |
| preferences.labor_form                     |         20 |   18 |  90.0% |
| preferences.location                       |          3 |    2 |  66.7% |
| preferences.open_position                  |          7 |    5 |  71.4% |
| preferences.position                       |          6 |    5 |  83.3% |
| preferences.salary                         |          7 |    6 |  85.7% |
| preferences.schedule                       |         14 |   12 |  85.7% |
| preferences.schedule_constraint            |          6 |    3 |  50.0% |
| preferences.short_term                     |          4 |    4 | 100.0% |
| preferences.time_windows                   |          9 |    8 |  88.9% |

复算 SQL 在生产库内返回聚合值，不返回消息正文：

```sql
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '8s';

WITH probes AS MATERIALIZED (
  SELECT * FROM jsonb_to_recordset($1::jsonb)
    AS probe(id text, kind text, "chatId" text, field text, needle text)
), matches AS MATERIALIZED (
  SELECT probe.kind, probe.field,
    EXISTS (
      SELECT 1 FROM chat_messages AS message
      WHERE message.chat_id = probe."chatId"
        AND message."timestamp" >= now() - interval '7 days'
        AND message.role = 'user'
        AND position(<归一化 probe.needle> IN <归一化 message.content>) > 0
    ) AS matched
  FROM probes AS probe
)
SELECT kind, field, count(*), count(*) FILTER (WHERE matched)
FROM matches
GROUP BY kind, field;

ROLLBACK;
```

## 5. C · medium 升档空档率

口径：confidence=`medium` 且 source=`llm`，排除 phone；仅标量字符串/数字可直接作为原文探针。数组、布尔值和对象保留在总分母，但不强行转成可能误判的文本。

- LLM medium（排除 phone）：434
- 可直接探针：101
- 原文命中但仍为 medium：52
- 全部 medium 空档率：52/434=12.0%
- 可探针 medium 空档率：52/101=51.5%

| 字段                                       | 可探针 medium | 原文命中 | 空档率 |
| ------------------------------------------ | ------------: | -------: | -----: |
| interview_info.name                        |            18 |       16 |  88.9% |
| interview_info.gender                      |             7 |        5 |  71.4% |
| interview_info.age                         |             6 |        4 |  66.7% |
| interview_info.education                   |             4 |        2 |  50.0% |
| interview_info.has_health_certificate      |             5 |        3 |  60.0% |
| interview_info.household_register_province |             3 |        3 | 100.0% |
| interview_info.applied_position            |            10 |        4 |  40.0% |
| interview_info.applied_store               |            10 |        4 |  40.0% |
| interview_info.experience                  |             9 |        5 |  55.6% |
| interview_info.interview_time              |             9 |        0 |   0.0% |
| interview_info.height                      |             1 |        0 |   0.0% |
| interview_info.weight                      |             1 |        0 |   0.0% |
| preferences.labor_form                     |             6 |        2 |  33.3% |
| preferences.salary                         |             5 |        2 |  40.0% |
| preferences.schedule                       |             7 |        2 |  28.6% |

结论：Q2 不应做“所有 medium 一刀升 high”。优先验证 name、gender、age、education、health certificate、household province 这些有明确原文且升档收益直接影响重复收资的字段；phone 继续按既定医嘱锁定。

## 6. D · 垃圾值存量

| 检查项                               |           分母 | 命中 |
| ------------------------------------ | -------------: | ---: |
| high city 不在全国城市白名单         |             37 |    0 |
| 纯数字姓名                           |  24 个非空姓名 |    0 |
| 占位手机号（固定测试号或单数字重复） | 7 个非空手机号 |    0 |

结论：当前样本没有触发一次性档案清洗脚本的证据。继续依赖发版后的 admission/shape gate 防新增污染，并在 7 天复测扩大样本。

## 7. E · `fact_adjudication` 拒因基线

查询口径：`agent_execution_events.created_at >= now()-7 days` 且 `event_type='fact_adjudication'`，先 MATERIALIZED 事件集，再展开 `payload.decisions`。

- 事件：600
- decisions：4,233
- mode：shadow 4,233（100%）
- accepted：1,705（40.3%）
- superseded：1,719（40.6%）
- rejected：809（19.1%）
- name：514 条，其中 rejected 153 条，拒绝率 29.8%

| 拒因                  | 数量 | 占 rejected |
| --------------------- | ---: | ----------: |
| no_candidate_evidence |  640 |       79.1% |
| conflicting_evidence  |  122 |       15.1% |
| value_not_derivable   |   37 |        4.6% |
| quote_not_found       |   10 |        1.2% |

结论：D4 的主要问题不是 quote 丢失，而是旧裸值无法回溯到候选人证据。campaign 发版会改变 producer/账本链路，必须先跑满发版后 7 天分布对照，再决定是否从 shadow 翻 enforce；本任务不翻开关。

## 8. F · resume 判定分歧

生产日志固定文本：`[visual-fact] resume 判定分歧`。

- 当前容器启动：2026-08-07 17:29:23（Asia/Shanghai）
- 检查截止：2026-08-11 13:52:08（Asia/Shanghai）
- 有效覆盖：92h23m（3.85 天）
- 分歧计数：0

收尾-8B 决策：**保留 legacy 文本判据与 `legacyResume || sheetResume` 并跑路径**。0 条是正向信号，但未满足“完整 7 天为 0”的删除门槛；待容器连续日志满 7 天后复扫。若届时仍为 0，再同时删除 `image-description.service.ts` 与 `save-image-description.tool.ts` 的 legacy 分支；若非 0，保留并把分歧样本登记 badcase。

## 9. G · visual_facts 与 active_booking 存量

### 9.1 visual_facts

查询口径：`chat_messages."timestamp" >= now()-7 days AND visual_facts IS NOT NULL`。visual_facts 列上线不足 7 天，因此该窗口覆盖当前功能生命周期。

- 总行数：217
- degraded：0（0%）
- 含已砍 7 key 的行：43（19.8%）

| kind            | 行数 |  占比 |
| --------------- | ---: | ----: |
| other           |  116 | 53.5% |
| job_posting     |   60 | 27.6% |
| chat_screenshot |   23 | 10.6% |
| map_location    |   15 |  6.9% |
| resume          |    2 |  0.9% |
| certificate     |    1 |  0.5% |

| 已砍 key        | 出现次数 |
| --------------- | -------: |
| salary_text     |       29 |
| shift_text      |       28 |
| name            |       14 |
| age_range       |        9 |
| brand_id        |        5 |
| cert_type       |        1 |
| cert_issue_date |        1 |

旧 key 会被新代码的 finalize 白名单静默丢弃，当前没有行为清理必要。若要回收 JSONB 体积，应单列一次性数据迁移，不与运行时 campaign 混做。

### 9.2 active_booking

- 非空 active_booking：838 行
- 含 `interview_time/brand_name/store_name/job_name` 任一死 key：145 行（17.3%）

新代码已忽略这些键，线上行为不受影响。A1 严格只读，因此未做生产 UPDATE；如需物理清除，应单列可回滚 SQL 并在低峰执行。

## 10. 行动建议

1. **立即执行收尾-8A**：删除 message-parser 的两个 re-export，唯一运行时消费者改直连 resolution。
2. **收尾-8B 暂缓**：当前只有 3.85 天日志且分歧为 0；完整连续 7 天复扫为 0 后再删 legacy 路径。
3. **收尾-8C 保留并立碑**：本批三类旧形态为 0，但样本只覆盖最新约 2 小时；至少再做一次跨天/分层取样且仍为 0，才删除 city 三态、unknown/memory 信封和 brands 墓碑。
4. **D4 不翻开关**：发版后观察 7 天，重点比较 name 拒绝率和 `no_candidate_evidence` 占比。
5. **Q2 做窄字段试点**：先对可逐字复算的 name/gender/age/education/health certificate/household province 设计升档规则；phone 继续排除。
6. **不跑档案垃圾清洗**：D 指标均为 0，没有数据依据。
7. **存储物理清理另案**：43 行 visual 旧键与 145 行 active_booking 死键只影响存储体积，不影响运行时，避免把生产写操作混入本只读审计。

## 11. 发版后复测清单

- 发版满 24h：确认三元组覆盖率不低于 100% 基线，Redis parse error 不上升。
- 发版满 7 天：重跑 A–G，取样改为按天分层 50–100 会话，避免最新流量集中偏差。
- 比较 B：可复算 evidence 命中率是否高于 75.8%，可提取摘录覆盖是否高于 36.3%。
- 比较 C：身份字段 medium 原文命中空档是否显著下降；phone 单列且不得自动升档。
- 比较 E：name 拒绝率相对 29.8% 是否下降，`no_candidate_evidence` 相对 79.1% 是否下降。
- 重跑 F：必须取得连续完整 7 天日志；为 0 才执行收尾-8B 删除。
- 重跑三类旧形态：再次全部为 0 才执行收尾-8C 的物理删除。
- 复核 G：新 visual 行不得再产生 7 个已砍 key；新 active_booking 行不得再写四个死 key。
