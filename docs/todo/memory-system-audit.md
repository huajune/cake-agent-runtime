# 记忆系统盘点（四个月现状审计 · 2026-08-18）

> 方法：探索代理全库盘点（七维度，每条 file:line 证据）+ 主会话对承重结论抽查。
> 触发：收资表单状态机（BookingCollectionForm）落地在即，记忆的进货结构将变。
> 抽查状态：P4 无守卫路径与 legacySessionFactValue 活跃用途已由 0817 残留清理 §4.3
> 独立实证（交叉一致）；其余承重项待实施时逐条复核。

## 1. 核心发现

1. **写入漏斗健康**：进 Redis facts 只有 saveFacts 一个漏斗、4 个调用点；但
   **P4（test-suite fixture seed）无守卫**——裸 EntityExtractionResult 经裸值信封落成
   unknown/archive（与残留清理 §4.3 发现同源）。
2. **`extractAndSave` 469 行 / 20 道顺序门**——四个月补丁叠加的最重灾区；置信度语义
   散布 **9 处实现**；admission 8 道门全部是"防 LLM 跨轮重推凭空造值"的防线。
3. **零消费字段**：`preferences.brands`（已退役样板未拆）、`reasoning`（存了从不读）、
   procedural 的 fromStage/advancedAt/reason、checklist 的「健康证类型」死分支
   （SessionInterviewInfo/UserProfile 均无此键，恒 undefined）。
4. **preferences.city 六路写入、五处裁决点**——最大打架字段；gender 四路次之。
5. **long-term 画像与 interview_info 100% 重叠零独有字段**；程序化消费在生产被
   removeProfileOnlyCandidateFields 恒摘除，实际只撑三件事（跨会话口径/回访阶段兜底/
   披露话术）；writeFromBooking 不写血缘（与血缘判定不对称）。
6. **键结构全部是会话键，无 person 键**——中介多人会话六点混写链实锤
   （deepMerge 累积→守卫反向锁死首人身份→首写豁免放行→prefill 混值→复聊误判→
   **settlement 把混值固化进用户级长期画像跨会话传播**）。与铁证 B 完全对上。
7. **precheck 表单现场值永远回不到 Redis**（bookingCandidateFacts 是 turn-scoped 伪写入）
   ——正是「表单→记忆回写」要补的洞的代码级确认。
8. **风险点**：SessionFactsRedisContentSchema.safeParse 失败→整份会话状态归空，
   仅一条 warn 无告警接线（注释自标 P0）；long-term preference_facts 空对象不覆盖
   →候选人清空意向后长期意向永远清不掉。

## 2. 简化机会（S1-S10）

**随 BookingCollectionForm 批做（S1-S7）**：
- S1 退役 600+ 行"防跨轮重推造值"补丁族（applyExtractionProvenance 全部/首写丢弃/
  admission 六门/sanitizeInterviewName/标量扇出熔断/forceNull name+phone 分支）——
  写入公证一次后全部失去对象；
- S2 prefill 二元分裂（trusted vs hints）并入槽位状态；
- S3 session 层置信度四档降二档（表单办结值/软事实）；
- S4 saveFacts 拆口：deepMerge 累积语义只留 preferences 族；
- S5 事务字段族（applied_store/applied_position/interview_time + 三层配套补丁）退出
  sessionFacts，由表单接管；
- S6 city 六路收敛为单一裁决器+一次落盘；
- S7 long-term 三写入路收一（表单办结回写为唯一 high 上游，settlement 退回
  summary+preference 快照，补 booking 血缘）。

**随时可做（S8-S10 纯残留）**：删 reasoning 持久化；删 preferences.brands 样板
+（把 MemoryFixtureService.seed 改传 SessionFacts 后拆 legacySessionFactValue——
残留清理 §4.3 的前置条件即此）；删 健康证类型 死分支与 procedural 三个只写字段。

## 3. 需人工确认的不确定点（7 条，代理自报）

deepMerge×置信度守卫在对象值字段（delayed_intent/schedule_constraint/available_after）
上的交互疑似互相抵消；守卫遍历 prevGroup 缺键时 optional 字段不设防；生产存量
（legacy facts:*/unknown 档/零消费字段占用）未独立复核；applied_store 恒 fallback
依赖上游恒非空未追证；群聊路径是否走 onTurnStart 未验证；reasoning 是否被仓库外
SQL 消费未知；safeParse 归空路径生产触发率未知。

## 4. 处置结果（2026-08-19 执行，只记事实处置，不新增设计裁定）

### 已执行

| 项 | 处置 | 要点 |
|---|---|---|
| **S8** reasoning 持久化 | **已删** | 删前逐面核验：`buildLlmFactEvidence` 收下它却返回常量；`unwrapSessionFacts` 的四个下游（settlement / tool-context.builder / memory-block.formatter / context.service）零读点；**仓库外亦无消费**——`memory_snapshot.sessionFacts` 由 `flattenSessionFacts` 生成，只 collect interview_info 与 preferences 两组，reasoning 从没进过库，`extraction_accuracy_report_fn` 只读 `interview.name/phone/age/gender`；web/ 的 reasoning 命中全是 agent_invocation 的模型思考段；scripts/ 无消费。连带删掉「规则模式匹配参考线索」拼接（只喂 reasoning）。模型叙事仍留在 `EntityExtractionResult.reasoning`（提取提示词的反臆造装置），只是不进 Redis。 |
| **S9** preferences.brands 样板 | **已删**（含 LLM schema 与提示词） | 消费面 grep 全库：除 test-suite 夹具外全是注释与测试数据，零业务读点。⚠️ 含**提取提示词改动**：模型不再被要求填 brands（填了当场被折 null，纯 token 浪费且与 brand_intents 打架），提示词两处品牌名约束改挂 brand_intents.brand。 |
| **S9** legacySessionFactValue | **通用分支已拆，city 分支保留** | 拆除前置条件（saveFacts 入参收成 SessionFacts 单形态）本批一并完成：夹具改经 `toSessionFacts` 显式署名，**签名沿用原效果（unknown/archive），行为零变更**，只把 evidence 写成实话。P4 无守卫路径随之关闭。**city 的 CityFact / 裸字符串两条分支保留**——它们服务旧 Redis 记录，存量计数尚未复扫归零，删早了会让一条陈年记录的 pref.city 被逐字段校验静默丢掉，收益只有十行，不划算。 |
| **S10** 健康证类型死分支 | **已删** | `buildKnownFieldMap` 那一行两侧恒 undefined（Session/UserProfile 都没这个键），从写下那天起只产出 null。`buildEnumHintsForMissing` 的同名分支**不是**死码（该字段可由岗位补充项要求进 missingFields），保留。最后一个消费者随之消失的 `normalizeArrayText` 一并删除。 |
| **S10** procedural 三个只写字段 | **已删** | fromStage / advancedAt / reason：写它们、读回结构体，然后全库零消费（web/ 零命中、supabase/migrations 零命中、src/ 除夹具透传外零读点）。注释里"用于审计"没有兑现物——真实审计链在 advance_stage 的 logger 行、agent_execution_events、message_processing_records，以及工具**返回给模型**的 fromStage（那是返回值不是持久状态，保留）。旧 Redis 记录的三个键不再读出，存量随会话 TTL 自然过期。 |
| **风险点 8** 前半段「整份归空」 | **已失效，无需处置** | 描述已过时：PR #1000（303eff0d，2026-08-18）把整份 safeParse 改成了**逐字段校验**，整份归空这个形态现在不存在。 |
| **风险点 8** 后半段「只有一条 warn」 | **已接线** | 新事件类型 `session_state_field_dropped`（与 `extraction_field_dropped` 刻意分开：那条是模型抽的值没过准入门，这条是存量数据与 schema 对不上）+ 进 PersistingObserver 必落库白名单 + 飞书告警（自带节流）。事件只带 zod 字段路径与原因，**不带值本体**（PII 不进观测）。 |
| **风险点 8** 后半段「意向清不掉」 | **已钉死，未修**（用户裁定） | 三层闸门层层拒绝空覆盖：① long-term.service 双空早退 ② supabase.store 的 `length > 0` 判据 ③ RPC 的 `p_preference_facts != '{}'::jsonb`（20260707150000 迁移，已逐行核对）。已写 characterization test 描述缺陷现状；修复形态（三态墓碑 vs 放行空覆盖）待裁定。 |

### 未执行（原样保留）

- **S1-S7** 并入 BookingCollectionForm 接线批（蓝图 §7 退役清单扩容），本批不动；
- **person 键**（跨会话按手机号认人）记录在案，随 D1 candidateRef 落地后再评估是否
  升级为跨会话候选人档案，不在本批。

### 生产触发率核验（只读，限速）

`session_state_field_dropped` 在 `agent_execution_events` 30 天窗**零行**——事件此前不
存在，该指标**无法回溯测量**，这正是接线要消灭的盲区（同窗 extraction_field_dropped
5264 行可作量级参照）。直接查生产 Redis 未能完成：Upstash MCP 的管理密钥只够到测试库
（键面全是 `bull:local:*`、`bull:agent-test`，`factsv2:*` 零命中）。现有最近的证据是
残留清理 §4.3 的 0817 全量复扫（443 份生产 factsv2、13733 个字段槽位，全是信封或 null）
——与 facts 字段丢弃率极低相符，但不构成 terminal / brand_state 两个字段的结论。
发版后按本事件实测。
