# 2026-08-28 候选人证据链与收资表单收口

## 变更摘要

- 删除已经没有生产调用者的候选人 Claim Engine、有效档案物化视图、专属 producer、测试与
  verdict registry 登记；移除无人读取的 `CANDIDATE_FACT_ADJUDICATION_MODE` 示例配置。
- 新建 `resolution/notary/`，保留 citation 校验、NFKC 文本归一、真实确认问答绑定与
  Assistant 回声等低层机械原语。
- 把候选人值形态、值等价、身份归属迁回 `resolution/candidate/`；turn hints、品牌和城市
  逻辑分别迁回 `resolution/turn-hints/`、`resolution/brand/`、`resolution/geo/`。
- collection 内部字段值提案族原子改名为 `FieldValueProposal`、
  `RoutedFieldValueProposal`、`collectFieldValueProposals()`、
  `applyFieldValueProposal()` 及对应结果/原因类型。
- 工具边界同步收口为 `fieldValueProposals`；提案本体与运行时构造的
  `FieldValueNotaryContext` 分离。模型只提交原话明确支持的最终值，确定性 adapter 仅拒绝已知
  冲突，未覆盖不再触发降级或 recap。
- collection 删除 `SlotConfidence`、self-filled 旁路和专属审计；条件式 recap 只识别
  archive/system/manual 外部预填。所有明确确认表达均由模型提交同形态 `recapConfirmation`，
  recap notary 机械绑定当前完整回复、真实相邻复述和表单快照。
- `BookingCollectionForm` 新增岗位级 `scheduleDraft`，首次收资并行展示 `bookableSlots` 并可同轮
  接收资料与时间。新增 `select_interview_time`；precheck 与 booking 共用
  `isSubmissionAuthorized()`，只有资料授权且时间实时可约才签发/消费提交资格。

## 行为不变量

- 报名字段仍只经 collection form machine 写入；三通道优先级、filled 棘轮、身份归属、
  契约筛选、errorList 与 ask/rejectedAttempt 分账保持不变。
- booking 仍要求本轮 `ready_to_book` ledger 凭据，payload 仍只从持久表单生成；时间不进入
  `FormSlot`、`requiredFields` 或 booking `labelList`。
- `BookingCollectionForm` 仅在既有 Redis 单据内增加 `scheduleDraft`；`FormSlot`、
  `bookingChecklist`、`collection_form_audit`、`proposal_rejected`、Redis key/TTL、Sponge
  endpoint/wire 字段及 `COLLECTION_IDENTITY_LABEL_IDS` 均未改名或改协议。
- 旧 Redis 槽位的 `confidence:'medium'` 仅在最长 3 天兼容窗内保守触发 recap；Memory 域自己的
  confidence 语义不变，无数据库迁移。
- 表单与长期档案的 bot 隔离、phone 到达后的 candidateRef rebind、booking 成功后的
  session high / long-term high 回写保持不变。

## 验证与观察

- 迁移前 collection / precheck / booking 基线：19 suites、323 tests 全绿。
- 本次 collection / notary / precheck / booking / turn-hints / Memory 边界相关回归：24 suites、
  379 tests 全绿；全量 Jest 442 suites、6387 tests 全绿（仓库既有 1 suite / 5 tests skip）。
- `lint:check`、`format:check`、`typecheck`、`build` 与 `git diff --check` 全部通过。
- `src/` 中旧 FormAnswer、self-filled、recap 快速放行符号零命中；
  `src/resolution/collection/` 中 `SlotConfidence` / 槽位 `confidence` 零命中。
- 发布后重点观察 `collection_form_audit` 的 `proposal_rejected`、重复追问、报名失败与人工
  介入曲线；本次是结构收口，任一曲线异常抬升均按回归处理。

## 回滚说明

无数据库迁移、Redis 迁移或外部依赖变更。若出现行为回归，整体回滚本批应用代码；不要单独
恢复旧 Engine 或旧环境变量，以免重新形成第二套报名权威。
