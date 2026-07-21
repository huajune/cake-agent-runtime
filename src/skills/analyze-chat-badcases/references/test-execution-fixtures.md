# 真实 Agent 测试 fixture 与评审规则

本文件用于 Step 6/9。目标是让 case 真正触发待验证的工具、守卫和历史来源，而不是只让模型看到一段事故描述。

## 1. 基础隔离

- 每条 `TestChatRequestDto` 都必须传唯一且稳定的 `userId / sessionId`。`userId` 缺失会直接失败；复用用户会引入长期画像污染。
- `message` 是当前决策时刻，`history` 截止到它之前。若 history 已包含同内容的当前 user turn，test-suite 会裁掉该 turn 之后的消息。
- 批次首次验证优先小规模串行或低并发。动态工具 case 不要一上来几十路全并发；如果并行结果出现无关品牌、城市或候选人字段，先用新 user/session 串行复跑，再检查 `agentRequest.messages / memorySnapshot / tool input`，不要仅凭相同词汇断言上下文串扰。

## 2. 真人经理历史

普通 assistant 历史默认按 `AI_REPLY` 处理。需要复现真人经理手动发送时，在历史消息上标记：

```json
{
  "role": "assistant",
  "content": "有一个月以上餐饮经验吗",
  "humanAgent": true
}
```

测试链路会把它作为 `MOBILE_PUSH + TEXT + isSelf=true` 传给 Runner 并写入聊天存储。只在真实人工消息上使用，不能为了诱导 `skip_reply` 把 Agent 历史伪装成真人。

断言：候选人只回答真人问题且无新诉求时应调用 `skip_reply`、`actualOutput` 为空；同时提出岗位、地址、改约等新诉求时不得静默。

## 3. 岗位、预约与身份守卫

“这个岗位”“之前看的岗位”这类文本不构成合法工具证据。凡是期望调用 `duliday_interview_precheck / booking / modify / cancel` 的 case，至少满足一种：

- 对话前序真实运行过 `duliday_job_list` 并保留返回 jobId；或
- 用 `memorySetup.presentedJobs / currentFocusJob` 注入仍有效的真实 jobId，并在 `memoryAssertions` 中要求该状态被保留。

同时按场景提供候选人亲口说过的姓名、电话、年龄等字段；禁止让模型从工具描述或示例补齐。若目标依赖岗位 screening 标签，必须使用本轮真实 job 工具结果或受控 fixture，不能只在 assistant 历史里声称“该岗位不要学生”。

身份追问上限 case 需要让 precheck 实际返回 `identityFieldGuard.mustHandoff=true`；只看最终回复“没有第三次追问”不够。拒后改口 case 需要检查 `verifyIdentityFlip=true` 或等价核实话术，并确认首次改口没有进入 booking。

## 4. 在途工单与防重复报名

`existingRegistrations / duplicateBookingGuard` 依赖手机号对应的真实或受控活跃工单。没有可控工单时，将 case 标成 `skipped / 测试资产不可评估`，不要把“系统没有返回工单”判成修复失败，也不要为了测试在生产创建报名。

断言至少包含：

- precheck 返回 `existingRegistrations`
- 同岗位存在 `duplicateBookingGuard`
- 本轮没有调用重复 booking
- 改约/取消只使用工具返回的真实工单号

## 5. 时间戳与直接历史

不要假设每个入口都会以相同形式给消息追加 `[消息发送时间：…]`。运行后检查 `agentRequest.messages` 或工具收到的 messages：

- 若目标是验证时间戳兼容，fixture 中必须能证明身份原话到达识别器时带时间戳；
- 单元测试或直接 mock 历史时显式保留时间戳后缀；
- debug/test-suite 若由存储层自动注入，也要在 trace 中确认后再宣称覆盖。

## 6. 静默与出站 block

空文本不自动等于失败，也不自动等于成功：

- `skip_reply`：应有该工具调用，`actualOutput` 为空。
- `meta_narration_reply`：若模型确实生成完整括号元旁白，应断言 `outputDecision=block`、`ruleId=meta_narration_reply`、`reasonCode=meta_narration_silenced`、零 repair/二审、无 `general_handoff` 副作用。
- 如果模型直接选择 `skip_reply`，只能说明 prompt 层避免了旁白；不能声称真实链路覆盖了 hard-rule block 分支。hard-rule 分支需另用可控 runner/guardrail 测试覆盖。

测试框架的 HTTP/runtime `status=success` 只代表链路完成。业务评审必须结合实际回复、工具调用、`outputDecision / guardrailTrace` 和 checkpoint。

## 7. 评审口径

评审前必须先展开完整执行证据：测试输入与历史、Agent 实际收到的当前预约信息/记忆上下文、`agent_response` steps、工具输入输出、`execution_trace` 和守卫终态。动态事实在本轮没有工具调用，不代表一定无依据；它可能来自已渲染的当前预约信息或受控记忆。反过来，推理文字声称“来自当前预约信息”也不能单独自证，必须能在执行上下文中找到对应字段。短路工具（如成功的 `request_handoff`）按工具契约允许 `actualOutput` 为空，不能自动判为回复不完整。

每条执行记录写入以下之一：

- `passed`：目标原子行为有可观察证据且符合预期。
- `failed`：fixture 有效，目标行为被明确违反；写清首次错误决策和证据。
- `skipped`：fixture 无法触发目标行为、动态数据不可控或证据不足；评论写“测试资产不可评估”及缺口。

报告同时给出：runtime 成功数、业务 passed/failed/skipped、以总 case 为分母的 Dashboard pass rate、剔除 skipped 后的可评估通过率。
