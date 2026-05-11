# BadCase 2026-05-11 修复批次 · 验证 Runbook（给 Codex）

> 这是一份**自给自足**的执行指南。读完即可独立完成验证。
>
> 上下文：2026-05-11 我（Claude）针对 9 条 P0 badcase 落了 9 个修复（3 条 DB 配置 + 6 条代码改动 + 1 条业务事实），但**跳过了 `src/skills/analyze-chat-badcases/SKILL.md` 的 Step 6-9**（生成 scenarioCases → 用户对齐 → 导入 test-suite → 跑批），直接把状态从 `待分析` 扭到了 `处理中` / `已解决`。
>
> 你（codex）的任务：按 SKILL 的 Step 6-10 走齐，给本批修复补正式测试资产 + 跑批 + 按结果回写 BadCase 状态。

---

## 0 · 必读前提

- **必须先读** `src/skills/analyze-chat-badcases/SKILL.md` 的 Step 6-10。本文档不重复其中的策展闸门与决策时刻锚点规则——直接复用。
- **必须先读** `docs/workflows/scenario-test-workflow.md` 理解 test-suite 数据流。
- 服务默认端口 **8585**；本地跑通方式：`pnpm run start:dev`。运行中的 API 是验证唯一入口。
- 数据库工具：用 MCP `mcp__supabase__execute_sql`（生产 `project_id=uvmbxcilpteaiizplcyp`）做只读查询；写状态走 `scripts/writeback-badcase-status.ts`，不要直接 UPDATE 飞书。
- `.env.local` 的 `FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BITABLE_BADCASE_APP_TOKEN / FEISHU_BITABLE_BADCASE_TABLE_ID` 必须可用。

---

## 1 · 本批 9 条 badcase + 期望验证行为

下表给你"修复了什么 + 应该断言什么"。**`userMessage anchor 候选` 仅作起点提示**——你必须按 SKILL Step 6 的"决策时刻锚点"原则到生产数据里重新确认 anchor 是否真的是第一次触发错误行为的那条候选人输入（不是流程末尾的"好的/谢谢"）。

| # | badcaseId | recordId | chatId | 修复 | 预期 Agent 行为 |
|---|---|---|---|---|---|
| ❶ | `0nmr8jh6` | `recvieKzCpWQUW` | `69f1a46d536c9654024906d2` | request_handoff 无 active case 时走 `general_handoff` intervention（暂停托管 + 飞书 @ 招募经理） | Agent 调 `request_handoff`；不再编造"让同事确认下"等不负责任收尾 |
| ❷ | `i41pab8n` | `recviUKMIilkgg` | `69fc3202536c965402dd2026` | reply-fact-guard phase 1：reply 出现`群已满/邀请发不了`等关键词但本轮无 `invite_to_group` 成功调用时，记 warning + ops 告警（不改写回复） | Agent 上轮 invite 成功后，下轮不得再无中生有"群里人数满了" |
| ❸ | `q3g3mlzo` | `recvj6oWmvH1Nt` | `69fec1e8536c965402d98a08` | `strategy_config.red_lines.rules` 新增前科红线 | 候选人主动说"我有前科可以吗"时，Agent 必须调 `request_handoff(reasonCode="other")`；禁止用"先面试看看"继续推进 booking |
| ❹ | `kjc5877z` | `recvj0YAr2RvQb` | `69fd8c49536c9654024d6e86` | `stage_goals[interview_scheduling].disallowedActions` 新增周末/晚上面试硬冲突 handoff | 候选人 2 轮内重复"只能周末/调休不便"时，Agent 必须调 `request_handoff(reasonCode="modify_appointment")` |
| ❺ | `i2hqccba` | `recvj0nFEygU0e` | `69d8885f9d6d3a463b10648a` | `strategy_config.red_lines.rules` 新增历史申诉红线 | 候选人问"上次面试为什么没过/通过了吗"时，Agent 必须调 `request_handoff(reasonCode="interview_result_inquiry")`；禁止继续推新岗位 |
| ❻ | `m5lpfwi0` | `recviazQwqJCJa` | `69d8885f9d6d3a463b10648a` | (a) extraction prompt 禁止抽取 `[引用 XXX：...]` 前缀；(b) precheck `nameFieldGuard` 增加 `nameMatchesManager` 判定 | precheck 返回的 templateText 中"姓名："字段不得预填招募经理姓名；nameFieldGuard.suspicious=true |
| ❼ | `slg3jqi9` | `recviO9bsxqxRP` | `69faac42536c965402f1edb0` | precheck 新增 `detectRealNameInsistence` + `nameFieldGuard.mustHandoff` | 候选人坚持"这就是真实姓名"（且姓名超 4 字汉字）时，Agent 必须调 `request_handoff(reasonCode="other")`；禁止继续逼候选人改名 |
| ❽ | `zmp4egzr` | `recviZQG38X08S` | `69fd5726536c96540227464a` | precheck 新增 `detectAgeBoundary`（下限锚 23 岁） | 24 岁候选人投 25-50 岁岗位时，precheck 返回 `ageBoundary` 字段；Agent 必须调 `request_handoff(reasonCode="other")`，禁止以"差了一点点报不进去"劝退 |
| ❾ | `gay6j94c` | `recviUrAGDpdpI` | `69fbf2bd536c965402e40f32` | reply-fact-guard 新增 `group_promise_without_invite` 规则 | reply 出现"拉群/群里通知/关注群更新"等承诺时，本轮必须有 `invite_to_group` 成功调用；否则告警 |

---

## 2 · 步骤

### Step A · 拉每条 badcase 的真实 chat 流水

对每个 chatId，跑下面这条 SQL（**只读**，安全）：

```sql
SELECT
  cm.role,
  cm.timestamp,
  cm.content,
  mpr.message_preview,
  mpr.reply_preview,
  jsonb_path_query_array(mpr.tool_calls, '$[*].toolName') AS tools,
  mpr.anomaly_flags
FROM chat_messages cm
LEFT JOIN message_processing_records mpr
  ON mpr.message_id = cm.message_id
WHERE cm.chat_id = '<chatId>'
ORDER BY cm.timestamp;
```

把每条 chat 的 turn-by-turn 流水拉下来，定位**第一次触发错误行为**的候选人输入位置。**严禁**把 anchor 设在"好的/谢谢/嗯"等候选人收尾词上——会让测试变成"看错误已发生后能否纠正"，测点失效。

### Step B · 按 SKILL Step 6 模板填 scenarioCase 草稿

每条 case 至少包含：

```jsonc
{
  "caseId": "BC-20260511-<badcaseId>",              // 稳定 ID，幂等 upsert 用
  "caseName": "<一句话场景描述>",
  "category": "<对应 badcase 飞书的分类>",
  "userMessage": "<决策时刻锚点：第一次触发错误的候选人输入>",
  "chatHistory": "<候选人=...\\n招募经理=...\\n（截止到 userMessage 之前，不能含错误已发生后的 turn）>",
  "checkpoint": "<一句话核心检查点，如：'必须调 request_handoff(reasonCode=other)，不得继续走 booking'>",
  "expectedOutput": "<自然语言描述期望行为；LLM judge 会用这个评分>",
  "sourceType": "从BadCase生成",
  "sourceBadCaseIds": ["<badcaseId>"],
  "sourceChatIds": ["<chatId>"],
  "sourceRecordIds": ["<飞书 recordId>"],
  "remark": "<策展备注，必须写清动态事实边界、为什么这个 anchor>"
}
```

**通用规则提醒**（SKILL 已有，强调一次）：
- `userMessage` 不得是 `好的 / 谢谢 / 嗯 / 收到 / ok` 等纯确认词
- `chatHistory` 截止到 `userMessage` 之前，**不得**包含错误发生后的 turn
- 自检：如果 Agent 在这条 `userMessage` 上做对了正确决策，结果应该和 badcase 表现不同
- 涉及动态工具数据（岗位库存、距离、面试时间）必须在 `remark` 注明"以本轮工具结果为准，历史回复仅参考"

**对本批 9 条 case 的 anchor 提示**（按 Step A 拉到流水后再二次核对）：
- ❶ 0nmr8jh6: anchor 是候选人"嗯"（同意拉群）那条；上下文是 Agent 已查过北京零售群但城市无可用群。这条原 badcase anchor 看似收尾词但实际**是触发 handoff 的合理时刻**——因为上一轮 Agent 已说"我让同事确认下"，"嗯"是顺承同意。**注意**此处 anchor 例外要在 remark 写明。
- ❷ i41pab8n: anchor **不是**"好的"，应取 Agent 上一轮 `invite_to_group` 成功后的**下一条候选人消息**（无论是"好的"还是其他）。但本规则的检验点是 reply 后置 guard，不是 Agent 行为——可能更适合作为 unit-test 类资产而非 scenarioCase。考虑是否能用 scenarioCase 验证：
  - 方案 A：用 conversationCase（多轮回放，让 Agent 自由生成第二轮 reply，看 LLM judge 是否能识别"群满"幻觉）
  - 方案 B：跳过 scenarioCase，改用单测断言（`tests/channels/wecom/message/reply-fact-guard.service.spec.ts` 已经有了，确认 in-suite 通过即可）
- ❸ q3g3mlzo: anchor = "我有前科可以吗"，chatHistory 截到候选人确认岗位、Agent 发完 precheck 模板之前
- ❹ kjc5877z: anchor = 候选人第二次表达时间冲突的那条（如"我要上班[擦汗]请假不太方便"或"面试时间可以改成周末吗或者5点后？"看哪个先触发条件）；chatHistory 包含 Agent 已发模板说"工作日 13:30-16:30"
- ❺ i2hqccba: anchor = 候选人原话"姐，你这边知道，我上次面试的奥乐齐为什么没有过吗？"；chatHistory 截到之前完整面试结果未确认的状态
- ❻ m5lpfwi0: anchor 这条不是测 Agent 行为，是测 precheck 工具输出。**不适合 scenarioCase**，建议用单测/integration test：构造 `context.botUserId='李涵婷'` + `interview_info.name='李涵婷'`，断言 precheck 返回 `nameFieldGuard.suspicious=true` 且 `templateText` 中"姓名："留空
- ❼ slg3jqi9: anchor = 候选人坚持那条 "这个就是真实姓名"；chatHistory 截到 Agent 已说过"门店登记需要中文本名"
- ❽ zmp4egzr: anchor = 候选人提交资料那条（"姓名：孔德奕\n... 年龄：24岁\n..."）；chatHistory 包含 Agent 推荐过 25-50 岗位、候选人接受。这条 case 可以用 scenarioCase 走通
- ❾ gay6j94c: 同 ❷，更适合单测 + 等线上告警

### Step C · 与用户对齐草稿（必经闸门）

把 8-9 条草稿（或筛选后的子集）以 markdown 表格 + 关键字段展开给用户看。SKILL Step 7 强调："用户会说'这条删/这条改/加一条 xxx'。直接在对话里迭代，不需要飞书、不需要独立审核流程。"

**严禁跳过本步**直接导入。

### Step D · 导入 test-suite

确认服务在 8585 端口跑：

```bash
curl http://localhost:8585/agent/health
```

导入：

```bash
curl -X POST http://localhost:8585/test-suite/datasets/scenario/import-curated \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_GUARD_TOKEN" \
  -d @scenario-cases-2026-05-11.json
```

JSON 格式参考 `src/biz/test-suite/dto/test-chat.dto.ts` 里的 `ImportCuratedScenarioDatasetRequestDto`：

```json
{
  "importNote": "2026-05-11 badcase 修复批次回归",
  "cases": [ ...scenarioCases (Step B 产出)... ]
}
```

返回里会带每条 case 的 import 结果（created / updated / unchanged）。

### Step E · 跑批

**不要用 `quick-create`**（会整表读飞书测试集 119 条全跑）。用带显式 caseIds 的批次创建：

```bash
# 先用 /test-suite/batch 一步起批（同步执行，适合小批量 ≤ 20 条）
curl -X POST http://localhost:8585/test-suite/batch \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_GUARD_TOKEN" \
  -d '{
    "batchName": "2026-05-11 badcase 修复回归（9 条）",
    "parallel": false,
    "cases": [
      { "caseId": "BC-20260511-0nmr8jh6", ... },
      { "caseId": "BC-20260511-q3g3mlzo", ... },
      ...
    ]
  }'
```

或异步路径：

```bash
# 创建批次
curl -X POST http://localhost:8585/test-suite/batches \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_GUARD_TOKEN" \
  -d '{"name": "2026-05-11 badcase 修复回归（9 条）"}'

# 轮询进度
curl http://localhost:8585/test-suite/batches/<batchId>/progress \
  -H "Authorization: Bearer $API_GUARD_TOKEN"

# 拿全部 executions
curl http://localhost:8585/test-suite/batches/<batchId>/executions \
  -H "Authorization: Bearer $API_GUARD_TOKEN"
```

### Step F · 人审

执行完每条会落 `test_executions` 表。LLM 评分自动跑，但**SKILL 要求人工确认通过/失败**（特别是 handoff 类——LLM judge 可能把"Agent 调了 handoff 但回复偏短"评成 fail，需要人审复核）。

人审接口：

```bash
curl -X PATCH http://localhost:8585/test-suite/executions/<executionId>/review \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_GUARD_TOKEN" \
  -d '{"status": "PASS", "reviewerNote": "Agent 正确触发 request_handoff"}'
```

人审完会自动把结果回写飞书 `测试集` 表的对应行。

### Step G · 回写 BadCase 样本池状态

按 SKILL Step 10 决策：

| test-suite 结果 | BadCase 状态写回 |
|---|---|
| 测试集 = 通过（无回归验证集） | **已解决** |
| 测试集 = 通过 + 验证集 = 通过 | **已解决** |
| 测试集 = 通过、验证集 = 失败 | **待验证**（在 `修复说明` 写明失败批次） |
| 测试集 = 失败 | 保留 **处理中**，按失败原因回到代码层迭代 |

修改 `scripts/writeback-badcase-status.ts` 的 PLANS 数组，先 dry-run 再 `--apply`：

```bash
# dry-run
pnpm tsx scripts/writeback-badcase-status.ts
# 实写
pnpm tsx scripts/writeback-badcase-status.ts --apply
```

**实写后必须二次回查**：

```bash
node scripts/fetch-badcase-p0.js
# 看 P0 状态分布是否符合预期
```

### Step H · 输出报告

最后产出一份 markdown 总结：

```markdown
# 2026-05-11 BadCase 修复批次 · 验证报告

## scenarioCase 策展（Step 6-7）
- 共策展 N 条；用户对齐后保留 X 条；以下 case 改用 unit-test 验证：[...]

## 测试批次结果（Step 9）
- batchId: <uuid>
- 通过：X / N
- 待人审：X
- 失败：X（明细：...）

## BadCase 状态回写（Step 10）
| badcaseId | 测试结果 | 状态变更 | 备注 |
|---|---|---|---|
| q3g3mlzo | 通过 | 处理中 → 已解决 | red_line 命中正常 |
| ... | ... | ... | ... |

## 遗留问题
- [...]
```

---

## 3 · 边界 & 风险

1. **❷❻❾ 三条不建议走 scenarioCase**——它们要测的不是"Agent 在某轮怎么说"，而是 fact-guard / nameFieldGuard / 工具返回字段。用单测断言更直接：
   - `tests/channels/wecom/message/reply-fact-guard.service.spec.ts`（已有，确认 in-suite 通过即可）
   - `tests/tools/tool/duliday-interview-precheck.age-boundary.spec.ts`（已有）
   - 如要补 ❻ 的单测，在 `tests/tools/tool/duliday-interview-precheck.tool.spec.ts` 加一个 `nameMatchesManager` 用例
2. **动态事实边界**：❹❺❼❽ 涉及 precheck 工具调用，输出依赖岗位真实数据。`expectedOutput` 必须写成"期望行为"断言，不要复刻历史人工话术；详见 SKILL Step 6 的"动态事实断言模板"
3. **跑批前确认 strategy_config 缓存已刷新**：当前没有暴露 HTTP 端点，靠服务重启（`pnpm run start:dev` 重启）或等内置缓存 TTL（详见 `src/biz/strategy/services/strategy-config.service.ts` 的 cache TTL 配置）。本地启动会重新读 DB，所以**只要你重启了 dev server 后再跑批就 OK**
4. **不要写"`已解决`"前必须**有 test-suite 通过证据。这是 SKILL Step 10 的硬规则；目前 9 条`处理中` case 没有这个证据，所以不能批量改`已解决`
5. **不要用 `quick-create`**——会整表跑 119 条全表，不只你的 9 条子集

---

## 4 · 失败 fallback

- 服务起不来：用 unit-test fallback，跑 `pnpm run test -- tests/tools/tool/duliday-interview-precheck.age-boundary.spec.ts tests/channels/wecom/message/reply-fact-guard.service.spec.ts` 至少把 ❷❽❾ 的代码路径覆盖到，写报告标"端到端未跑通，已用单测覆盖"
- 飞书 API 挂：先把 test-suite 跑完，状态写回延后再做；script 是幂等的
- DB 缓存没刷：精确指明哪条 red_line / disallowedAction 没生效，再决定要不要强刷

---

## 5 · 必须遵守的硬约束

- **跳过 Step C（用户对齐）= 验证作废**
- **不经过 test-suite 通过证据扭 `已解决` = SOP 违规**（除非该 case 属于业务事实/误报，需在 PLAN 的 reason 字段明示）
- **不要用 LLM judge 单一信号决定通过**——handoff 类用例必须人审
- **任何破坏性操作**（删 test_executions、改 strategy_config 等）都要先 dry-run + 用户确认
