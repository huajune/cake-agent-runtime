# 候选人进度与口径迁移

`CandidateProgressService` 是只读派生视图。工单和指针按 `corpId + userId` 读取，手机号回落只读当前托管账号的候选人档案；阶段和邀请记录按 `chatId` 读取，不新建业务事实表。`fresh` 穿透指针缓存并跨账号查工单；`cached` 复用原有 5 分钟预约快照。原始工单列表仅随这份短缓存保留，供同一批数据上的窗口比较。

当前执行口径固定为 `legacy`。以下规则各自保留原来的时间边界、状态预处理和调用方降级行为。统一窗口尚待观察结果评审，不提供能绕过评审的自动切换。

| 读者             | 集中后的旧规则                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| 回合装配         | `isSnapshotEligibleWorkOrder`：约面两态，报名 ≤15 天或面试在未来；补读指针仍用 30 分钟窗口                  |
| 报名/预检        | `findSnapshotDuplicate` 同岗位或同品牌；`isRecentSameJobBooking` 严格小于 30 分钟；跨账号查重仍复用原有查询 |
| 出站守卫         | `mergeLegacyGuardBookings`：快照本人条目加全部指针；任一路未知且没有正证据时返回未知                        |
| 复聊带外核验     | `evaluateOutOfBandWorkOrders`：约面超过面试时间 3 天放行、面试通过 30 天内停发、上岗停发                    |
| 报名后提醒到点   | `isLegacyPostBookingActive`：仅约面两态，无时间窗，不额外 trim                                              |
| 清 booked 前复核 | `hasLegacyOpenWorkOrders`：约面两态及面试成功，无时间窗                                                     |
| 复聊终态停发     | `legacyTerminalStops`：保留旧终态停发与报名后豁免；新写入口只允许 booked                                    |

修复与窗口迁移分开：指针数据库错误不再伪装为空；守卫遇到未知不升级为“确证无工单”。报名前复聊从长期档案找回本人有效手机号，派生在途事实为 yes 时停发；事实 no 不会用新的窗口清空已有 booked，unknown 也保留旧终态。存量终态仍可读取，避免升级时丢失已有停发状态。

`stage:` 与会话 hash 在同一段 Lua 中续期，仅 expire 已有阶段，不重建过期阶段；初次写入也使用会话实际 TTL。视图中的群邀请记录不是实时成员核验；跨账号查询不提供账号归属证据时，`ownedByCurrentAccount` 明确返回 unknown。

窗口分歧用 `candidate_progress_difference` 事件进入现有 `agent_execution_events`，不抽样丢弃。事件包含 reader、当前 legacy 口径、同一批工单的 context/proactive/openWithoutWindow 三个结果及条数，不带手机号或原始工单正文。观察时按限定时间段、reader 和三个结果组合统计，抽样回到同一 trace 的回合流水核验。`openWithoutWindow` 是比较基线，尚非批准的统一执行口径；只有确认窗口、停发与恢复条件后才增加可回退的执行切换。

行动许可在 `../action-permit/`。事实视图不会因为 A 账号聊天被接管而暂停 B 账号聊天。
