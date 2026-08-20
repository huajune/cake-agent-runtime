# 复聊二期：三个既有场景的优化（面试提醒 / 面试后回访 / 推店未回）

> 状态：方案设计稿，待评审。本文档是复聊二期三项优化的**权威承接文档**（对齐 0804/0820「拉群时机簇」裁定中"归复聊专项承接"的口径）。
> 日期：2026-08-20
> 定位：二期**不新增场景**，是对一期三个既有场景的优化——面试提醒加"前 2 天确认"档、面试后回访延伸"通过后入职跟进"阶段、推店未回升级"扩面后拉群收口"档。运营需求稿中的"场景八/九/十"编号仅作需求溯源，代码与 Dashboard 均不引入新场景叙事。
> 前置阅读：[docs/product/reengagement.md](../product/reengagement.md)（一期产品口径）、[docs/architecture/reengagement-pipeline.md](../architecture/reengagement-pipeline.md)（一期技术底盘）、[docs/product/invite-to-group.md](../product/invite-to-group.md)（拉群产品设计）。

---

## 0. 需求原文与场景归属

| 需求稿编号 | 归属既有场景 | 优化内容 |
| ---------- | ------------ | -------- |
| 场景八 | `interview_reminder` 面试提醒 | 报名距面试 ≥3 天时，面试前 2 天加一档"意向确认 + 提前提醒"，降临场爽约 |
| 场景九 | `post_interview_followup` 面试后回访 | 回访不止步于问结果：面试通过后第 3 天跟进入职，未入职转人工 |
| 场景十 | `store_presented_no_reply` 推店未回 | 已扩大意向范围（第 ≥2 轮推店）仍未回时，触达升级为"问兴趣 + 直接拉群收口" |

### 面试提醒 · 前 2 天确认档

- 触发条件：报名日期和面试日期相差 >= 3 天，面试前 2 天提醒（例：7.21 报名、7.24 面试，7.22 提醒）。
- 跟进策略：确认求职意向是否仍在，顺带提醒面试安排，降低临场爽约率。

| 编号 | 话术模板 |
| ---- | -------- |
| A | 哈喽～想确认一下你还在找兼职吗？周五【x 点】约了面试在【XXX】，如果时间不合适可以提前跟我说调整～还在找的话记得准时来哦！ |
| B | 你好呀～之前约了周五【x 点】的面试，还在找工作吗？如果已经找到合适的了跟我说一声就行，还没找到的话周五面试别忘啦～地址【XXX】，到了联系我～ |
| C | 在不在呀～你还在看工作吗周五下午 x 点约了面试别忘了哈，在 xxx 那边 |
| D | 哈喽，还在找工作不之前约了周五 x 点的面试，时间 ok 的吧？地址是 xxx |

### 面试后回访 · 入职跟进阶段

- 触发条件：通过聊天信息明确知道用户面试通过后（工单状态可能滞后），隔 3 天进行入职跟进。如果没有入职要触发人工介入。
- 跟进策略：确认候选人是否正常入职，有没有遇到什么问题。
- 话术模板：A–D **均为空白，待运营提供**（真发前的硬依赖，见 §7 裁定项）。

### 推店未回 · 扩面拉群收口档

- 触发条件：已经试图扩大候选人意向范围但推店未回，需要主动触达时，拉用户进群。
- 跟进策略：先询问用户是不是对新推的岗位不感兴趣，不管对方回不回答，直接触发拉群。

---

## 1. 现状底盘与三条硬约束

一期链路：业务锚点（`ReengagementAnchorService`，由 `reply-workflow.service.ts` 在回合收尾调用）→ Bull delayed job（`FollowUpSchedulerService`，jobId 幂等）→ 到点核验（`FollowUpProcessor`：shouldStop / 真人介入闸 / 候选人待答闸 / 海绵工单实时核验 / 冷却频控）→ 独立生成（`ReengagementAgent.compose`，**物理无工具**）→ outbox 投递 + 触达底账。

三项优化都长在既有场景的既有机制上：

- 面试提醒确认档：完全复用 `booking.succeeded` 锚点 + `resolveBookingAtFire` 工单解析 + 改期替代重排 + 全套 post_booking 到点闸；只是同一场景多排一个变体任务。变体任务的先例已存在——`post_interview_followup` 的 AI 17:00 档就是用 anchor id 的 `:ai17` 版本后缀区分排程（`scenario-registry.ts:314`）。
- 回访入职跟进：权威事实源已就位——15min 轮询海绵 `interviewPassTime` 补记 `ops_events(interview.passed)`（`sponge-status-poll.cron.ts`，幂等键 `wo:pass`，事件自带 corpId/userId/chatId/botImId）；人工介入的告警链（`HandoffRecorderService` / `GeneralHandoffNotifierService` / `InterventionService`）都是可直接注入的 service。
- 推店未回拉群档：同锚点（`agent.store_presented`）、同延迟（30min）、同停止条件；差异只有触发资格（第 ≥2 轮）、生成口径、投递后副作用（invite）。群基础设施（`GroupResolverService` / `GroupMembershipService` / `RoomService.addMemberEnterprise`）齐备。

三条硬约束（探索实证，设计必须绕开或改造）：

1. **「面试通过」在对话侧零结构化表示**。唯一权威是海绵工单 `interviewPassTime`（`sponge.types.ts:519`）；聊天里只有 request_handoff reasonCode、风控关键词、当轮 guard 正则、复聊 LLM 自检四种一次性形式，全都不落盘不可复用。「是否已入职」同样没有事实源，只能现查工单 `currentStatus === '上岗成功'`（`candidate.hired` 事件无生产者）。
2. **既有停止闸把优化项的触发前提当作终局**：`shouldStop` 的 terminal / 已回话豁免只认 `anchorEvent === 'booking.succeeded'`（`scenario-registry.ts:425-447`）；`checkBookingInvalidAtFire` 把「面试成功」判为 `work_order_not_active` 停发（`follow-up.processor.ts:682`）。入职跟进必须泛化这两处。
3. **复聊 Agent 物理无工具**（`reengagement-pipeline.md` §5.1），拉群只能走 processor 确定性代码；而拉群编排目前锁在 `invite-to-group.tool.ts` 的 execute 闭包里（约 550 行），必须先抽 service。

---

## 2. 优化一：面试提醒加"前 2 天确认"档（同场景变体，不新增 code）

### 2.1 形态

`interview_reminder` 场景下同工单同面试时间存在两个任务：

| 档位 | 触达时点 | 资格 | 任务身份 |
| ---- | -------- | ---- | -------- |
| 确认档（新增） | 面试前 2 天（默认 2880 分钟，可配） | 报名距面试 ≥3 上海日历天 | `bookingFollowUpAnchorId(...)` + `:d2` 后缀（沿用 `:ai17` 版本后缀机制），payload 带 `touchVariant: 'd2_confirm'` |
| 到场档（既有） | 面试前 1 小时 | 不变 | 不变 |

两档**并存不互斥**：D-2 确认意向 + 前 1h 提醒到场正是需求意图。变体不新开场景 code——追溯页、频控、冷却、场景开关都归并在「面试提醒」名下。

### 2.2 排程

- `anchor.service.ts` 的 `scheduleBookingFollowUps` 不动（仍只排 resolution 任务）；确认档在 processor 的 `resolveBookingAtFire` 分支（`follow-up.processor.ts:217`）拿到实时工单后判定资格并追加排程：`shanghaiDayNumber(interviewAt) - shanghaiDayNumber(signUpAt) >= 3`（上海日历天，与需求"7.21 报名 / 7.24 面试 / 7.22 提醒"的按日期口径一致）。报名时间取工单 `signUpTime`（`booking-context.ts:79` 已带；OOB 手工单/改约场景下比 anchorAt 可信）。不满足 → `trackScheduleSkipped(identity, 'signup_interview_gap_lt_3d')`。
- 触达时点计算复用 `resolveDelayMs` 的 `before_interview` + `configuredDelayMinutes` 通道：确认档偏移从 `reengagementScenarioDelayMinutes['interview_reminder:d2']` 读（缺省 2880）——既有 `Record<string, number>` 直接放子键，**零配置 schema 变更**。
- 改约：既有替代任务机制按新时间重排两档；确认档重排时**重新判定 gap**，改近到 <3 天则只保留到场档。

### 2.3 到点核验

确认档复用全套 post_booking 闸（工单 active 核验、时间变化补排、真人介入闸、待答闸、频控、`sessionCooldownExempt`），追加两条：

- `interviewAt - now < 24h` → `stopped: interview_too_close`。解析迟到或改约改近时，贴脸确认没有价值且与到场档叠发；24h 内交给到场档覆盖。
- 到点重算 gap（工单 `signUpTime` vs 实时 `interviewAt`）不满足 → `stopped: signup_interview_gap_lt_3d`。

### 2.4 生成

- `reengagement.agent.ts` 按 `touchVariant` 分支（顺手把 `isPostBookingScenario` 等三处 code 硬编码改为按 `scenario.phase` 判定）。
- 确认档 generationPolicy（对齐话术 A–D 精神，不逐字模板化——复聊生成以当次核验事实为准）：
  - 先轻量确认还在找工作/求职意向仍在，再顺带提醒已约的面试时间与地点；
  - 明确给出改期出口（"时间不合适可以提前跟我说调整"）与放弃出口（"已经找到合适的了跟我说一声就行"）；
  - 线下面试才提地址；AI/线上面试按既有面试提醒口径；工单未提供的信息只做中性提醒；不施压、不声称已读。
- 状态摘要为确认档补**面试日期带星期几**（`formatShanghaiDateWithWeekday`），支撑"周五 x 点"表达；时间口径沿用「聊天约定优先于工单窗口起点」既有裁定。
- **两档互认口径必须显式声明**：到场档的 `interview_reminder_already_sent` 停止条件要豁免确认档消息（"面试前 2 天的意向确认不构成已提醒"），否则确认档一发、到场档必被 LLM 判重跳过；确认档自身加 `confirmation_already_sent`（报名当轮之后已另行发过同类确认则 skip）。

### 2.5 灰度

`resolveRolloutEnabled` 增加变体子键判定：确认档由 `reengagementScenarioRollout['interview_reminder:d2']` 独立控制（缺省 **false**，先 shadow），到场档维持既有开关不受影响。同一 `Record<string, boolean>` 放子键，零 schema 变更。

### 2.6 已知取舍

- 确认档钟点 = `interviewAt - 48h`，随面试钟点走（面试多在日间，落点基本合理）；若产品要求固定钟点（如 D-2 上午 10 点），改用 `shanghaiHourOnInterviewDay(interviewAt - 2*DAY, 10)` 即可，见 §7 裁定项。
- 一期遗留的 9–21 点统一静默窗口仍未实现（`reengagement.md` §13.1），本档不单独实现，风险同一期。

---

## 3. 优化二：面试后回访延伸"入职跟进"阶段

回访场景的既有档在面试后 2 小时（AI 面试当天 17:00）问结果；本次延伸：结果为**通过**后第 3 天跟进入职，未入职转人工。

### 3.1 事实源裁定：工单轨为主，聊天轨列为二阶段

需求写"通过聊天信息明确知道面试通过（工单状态可能滞后）"。实证结论：

- 工单轨已有现成设施：15min 轮询把 `interviewPassTime` 非空补记为 `interview.passed` 事件（幂等、带完整会话身份）。滞后 = 海绵录入延迟 + ≤15min 轮询周期。**跟进本身是 D+3 触发，15 分钟级滞后没有实际影响**；真正的风险是海绵录入本身晚几天，这一点聊天轨同样无法系统性解决（候选人不一定在聊天里说）。
- 聊天轨在系统里零结构化表示，要新增会话事实字段 + 回合收尾确定性检测；而"疑问句记成事实""条件式改口"两类误判在收资域有成簇 badcase 前科，误触发的代价是骚扰 + 错误人工介入。

**方案：一阶段只做工单轨**；聊天轨（新增 `chat.interview_passed_reported` 信号）列为二阶段，等一阶段 shadow 数据显示工单轨漏检/迟检占比后再裁定（§7）。

### 3.2 注册与排程

入职跟进档的锚点（`interview.passed`）与回访既有档（`booking.succeeded`）不同，registry 一条注册项只能挂一个锚点——**机制上需要家族内新增一条注册项**，但命名与展示都归入回访家族，不作为独立新场景叙事：

```ts
{
  code: 'post_interview_onboarding',
  phase: 'post_booking',                    // 受报名后大开关约束
  displayName: '面试后回访 · 入职跟进',
  anchorEvent: 'interview.passed',
  triggerDelayMs: 3 * DAY,                  // anchorAt = interviewPassTime
  delayMode: 'after_anchor',
  defaultDelayMinutes: 4320,
  defaultRolloutEnabled: false,
}
```

- **接线方式：复聊侧 cron sweep（不让 biz 反向 import agent）**。reengagement 模块新增 15min cron：查近 48h 的 `ops_events(interview.passed)`，逐条调 `scheduleFollowUp`，jobId = `${sessionId}:post_interview_onboarding:wo${workOrderId}:pass`——Bull 同 jobId 去重，扫描天然幂等。这与 pipeline 文档 §2「事件锚点为主，cron sweep 为辅」的既定形态一致，也避免在 `SpongeStatusPollService` 加跨域钩子。
- anchorAt = 事件 `occurred_at`（即 interviewPassTime），到点 = 通过后第 3 天；Dashboard 可调分钟偏移。

### 3.3 到点核验（本档专属有效性判定）

`checkBookingInvalidAtFire` 只认「约面待确认/约面成功」为有效，**对本档语义相反**，不能复用。processor 为 `anchorEvent === 'interview.passed'` 增加独立分支：现查工单（复用 `resolveReengagementBookingContext`，job 带 workOrderId），按 `currentStatus` 分派：

| 工单现状 | 动作 |
| -------- | ---- |
| `面试成功` | 正常触达：询问是否已顺利入职、有没有遇到问题 |
| `上岗成功` | `stopped: already_onboarded`，不触达 |
| `上岗失败` / `已离职` | 不触达，**直接触发人工介入**（§3.4） |
| 其余状态（被改回约面/取消） | `stopped: work_order_regressed` |

既有闸的泛化（硬约束 2）：

- `shouldStop` 的 terminal 豁免与已回话豁免：条件从 `anchorEvent === 'booking.succeeded'` 泛化为 `scenario.phase === 'post_booking'`（候选人面试通过后 3 天内几乎必然回过消息，不豁免则本档永不触发）。
- 真人介入闸 / 待答闸照常生效（真人已在跟入职时自动闭嘴，正确）。
- `oob-work-order.ts` 的「面试成功 30 天静默窗口」只挂 pre_booking，与本档无冲突，**不改**。

### 3.4 未入职 → 人工介入

需求「如果没有入职要触发人工介入」拆成两段确定性动作：

1. **D+3 触达时**工单已是 `上岗失败`：跳过触达，直接人工介入（`reason_code: onboarding_failed`）。
2. **D+3 触达后 +48h 复核任务**（第二个 delayed job，jobId `...:wo{id}:onboarding_check`）：到点现查工单——`上岗成功` → 结束；仍 `面试成功` → 人工介入（`reason_code: onboarding_follow_up_required`，候选人未确认入职、工单未推进，需要人跟）。

人工介入的实现形态：**推荐"告警不暂停"**——`HandoffRecorderService.record()`（落 `handoff_events` + `ops_events(handoff.triggered)`，reasonCode 为自由文本可直接扩新码）+ `GeneralHandoffNotifierService.notify()`（飞书卡片到对应负责人）。不走 `InterventionService.dispatch()` 的原因：dispatch 会 `pauseUser` 三天，而入职跟进恰恰需要 AI 保持可应答（候选人可能正要回"明天去报到"）；暂停托管应留给真人明确接管的场景。**此项列 §7 裁定**（若产品坚持标准介入链，改调 dispatch 一行即可）。

### 3.5 生成

- 话术模板空白：真发前必须由运营补齐（§7 blocker）；shadow 阶段可用起草的 generationPolicy 先跑：确认是否已顺利入职 / 有没有遇到问题 / 需要协助可以说；不得断言候选人已入职或未入职；不施压、不催报到。
- 语义停止条件：候选人已在聊天中明确说不去了/放弃入职 → skip（blockReason=candidate_abandoned_onboarding）；已明确说过已入职 → skip 并（可选）标记复核任务无需人工介入。

---

## 4. 优化三：推店未回升级"扩面后拉群收口"档（同场景变体，不新增 code）

对齐两条既有裁定：0804「无岗承接收口能力放到复聊链路统一设计」（本文即该专项）；0820 主链新口径「推荐上限 2 轮，连续不满意即转拉群承接」——本档是它在**复聊侧**的镜像：主链是"当轮决定拉群"，本档是"扩面推店后沉默 30 分钟的兜底收口"。

### 4.1 前置重构：拉群编排抽 `GroupInviteService`（PR-B，零行为变更）

`invite-to-group.tool.ts` 的 execute 闭包里，「选群（城市过滤 + 容量）→ 已在群预检 → 发邀请（含 errcode 语义与补拉 bot 重试）→ `saveInvitedGroup` → `recordGroupInvited`」这一整段（约 :478-660 及配套私有函数）抽为：

```ts
// biz/group-task/services/group-invite.service.ts（与 GroupResolver/GroupMembership 同居所）
async invite(input: {
  corpId; userId; sessionId; botImId; botUserId; contactWxid;
  city: string; industry?: string; turnKey: string;   // turnKey 进 group.invited 幂等键
}): Promise<{ success: boolean; groupName?: string; alreadyInGroup?: boolean; reason?: string }>
```

- 主链意图闸（`bookingSucceeded` 短路、`invite-city-gate`、`invite-timing-gate`——后者依赖回合账本，复聊侧不存在）**留在 tool 内**，service 只做纯编排；工具改薄壳。
- 抽取是纯搬家 + 注入改造，不改任何判定；用现有 tool 测试全量回归兜底。

### 4.2 触发资格：「已扩大意向范围」的确定性口径

系统内没有任何"扩大范围"的 marker（实证：grep 仅命中 prompt 文案与召回内部行为）。定义确定性代理口径，与 0820 主链"2 轮上限"对齐：

> **本会话第 ≥ 2 轮推店，且该轮推店后候选人未回。**

- 落地：`WeworkSessionState` 新增 `storePresentationRounds: number` 计数，与 `savePresentedJobs` 同点递增（`memory-lifecycle.service.ts:463` 回合收尾投影处；注意 `presentedJobs` 本身是合并去重的累计列表，无轮次信息，不能替代计数）。
- `anchor.service.ts` 推店锚点处（`handleDeliveredReplyAnchors` 两条路径 + `handleToolAnchors` 均汇到 `schedule('store_presented_no_reply', ...)`）：排程前读 state——`storePresentationRounds >= 1`（本轮是第 2+ 轮）时，同一场景任务的 payload 带上 `escalateToGroupInvite: true`。**不新增场景 code、不需要 supersede**：还是那条"推店未回"任务，只是升了档。
- 增强判定（可选二阶段）：叠加 `JobListQueryRecord.signature` 跨轮变化（换条件重查 = 真·扩面）收窄触发；一阶段先用轮次口径，shadow 数据说话。

### 4.3 行为编排：文案 → 投递成功 → 确定性拉群 → 收口

复聊 Agent 无工具是物理约束，**保持不变**；拉群是 processor 在投递成功后的确定性副作用：

```text
到点核验通过（既有推店未回全套闸不变）
  → ReengagementAgent 生成文案（escalate 档：承接新推岗位，问是否不感兴趣 + 预告拉群）
  → outbox 投递成功（markSent）
  → GroupInviteService.invite(city ← 会话事实意向城市)
  → 成功：saveInvitedGroup + ops_events(group.invited) + 触达底账补记 invite 结果
          + stopPendingJobsForSessionScenario 清掉本会话其余 pre_booking 在途任务（拉群即收口）
  → 失败：底账记 invite_failed:{reason}，不重试；群满走既有 sendGroupFullAlert 告警
```

- **不管候选人回不回答直接拉群** = 文案与邀请卡片同一次触达先后发出，不等待回复（需求原文口径）。
- 文案策略：询问是否对新推岗位不感兴趣 + 预告拉群（"我拉你进兼职群，有新岗位第一时间能看到"）。守卫口径兼容：只拦"已拉群"完成时态假宣称，预告式不拦（拉群两轮协议裁定）；且卡片紧随其后，预告即刻兑现。若 invite 失败，预告落空构成轻微空头承诺——列 §7 裁定（备选：文案不提群，卡片自解释）。
- shadow 语义：shadow 模式下**只生成文案、绝不 invite**（拉群是外部副作用，等价于"不投递"）。
- 灰度：升档行为由 `reengagementScenarioRollout['store_presented_no_reply:invite']` 子键独立控制（缺省 false）；子键关闭时第 ≥2 轮推店未回退回普通推店未回触达，主场景开关行为不变。

### 4.4 前置条件与降级

- 城市：从会话事实「意向城市」取（复聊 memory snapshot 已按 relevantFactLabels 注入同源事实）；无城市 → 跳过 invite（`invite_skipped:no_city`），文案照发。城市匹配复用 `normalizeCity` 宽松口径（invite 城市门过窄的既有修法方向）。
- 已在群（`GroupMembershipService` 实时预检）→ 跳过 invite 并 `saveInvitedGroup` 补记，后续不再升档。
- 真无岗（暑假工无库存类）暂不拉群的 0820 口径：本档前提是**发生过推店**（有岗被推），天然不落入"真无岗"分支，无需额外处理。

### 4.5 与既有停止条件的关系

- `store_presented_no_reply` 的「已拉群即停」（`scenario-registry.ts:431` + `anchor.service.ts:60`）与收口语义**同向**，不需要放开；已在群的候选人本场景（含升档）都不再触发。
- pre_booking 带外工单核验（oob）继续生效：带外约面/面试通过的候选人不会被拉群触达，正确。

---

## 5. 横切事项

- **类型与配置**：仅入职跟进档新增一个 registry code（`post_interview_onboarding`，归回访家族）；两个变体档用既有 rollout / delay-minutes map 的 `code:variant` 子键（`interview_reminder:d2`、`store_presented_no_reply:invite`），零配置 schema 变更。面试提醒确认档与入职跟进档均受 `reengagementPostBookingEnabled` 大开关约束。
- **Dashboard**：场景清单以后端 registry 为单一来源；入职跟进档自动出现（显示名已带"面试后回访 ·"前缀标明家族），`web/src/view/reengagement/list/constants.ts` 兜底文案补 1 行；两个变体档在追溯页归并于既有场景名下，经由 anchor_event_id 后缀 / payload 变体标记区分明细。
- **观测**：`reengagement_touch_records` 无 schema 变更；新增停止/跳过原因字面量：`signup_interview_gap_lt_3d` / `interview_too_close` / `already_onboarded` / `work_order_regressed` / `onboarding_intervention_dispatched` / `invite_failed:*` / `invite_skipped:no_city`。拉群结果必须落底账或 `ops_events`，不允许只打日志；人工介入落 `handoff_events`（新 reason_code）+ 飞书卡片。
- **文档**：`docs/product/reengagement.md` §5 三个场景小节各补"二期优化"段 + §9.3/9.4 状态字典补新原因；`docs/architecture/reengagement-pipeline.md` §3 注册表与变体机制更新；`docs/product/invite-to-group.md` 补"复聊触发来源"一节。
- **灰度**：三项优化全部缺省关闭（两个变体子键 + 入职跟进档 defaultRolloutEnabled=false），先 shadow，复用一期上线门槛（任务创建合理率 ≥95%、严格可用率 ≥85%、硬错误 0）与放量 SOP。推店拉群档的 shadow 评审要额外抽查"触发时机是否真的是扩面后的沉默"（资格判定质量），入职跟进档要额外抽查人工介入卡片的到达与处置。

---

## 6. 执行清单（详细版）

依赖关系：PR-A 独立先行；PR-B 是 PR-C 的前置；PR-D 独立（真发依赖运营话术，shadow 不依赖）。

### 6.0 通用约定（所有 PR 适用）

- [ ] 分支从 `develop` 拉，PR 目标 `develop`（仓库无 main）；连续合 PR 间隔 60–90 秒（发版 metadata 竞态）。
- [ ] 仓库多会话并发：commit 一律用 pathspec 限定本 PR 文件；工作树发现他人改动勿动。
- [ ] 本地环境：`nvm use 22.16.0`；单测 `pnpm run test tests/agent/reengagement --watchman=false`（不带 `--`）；合入前 `pnpm run lint:check` / `typecheck` / `test` 三件套全绿。
- [ ] **无 DB 迁移**：四个 PR 全部复用既有表（`reengagement_touch_records` / `ops_events` / `handoff_events`），新停止原因是自由文本列值；配置走既有 map 子键，无 `.env` 变更。
- [ ] 每个 PR 的 DoD：代码 + 测试 + 文档同步（product/architecture 两份）一个 PR 内闭环；观测新增值落库可查，不允许只打日志。

---

### PR-A 面试提醒 · 前 2 天确认档

**A1 注册表与工具函数 — `src/agent/reengagement/scenario-registry.ts`**

- [ ] `bookingFollowUpAnchorId(workOrderId, interviewAtMs, scenarioCode, interviewType?, variant?)`：增加 variant 参数，`interview_reminder` + `variant='d2_confirm'` 时追加 `:d2` 后缀（与 `:ai17` scheduleVersion 同机制）；既有调用不传 variant，存量任务 id 不变。
- [ ] `resolveRolloutEnabled(scenario, config, variant?)`：variant 存在时查 `reengagementScenarioRollout['interview_reminder:d2']`，**缺失回退 false**（变体默认关，不回退主场景开关）；报名后大开关叠加逻辑不变。
- [ ] `resolveDelayMs` / `computeFireAt`：支持按变体键 `reengagementScenarioDelayMinutes['interview_reminder:d2']` 取偏移（缺省 2880），`delayMode` 沿用 `before_interview`。

**A2 任务载荷 — `src/agent/reengagement/follow-up-scheduler.service.ts`**

- [ ] `FollowUpJob` / `ScheduleFollowUpInput` 增加 `touchVariant?: 'd2_confirm'`，`scheduleFollowUp` 透传进 payload（追溯经由 anchor_event_id 的 `:d2` 后缀区分，tracking identity 不扩字段）。

**A3 排程与到点 — `src/agent/reengagement/follow-up.processor.ts`**

- [ ] `resolveBookingAtFire` 分支（:217 起）：`scenarioCode === 'interview_reminder'` 时，在排到场档之后追加确认档资格判定——`shanghaiDayNumber(interviewAt) - shanghaiDayNumber(parseInterviewTimestamp(signUpTime)) >= 3`；满足则第二次 `scheduleFollowUp`（`:d2` anchor id + `touchVariant` + 变体延迟键）；不满足或 `signUpTime` 缺失/不可解析 → `trackScheduleSkipped(identity, 'signup_interview_gap_lt_3d')`（fail closed，不排）。
- [ ] ⚠️ **1.5 到点校准块（:341 起）必须按变体键重算 `expectedFireAt`**：现逻辑用 `reengagementScenarioDelayMinutes[scenario.code]`（=到场档 60 分钟）重算，确认档任务到点时会被误判 `interview_time_changed` 而自毁并撞回到场档 jobId。d2 任务一律用 `interview_reminder:d2` 键取偏移。
- [ ] `touchVariant === 'd2_confirm'` 的到点追加两个停止：`interviewAt - now < 24h` → `trackStopped('interview_too_close')`；gap 复检（实时工单 `signUpTime` vs `interviewAt`）不满足 → `trackStopped('signup_interview_gap_lt_3d')`。
- [ ] `scheduleTimeChangedReplacement`：替代任务透传 `touchVariant`，d2 替代任务按新时间 + 变体键重排并重判 gap（改近到 <3 天则不补排，只留到场档）。
- [ ] 灰度判定处（:413）对 d2 任务传 variant 给 `resolveRolloutEnabled`。

**A4 生成 — `src/agent/reengagement/reengagement.agent.ts`**

- [ ] `isPostBookingScenario`（:484）、`formatStateSummary`（:538）、日期附加逻辑（:673）三处 code 硬编码改按 `scenario.phase === 'post_booking'` + code/variant 细分（为 PR-D 铺路，本 PR 内零行为变更）。
- [ ] compose 上下文带 `touchVariant`；确认档状态摘要补面试日期星期几（`formatShanghaiDateWithWeekday`）。
- [ ] 确认档 generationPolicy（§2.4：意向确认 + 面试提醒 + 改期/放弃出口；线下才提地址；不施压不声称已读）；语义停止条件加 `confirmation_already_sent`。
- [ ] 到场档 prompt 的 `interview_reminder_already_sent` 判定口径补豁免句：「面试前 1–3 天发出的意向确认消息不构成已提醒」——否则确认档一发、到场档必被 LLM 判重跳过。

**A5 测试（tests/ 镜像 src/）**

- [ ] `tests/agent/reengagement/scenario-registry.spec.ts`：`:d2` 后缀生成与存量 id 不变；rollout 子键缺失回退 false；delay 子键缺省 2880。
- [ ] `tests/agent/reengagement/follow-up.processor.spec.ts`：gap≥3 排双档 / gap<3 只排到场档 / `signUpTime` 缺失不排确认档 / d2 到点 `expectedFireAt` 用变体键（不被误判改期）/ `interview_too_close` / gap 复检 / 改约替代重判 / 子键关闭 d2 只 shadow 且到场档不受影响。
- [ ] `tests/agent/reengagement/reengagement.agent.spec.ts`：确认档 prompt 含星期几 + 改期出口；到场档在历史含确认消息时不误 skip。
- [ ] 既有 `interview_reminder` 全部用例零改动回归。

**A6 文档**

- [ ] `docs/product/reengagement.md`：§5.5 补确认档（触发条件/评审重点/正常不发送情况），§9.3–9.4 补 `signup_interview_gap_lt_3d` / `interview_too_close`；场景表加一行档位说明。
- [ ] `docs/architecture/reengagement-pipeline.md` §3：变体机制（`:d2` 后缀 + `code:variant` 配置子键）。
- [ ] web 无需改（同场景 code）。

**A7 验证与灰度**

- [ ] 部署后 Supabase 抽查：`reengagement_touch_records` 中 `anchor_event_id LIKE '%:d2'` 的行出现 scheduled → shadow 流转，`fire_at` 落在面试前 2 天 ±容差。
- [ ] Dashboard 改一次 `interview_reminder:d2` 延迟分钟数，确认新排程即时生效。
- [ ] Shadow 样本覆盖：gap=3 边界、gap=2 不触发、改约改近、AI 面试、跨周末。
- [ ] 真发前置：§7 #6（触达钟点）裁定；开关 = `reengagementScenarioRollout['interview_reminder:d2'] = true`。

---

### PR-B 拉群编排抽 `GroupInviteService`（重构，零行为变更）

**B1 新文件 — `src/biz/group-task/services/group-invite.service.ts`**

- [ ] 从 `invite-to-group.tool.ts` execute 闭包（约 :478-660 + 文件内私有函数 `resolveCandidates` / `pickAvailableGroups` / `buildCitySnapshot` / `invokeAddMember` / `maybeAddChatBotToGroupAndRetryInvite`）搬入完整编排：`resolveGroups('兼职群', {forceRefresh})` → `normalizeCity` 城市过滤 → `listUserRooms` 在群实时预检 → 群人数刷新 → 候选排序/容量筛选 → 循环发邀请（errcode 语义：-9 已在群 / -10 群满 / -12 已发卡片）→ 补拉接客 bot 重试 → `saveInvitedGroup` → `recordGroupInvited`（幂等键 `${sessionId}:group:${groupName}:${turnKey}`）。
- [ ] 签名：`invite({corpId, userId, sessionId, botImId, botUserId, contactWxid, city, industry?, turnKey}): Promise<{success, groupName?, alreadyInGroup?, reason?}>`；DI：GroupResolver / GroupMembership / RoomService / MemoryService / OpsEventsRecorder / OpsNotifier / ConfigService（enterprise token）。
- [ ] `group-task.module.ts` providers + exports 登记。

**B2 工具薄壳化 — `src/tools/invite-to-group.tool.ts`**

- [ ] 意图闸留在 tool：`bookingSucceeded` 短路、`resolveCityFromDistrict`、`invite-city-gate`、`invite-timing-gate`（依赖回合账本，复聊侧不存在，不得下沉进 service）。
- [ ] 编排改调 service；**tool 对 LLM 的返回结构与文案一字不动**（零行为变更的判据）。

**B3 测试**

- [ ] 新 `tests/biz/group-task/services/group-invite.service.spec.ts`：成功路径 / -10 群满 + `sendGroupFullAlert` / -9 已在群补记 / -12 已发卡片语义 / 补拉 bot 重试 / 无候选群 / `saveInvitedGroup` + `group.invited` 落库断言。
- [ ] `tests/tools/tool/invite-to-group.tool.spec.ts` 全量回归：断言零改动（只允许 mock 注入方式调整）。

**B4 验证**

- [ ] 合入后主链拉群指标观察 1–2 天（`ops_events(group.invited)` 日量与 errcode 分布不变）。

---

### PR-C 推店未回 · 扩面拉群收口档（依赖 PR-B）

**C1 会话状态 — 推店轮次计数**

- [ ] `src/memory/types/session-facts.types.ts`：`WeworkSessionState.storePresentationRounds?: number`。
- [ ] `src/memory/services/memory-lifecycle.service.ts:463` 附近：回合收尾推店投影处（`savePresentedJobs` 调用点）同步 +1（`presentedJobs` 是合并去重累计列表，不能替代计数）。
- [ ] `src/memory/services/session.service.ts` `deriveReengagementState()`（:532-578）透出该字段；`ReengagementSessionState` 类型（`src/memory/types/reengagement-session-state.types.ts`）增字段。
- [ ] 确认清理路径（session.service.ts:649 的 lastCandidatePool/presentedJobs/currentFocusJob 覆盖清理）**不**误清计数。

**C2 锚点升档 — `src/agent/reengagement/anchor.service.ts`**

- [ ] 两条推店排程路径（`presentedStoreCalls` 直排 + `scheduleRecalledPoolPresentation` 召回池兜底）在 `schedule('store_presented_no_reply', ...)` 前读 state：`storePresentationRounds >= 1`（本轮为第 2+ 轮）→ stateOverride/payload 带 `escalateToGroupInvite: true`。不新增场景 code、不需要 supersede。

**C3 载荷与灰度**

- [ ] `FollowUpJob.escalateToGroupInvite?: boolean`（scheduler 透传）。
- [ ] `resolveRolloutEnabled` 子键 `store_presented_no_reply:invite`（缺省 false）；子键关闭 = 降级普通档（文案不预告拉群、不 invite），主场景开关行为不变。

**C4 到点编排 — `src/agent/reengagement/follow-up.processor.ts`**

- [ ] 真发路径 `markSent` 成功后：`escalateToGroupInvite && invite 子键开 && !shadow` → 读会话事实「意向城市」（无 → 底账记 `invite_skipped:no_city`，文案已发不回滚）→ `GroupInviteService.invite(turnKey=batchId)`。
- [ ] 成功：`ReengagementTrackingService` 新增 `trackGroupInviteResult(identity, result)` 落触达事件流（`group.invited` ops 事件由 service 内部已记）→ `stopPendingJobsForSessionScenario` 清本会话其余 pre_booking 在途任务（拉群即收口）。
- [ ] 失败：底账记 `invite_failed:{reason}`，不重试（群满告警由 service 内部走既有 `sendGroupFullAlert`）。
- [ ] shadow / 非 reply / 投递失败 / unknown 各分支**绝不调用 invite**（invite 只挂在 markSent 成功之后）。

**C5 生成 — `src/agent/reengagement/reengagement.agent.ts`**

- [ ] escalate 档文案分支：承接新推岗位 + 问是否不感兴趣 + 预告拉群；预告措辞禁完成时态（「已拉」「已经进群」），对齐守卫「只拦完成时态假宣称」口径。

**C6 测试**

- [ ] `tests/memory/services/`：轮次递增与派生透出（新建对应 spec）。
- [ ] `tests/agent/reengagement/anchor.service.spec.ts`：第 1 轮不带标记 / 第 2 轮两条路径都带标记。
- [ ] `tests/agent/reengagement/follow-up.processor.spec.ts`：invite 成功收口清任务 / 失败不重试且文案独立成立 / 无城市跳过 / 已在群（`alreadyInGroup`）补记不再升档 / shadow 零 invite 调用 / 子键关退化普通档。
- [ ] `tests/agent/reengagement/reengagement.agent.spec.ts`：升档文案断言（含预告非完成时态）。

**C7 文档**

- [ ] `docs/product/invite-to-group.md` 补「复聊触发来源」一节；`docs/product/reengagement.md` §5.3 补升档说明 + 状态字典补 `invite_failed:*` / `invite_skipped:no_city`；`reengagement-pipeline.md` 更新。
- [ ] `docs/product/reengagement.md` §3.2 非目标修订：「不拉群」改为「复聊 Agent 不自主拉群（仍物理无工具）；推店未回升档的拉群由 processor 确定性编排在投递成功后执行」——口径突破点必须在产品文档显式记录，不能靠代码注释。

**C8 验证与灰度**

- [ ] Shadow 抽查重点：触发资格质量（是否真的是扩面后的沉默，对照 0820 主链两轮口径）；预告文案口径。
- [ ] 真发前置：§7 #4（扩面口径）#5（预告 vs 卡片自解释）裁定；开关 = `store_presented_no_reply:invite`。
- [ ] 真发后 Supabase 核对：升档触达的 `group.invited` 事件与 `invitedGroups` 落库一致；同会话 pre_booking 在途任务清零。

---

### PR-D 面试后回访 · 入职跟进档

**D1 注册表 — `src/agent/reengagement/scenario-registry.ts`**

- [ ] `FollowUpScenarioCode` union 增 `post_interview_onboarding`；新注册项（§3.2：anchorEvent `interview.passed`，after_anchor 4320 分钟，displayName「面试后回访 · 入职跟进」，defaultRolloutEnabled false）。
- [ ] `shouldStop` 两处豁免泛化：terminal 豁免（:425-428）与已回话豁免（:438-440）从 `anchorEvent === 'booking.succeeded'` 改为 `getScenario(code).phase === 'post_booking'`；回归断言对既有两场景零行为差。

**D2 sweep cron — 新文件 `src/agent/reengagement/onboarding-sweep.cron.ts`**

- [ ] `@Cron('*/15 * * * *', Asia/Shanghai)` + `READ_ONLY_PREVIEW` 跳过 + running 互斥（对齐 `sponge-status-poll.cron.ts` 先例）。
- [ ] `OpsEventsRepository` 新增查询：近 48h 的 `interview.passed` 事件（corpId/userId/chatId/botImId/workOrderId/occurredAt）；依赖方向 agent→biz 合法，reengagement 所在 module import `OpsEventsModule`。
- [ ] 逐条 `scheduleFollowUp`：jobId = `${sessionId}:post_interview_onboarding:wo${workOrderId}:pass`（Bull 去重，重扫幂等）；anchorAt = occurredAt；workOrderId 入 payload；channelIdentity 缺省由 processor 到点兜底解析。
- [ ] 总开关关闭时 sweep 不排（`scheduleFollowUp` 已有 disabled 早退，天然满足）。

**D3 到点分派 — `src/agent/reengagement/follow-up.processor.ts`**

- [ ] `anchorEvent === 'interview.passed'` 独立分支：`resolveReengagementBookingContext`（带 workOrderId）→ 按 `currentStatus` 分派（§3.3 表：面试成功→触达 / 上岗成功→`already_onboarded` / 上岗失败·已离职→人工介入 + `onboarding_intervention_dispatched` / 其余→`work_order_regressed`）；**不走** `checkBookingInvalidAtFire`，也不走 1.5 时间校准块。
- [ ] 触达 markSent 成功后排复核任务：jobId `...:wo{id}:onboarding_check`，+48h；到点现查工单——`上岗成功` → 静默结束；仍 `面试成功` → 人工介入（`onboarding_follow_up_required`）。
- [ ] 人工介入实现（按 §7 #2 裁定，缺省"告警不暂停"）：`HandoffRecorderService.record({reasonCode, workOrderId, ...})`（落 `handoff_events` + `ops_events(handoff.triggered)`）+ `GeneralHandoffNotifierService.notify(...)`；同工单幂等（复用 handoff 幂等键机制）；module import `HandoffEventsModule` / `NotificationModule`。
- [ ] 真人介入闸、待答闸对触达档照常生效；复核任务只告警不发消息，跳过触达类闸。

**D4 生成 — `src/agent/reengagement/reengagement.agent.ts`**

- [ ] 本档 generationPolicy（shadow 起草版，真发前按运营话术校准）：确认是否已顺利入职 / 有没有遇到问题 / 需要协助可以说；不得断言已入职或未入职；不施压不催报到。
- [ ] 语义停止条件：`candidate_abandoned_onboarding`（聊天明确放弃）→ skip；已明确说过已入职 → skip。

**D5 测试**

- [ ] 新 `tests/agent/reengagement/onboarding-sweep.cron.spec.ts`：同事件两轮 sweep 只产生一个任务 / 48h 窗口边界 / READ_ONLY_PREVIEW 跳过。
- [ ] `follow-up.processor.spec.ts`：四态分派各一 / 复核任务两分支 / 人工介入落库 + notify 调用断言 + 同工单幂等 / interview.passed 分支不触发 1.5 校准。
- [ ] `scenario-registry.spec.ts`：shouldStop 豁免泛化对 `interview_reminder` / `post_interview_followup` 行为不变、对新档生效。
- [ ] `reengagement.agent.spec.ts`：本档 prompt 与停止条件。

**D6 文档与前端**

- [ ] `web/src/view/reengagement/list/constants.ts` 兜底文案补 1 行（`post_interview_onboarding: '面试后回访 · 入职跟进'`）。
- [ ] `docs/product/reengagement.md` §5.6 补入职跟进阶段 + 状态字典补 `already_onboarded` / `work_order_regressed` / `onboarding_intervention_dispatched`；`reengagement-pipeline.md` §2 补 sweep cron。

**D7 验证与灰度**

- [ ] 测试库演练一条人工介入链路：`handoff_events` 落库 + 飞书卡片送达对应负责人。
- [ ] Shadow 抽查：面试通过样本的触达时点（passTime+3d）与文案；`already_onboarded` 静默正确。
- [ ] 真发前置（blocker）：运营话术 A–D + §7 #1（聊天轨）#2（是否暂停）#3（复核口径）裁定。

---

### 6.5 上线顺序与放量节奏

1. PR-A 合入 → shadow ≥1 完整业务周期（覆盖周末与改期样本）→ 达标 + 裁定 #6 → 开 `interview_reminder:d2`。
2. PR-B 合入即生效（零行为变更），主链拉群指标观察 1–2 天，异常即回滚。
3. PR-C 合入 → shadow ≥1 周期（资格判定质量重点）→ 裁定 #4/#5 → 开 `store_presented_no_reply:invite`。
4. PR-D 合入 → shadow（可与 C 并行观察）→ 话术 + 裁定 #1/#2/#3 齐 → 开 `post_interview_onboarding`。
5. 每次只开一个开关，间隔 ≥1 个观察日；异常按一期 SOP 切回 shadow 或总开关急停；三项优化的硬错误率门槛与一期一致（0 容忍）。

---

## 7. 待裁定项（真发前逐条确认）

| # | 事项 | 建议 | 影响 |
| - | ---- | ---- | ---- |
| 1 | 入职跟进是否需要聊天轨（新增会话事实 + 回合收尾检测「面试通过」自陈） | 一阶段只做工单轨；shadow 数据出来后按漏检率裁定 | 二阶段范围 |
| 2 | 入职跟进人工介入是否暂停托管 | 告警不暂停（保留 AI 应答；暂停留给真人明确接管） | PR-D 一行分支 |
| 3 | 入职复核时点与口径（触达后 +48h？"候选人未回复且工单未推进"是否即算未入职） | +48h；工单未到「上岗成功」即转人工，由人判断 | PR-D |
| 4 | 扩面口径：第 ≥2 轮推店未回是否即等于"已扩大范围"（对齐 0820 主链 2 轮上限） | 是，一阶段用轮次口径；查询签名变化留作收窄增强 | PR-C |
| 5 | 拉群档文案是否预告拉群（invite 失败时预告落空）还是卡片自解释 | 预告 + 卡片紧随（守卫只拦完成时态，兼容）；失败率高再改 | 文案策略 |
| 6 | 确认档触达钟点：`interviewAt - 48h`（随面试钟点）vs 固定 D-2 上午 10 点 | 随面试钟点（实现最简，落点基本在日间） | PR-A |
| 7 | 一期遗留 9–21 点静默窗口是否随二期一并落地（确认档/入职跟进均为固定时点触达） | 建议随二期真发前统一实现，一次覆盖全场景 | 独立小 PR |

---

## 8. 验收标准（在一期通用验收之上追加）

**面试提醒确认档**：报名距面试 <3 天不排确认任务；改约改近后确认任务不发且到场档仍正常；同工单确认档与到场档各发一次、互不判重；确认文案含意向确认 + 面试时间（聊天约定优先）+ 改期出口；<24h 到点任务停发；`interview_reminder:d2` 子键关闭时确认档只 shadow、到场档不受影响。

**回访入职跟进档**：interview.passed 后第 3 天触达，同工单终身只触达一次（sweep 重扫不重复）；工单已上岗成功不触达；上岗失败不触达且人工介入卡片送达对应负责人并落 `handoff_events`；复核任务在工单推进后静默结束；候选人聊天中明确放弃入职时 skip。

**推店未回拉群档**：第 1 轮推店未回仍走普通档，第 2 轮起升档；文案投递成功后邀请卡片发出，`invitedGroups` 落库、`group.invited` 落 ops_events、本会话其余 pre_booking 在途任务被清；shadow 模式零 invite 调用；`store_presented_no_reply:invite` 子键关闭时回退普通档触达；invite 失败不重试且底账可查原因；已在群候选人不升档。
