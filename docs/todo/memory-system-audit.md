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

## 4. 处置建议

- S1-S7 并入 BookingCollectionForm 实施批（蓝图 §7 退役清单扩容）；
- S8-S10 可单独派工（小、独立、零行为风险——按残留清理同款纪律执行）;
- 风险点 8 的 safeParse 归空告警接线建议提为独立小修（观测不落库=没发生纪律）；
- person 键（跨会话按手机号认人）问题记录在案，随 D1 candidateRef 落地后再评估
  是否升级为跨会话候选人档案（不在本批）。
