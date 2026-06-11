# TODO: assistant 消息主动写入 chat_messages，不再依赖 WeCom 回调

> ## 结论（2026-06-11，已用数据验证，暂不改造）
>
> 按本文档"决策标记"的要求先做可观测性——直接用生产 7 天数据对账丢失率：
> 对每个 `message_processing_records` 中 `status='success' AND reply_segments>0`
> 的 turn，检查其 chat 在回复时间 −30s ～ +10min 窗口内是否出现了对应的
> `chat_messages.role='assistant'` 落库行。
>
> **结果：4374 个成功回复中仅 1 个未对上 → 丢失率 0.02%**，远低于本文档隐含的
> 改造门槛（"回调丢失率 > 0.1% 才值得做发送即落库"）。企微 `isSelf=true` 回调
> 在生产是可靠的，"Agent 失忆/对话错乱"在数据上不是系统性问题。
>
> 因此**暂不做"主动写入 + 幂等回调"改造**（避免为 0.02% 引入双写、分段落盘、
> UPSERT 迁移、Redis 双写失效等一连串复杂度与新风险）。若未来企微回调通道
> 劣化（该对账 SQL 可随时复跑监控），再重启本改造。
>
> 对账 SQL 与判定见 memory `pipeline-observability-findings`。
>
> - [x] 先做可观测性补齐（已用对账 SQL 量化丢失率 0.02%）
> - [x] 再决定是否改造 → **结论：不改造**

## 问题背景

当前 `chat_messages` 表里 **assistant 角色消息的写入**不走主流程，而是依赖 WeCom 把我们刚刚发送的消息作为 `isSelf=true` 再回调过来，由 [`accept-inbound-message.handleSelfMessage`](../../src/channels/wecom/message/application/accept-inbound-message.service.ts) 写入。

链路示意：

```
Agent 生成回复 → deliveryService.deliverReply → WeCom 接口投递成功
                                                        │
                                                        ▼
                                     （等待 WeCom 回调）
                                                        │
                                                        ▼
handleMessage(isSelf=true) → handleSelfMessage → chat_messages INSERT
```

## 风险

1. **回调丢失 / 延迟**：WeCom 回调不是同步的，网络抖动或对方系统问题可能导致我们发出的消息延迟几秒甚至丢失回调。
2. **Agent 失忆**：下一轮 Agent 调用 `memory.onTurnStart` 时会从 `chat_messages` 拉短期窗口。如果 assistant 这条还没写进去，Agent 看到的就是"用户问了但我没回答"的错觉。
3. **对话错乱**：用户常常在收到回复后立刻追问，触发的下一轮 Agent 读不到自己上轮回复 → 回答重复 / 与上轮矛盾 / 漏掉上轮已推荐过的岗位。
4. **可观测性缺失**：目前没有监控能发现"isSelf 回调丢失"这件事。

## 优化方向

**在 `deliveryService.deliverReply` 成功后立即写一条 assistant 到 `chat_messages`。** WeCom 的 `isSelf=true` 回调来时，用 `messageId` 幂等处理（同 id 不重复插入，只 UPDATE 补齐元数据）。

### 大致分工

| 文件 | 改什么 |
|---|---|
| `src/channels/wecom/message/delivery/delivery.service.ts` | 投递成功后主动调用 `chatSession.saveMessage(role='assistant')`，content 取 Agent reply，`messageId` 用发送接口返回的 sentMessageId（若有） |
| `src/channels/wecom/message/application/accept-inbound-message.service.ts` | `handleSelfMessage` 改为幂等：存在 → UPDATE 补齐 payload/avatar/source 等 metadata；不存在 → INSERT |
| `src/biz/message/services/chat-session.service.ts`（或 repository） | 确保 `saveMessage` 是 `UPSERT ON CONFLICT (message_id)`，避免回调乱序时覆盖 assistant 内容 |

## 需要先确认的点

1. **发送接口返回的 `sentMessageId` 是否等于 `isSelf=true` 回调里的 `messageId`？** 如果相同，幂等直接用 messageId 做 key。如果不同，需要其他字段（chatId + content + 时间戳）做关联，或者引入本地生成的 client_message_id。
2. **`handleSelfMessage` 里有多少"只有回调才拿得到的信息"？**（比如 payload 里的原始富文本结构、avatar）。这些字段在投递成功那一刻能不能从上下文里拼齐？不能的话 UPSERT 要保留回调路径的补齐能力。
3. **分段回复（一轮 Agent 回复被切成多条发送）怎么落盘？**
   - 当前：WeCom 会为每段分别回调 isSelf=true，`chat_messages` 里一轮 assistant 被拆成多行
   - 改造后是否继续拆？还是合并成一行？会影响 recall 出来的短期窗口形状 → **需要权衡向后兼容**。
4. **投递失败 / 部分分段失败的场景**：只有部分段发出去了，`chat_messages` 里该写入发出去的那几段？还是完全不写？

## 潜在坑

- `chat_messages` 目前可能没有 `(chat_id, message_id)` 的唯一约束 / ON CONFLICT 支持，需要确认 schema 后决定是否要迁移。
- Redis 短期窗口 cache（`memory:short:*`）和 `chat_messages` 双写时，需要让"投递后写入"也失效/更新 cache，否则下一轮 Agent 拉到的还是旧窗口。
- 分支路径：`skip_reply`（主动沉默）不发消息、不产生 assistant 记录——优化后要确保这条分支不误触发主动写入。

## 决策标记

- [ ] 先做**可观测性补齐**（记录 `isSelf=true` 回调丢失率），用数据验证问题确实在发生
- [ ] 再决定是否做"主动写入 + 幂等回调"改造

## 参考

- 数据流总览：[docs/workflows/wecom-message-dataflow.md](../workflows/wecom-message-dataflow.md)
- 当前 self-message 写入点：[`accept-inbound-message.service.ts:161-205`](../../src/channels/wecom/message/application/accept-inbound-message.service.ts#L161-L205)
