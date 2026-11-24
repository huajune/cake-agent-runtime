# 消息与动作存储改造

## 生产基线

2026-11-24 16:33:33（北京时间），新加坡生产库在同一个可重复读事务中按数据页分段计数。每条动作或聊天消息只计一次。以下为生效前基线，实际处理数以发布后每批提交的结果为准。

| 对象 | 总行数 | 可去重 | 已引用 | 保留原值 | 待核实 | 断开引用 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 动作 `agent_action_records` | 44,927 | 182 | 4,235 | 27,829 | 12,681 | 0 |
| 聊天 `chat_messages` | 613,656 | 576,462 | 4,926 | 32,268 | 0 | 0 |

- 动作候选包括 43 条成功、139 条确定未生效且不可重试的失败。保留项包括 27,792 条观察或关闭模式、13 条待裁定、7 条已登记、17 条已取消。另有 12,681 条缺少能唯一指向已采信回执的标识。早先按 JSON 同值找到的 39,811 条覆盖多种状态，直接据此回填会给历史记录补上未经证实的采信关系。
- 聊天按整条消息计数，一条可移除一个或两个文本键。保留项包括 23,817 条其他消息类型，以及 8,451 条没有同值文本键的消息。数据页数、磁盘空间和节省字节数应在生产执行后另行测量。

## 六项改造的字段与读写方

| 工作项 | 写入与关联 | 读取、保留和处理决定 |
| --- | --- | --- |
| 1. 建立基线 | 两张可清理表分别按 `(corp_id, action_id)`、`message_id` 扫描 | 审计输出每页总数、各类保留原因、缺失引用、候选键和游标。执行时使用同一套数据库判定函数。 |
| 2. 动作结果和回执 | 动作仓储调用 `transition_agent_action`。回执写入 `agent_action_evidence.completion`，主表保留状态、尝试编号及采信摘要 | `action_record_json` 按企业、动作、采信尝试和回执摘要还原。正文两项逐项按 JSONB 比对，确定失败还要求请求已终止。可重试、待同步、未知和证据冲突保留。预约回放也按采信回执查工单。既有 90 天终态脱敏规则继续负责清理动作正文和相关回执。 |
| 3. 聊天正文 | 聊天仓储单条和批量写入均传完整消息包。对 `TEXT` 消息独立比较 `text` 和 `pureText`，只移除值为相同 JSON 字符串的键 | `chat_read_payload` 把相应键与剩余载荷组合。渠道来源和媒体字段保留原位置。聊天消息不进入定时删除任务，修改 `content` 时先保全原消息包。 |
| 4. 工具明细 | `save_processing_snapshot` 同事务保存流水和模型快照。步骤按原顺序引用顶层 `tool_calls`，快照按消息、版本和摘要配对 | 详情用 `processing_read_steps`、`processing_read_invocation`。220 条历史抽样中 158 条含工具，43 条为三份原值，115 条已使用引用。本批验证顺序、父记录纠正及 89/90/91 天边界，沿用现有写入。旧快照归属原版本。 |
| 5. 流水预览 | 保留写入时的消息预览和回复。列表、最慢榜、中心及可选租户列表在查询时按字符截取，入站 50 字、回复 120 字 | 详情保持原始两列，并按需取对应快照。合并输入看该次请求，分段回复看该次快照和下发段数。独立兜底、快照缺失或过期时仍能读原有主表内容。抽样 177 对回复完全同值，主表也承担快照缺失时的回查，本批保留此处物理副本。 |
| 6. 审查、事件、人工裁定 | `guardrail_review_records` 存首稿、命中依据及实际修订；`agent_execution_events` 按事件及采样策略落库；`review_agent_action` 写 `agent_action_reviews` | 前两者均由流水详情按 `trace_id` 读取，默认保留 90 天。人工裁定由受控 RPC 写入并留痕，与动作关联，历史脱敏只清除裁定正文。15:49 核得裁定表 0 行，仍有 13 条企微回复结果未知、无终局证据且已标记待裁定。三张表均保留。 |

代码入口包括[动作仓储](../../src/biz/action-execution/action-records.repository.ts)、[聊天仓储](../../src/biz/message/repositories/chat-message.repository.ts)、[流水仓储](../../src/biz/message/repositories/message-processing.repository.ts)、[详情组装](../../src/biz/message/services/message-processing.service.ts)、[前端全文选择](../../web/src/view/message-processing/list/components/MessageProcessingDetailDrawer/utils.ts)和[历史导出](../../scripts/backfill-badcase-trace-memory.js)。审查和事件各有独立的[审查仓储](../../src/biz/message/repositories/guardrail-review.repository.ts)、[采样入口](../../src/observability/persisting-observer.ts)和[事件仓储](../../src/biz/monitoring/repositories/agent-execution-event.repository.ts)。

## 发布与历史清理

1. 在正常发版窗口先应用三份数据库迁移，再发布使用新列表投影的应用。迁移只安装读写逻辑和工单查找索引。两个新增写入开关缺省关闭。索引构建涉及动作回执表，迁移设置 2 秒锁等待和 30 秒语句超时。
2. 在新旧写入混合时核验聊天完整载荷、详情、租户范围和预约同步。需要完整聊天包的 SQL/外部导出调用 `chat_read_payload(c)`；直接读物理 `payload` 得到剩余字段。待回滚版本同样要能读新格式。在现有 `system_config.runtime_storage_writes` JSON 中合并开关，保留其中其他配置。混合文本需 `chat_text` 与 `chat_mixed_text`，确定失败需 `action_body` 与 `action_failed_body`。
3. 验证新写入的完整值及采信引用后再扫历史。在选定的 PostgreSQL 连接环境中运行下列命令。输出文件含还原用的行键，应留在发布操作记录中。每页最多 100 行，脚本缺省只读。

   ```sh
   python3 scripts/run-runtime-storage-batches.py action --pages 5 >> action-audit.jsonl
   python3 scripts/run-runtime-storage-batches.py chat --pages 5 >> chat-audit.jsonl
   python3 scripts/run-runtime-storage-batches.py chat --pages 5 --apply >> chat-apply.jsonl
   ```

4. 各表独立续扫。从最近一条相同表、相同执行模式的 `phase=complete` 记录取 `next_after`，传入 `--after "$next_after"`。每批先保存候选键，再锁行核对，提交后才输出实际变更键和跳过原因。遇锁超时或还原差异会回滚整批。进程中断时从上一个已完成游标重跑，已引用行会跳过。`done=true` 表示本轮到尾。业务持续写入时，在截止时刻从头再审计一次，核对新增和状态变化。
5. 回退时先关闭相应的基础和新增写入开关，保持还原读取函数在线。以每批 `changed_keys` 执行 `psql -X -v ON_ERROR_STOP=1 -v keys="$changed_keys" -f scripts/restore-runtime-storage.sql`。另从头只读扫描所有页，用 `restore_keys` 补齐开关生效期间新写或中断提交的混合聊天包与失败回执。复扫确认新格式余量、断开引用、还原差异均为 0，再回退旧读取函数。
6. 生产验收按同一截止时点交付各表实际处理、已引用、保留、待核实和差异数。完成后更新 `docs/db/database-schema.md` 及其日期。

在一次性 PostgreSQL 库上运行[既有写入与还原回归](../../tests/supabase/runtime-data-governance.sql)和[本批回归](../../tests/supabase/runtime-storage-batch.sql)。两套用例在事务内使用合成数据并回滚。
