# 报名标签接口契约修改建议（给海绵后端）

> 依据：2026-08-18 生产全量消费实测（468 在招岗位 × 109 标签）+ AI 侧收资状态机设计。
> 全部建议为**增量字段，向后兼容**——不改既有字段语义，不要求存量配置迁移。
> 涉及接口：`/ai/api/jobs/interview-labels/batch-query`（查）、`/ai/api/workorder/entryUser`（提交）。
>
> **0818 升级约定（已与后端口头对齐）——收资判决单源化**：收资/筛选的全部判决要素
> （必填标志、年龄等值域）由 batch-query 标签接口独立承载；岗位详情接口回归展示域
> （只服务向候选人介绍岗位）。本单 **#1 required、#5 valueSpec 由"建议"升级为已约定方向**，
> 落地节奏待后端排期；AI 侧按单源设计实施，契约未带的判据即视为该岗无此筛。

## 0820 实测回执 + 后端沟通结果（本单终态）

契约 v2 已上生产，AI 侧 0820 生产实测 9 岗（探针存 scratchpad contract-v2-probe\*.json）
并与后端同学沟通，逐条终态：

| 条目                 | 终态                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| #1 required          | ✅ 已落地实测通过（默认 true 全量返回）                                                                       |
| #5 valueSpec         | ✅ 已落地超预期：年龄 min/max/unit + genderRanges 分性别实测（528995 身高体重）                               |
| #6 disclosure        | ✅ 已落地（籍贯[3] RESTRICTED 实测）                                                                          |
| #3 systemField       | 🔧 **后端承诺改**（0820）；落地前 AI 侧走环境级配置 + labelTitle 每轮核验兜底                                 |
| #8 敏感补标          | 🔧 **后端承诺改**（专业族 659/544 补 RESTRICTED）；AI 侧披露兜底注册表照常随批交付                            |
| #2 errorList labelId | 🔧 **后端承诺改**；AI 侧 applyErrorList 已按 labelId 可选设计（缺失→按 labelTitle 匹配，失配→转人工），不阻塞 |
| #8.5 optionUniverse  | ✅ **关闭**：rejectedOptions 系统性填充已确认（凡有排除必返回），选项全集不再需要                             |
| #4 配置版本号        | 已撤回（零缓存裁定）                                                                                          |
| #7 requirementNote   | 未落地，维持替代通道定位不催办                                                                                |

### AI 侧实施蓝图 §8 状态对账（2026-08-25 刷新）

原 `collection-form-machine-implementation.md` 已随收资切换归档删除；以下只刷新其 §8
七步实施状态，不改变原方案。PR #1023 的落地提交为 `156d9fa9`。

| 步骤                                            | 状态                       | 上线证据                                                                                                                                                                                                       |
| ----------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `form.types` + `form-writes` 纯逻辑核        | ✅ 已上线（PR #1023）      | `src/resolution/collection/form.types.ts`、`src/resolution/collection/form-writes.ts`；提交 `156d9fa9`                                                                                                         |
| 2. option matching + 适配器 + disclosure policy | ✅ 已上线（PR #1023）      | `src/resolution/collection/option-matching.ts`、`src/resolution/collection/adapters/`、`src/resolution/collection/disclosure-policy.ts`；提交 `156d9fa9`                                                       |
| 3. recap / rejection renderer                   | ✅ 已上线（PR #1023）      | `src/tools/collection/recap-renderer.ts`、`src/tools/collection/rejection-renderer.ts`、`src/tools/collection/collection-template.renderer.ts`；提交 `156d9fa9`                                                |
| 4. 0819 契约检查点                              | ✅ 已完成（先于 PR #1023） | 本文「0820 实测回执」；契约探针回执提交 `79fba236`，终态沟通回执提交 `efa3ccd1`                                                                                                                                |
| 5. Sponge 契约客户端 + 表单 store/service       | ✅ 已上线（PR #1023）      | `src/sponge/collection-contract.types.ts`、`src/sponge/sponge.service.ts`；表单 IO 经 M5 归属修正后现位于 `src/tools/collection/collection-form.store.ts` 与 `collection-form.service.ts`；起始提交 `156d9fa9` |
| 6. 收资核接管 precheck / booking                | ✅ 已上线（PR #1023）      | `src/tools/collection/collection-core.ts`、`src/tools/duliday-interview-precheck.tool.ts`、`src/tools/duliday-interview-booking.tool.ts`；提交 `156d9fa9`                                                      |
| 7. 旧链退役删除 + 全量回归                      | ✅ 已上线（PR #1023）      | `checklist.util.ts`、旧 customer-label builder、snapshot gate 等在 `156d9fa9` 删除；`docs/releases/2026/v10.45.0.md` 记录「已退役链路删除」与全量 CI                                                           |

**实际剩余范围**：原蓝图 §8 已无未执行步骤。仍待后端或后续裁定的契约事项只保留本文
终态表中的 #3 `systemField`、#8 敏感补标、#2 `errorList.labelId`、#7
`requirementNote`。

**AI 侧另案登记（收资契约 v2 批执行）**：收资表单 key 补 bot 维（M5 裁定六，
2026-08-25 用户拍板）——`collection-form:{corp}:{userId}:{candidateRef}:{jobId}` 增补
`botUserId` 段（用稳定维，不用会轮换的 imBotId；前缀不动），堵跨 bot 并发裸写并与
"记忆不跨 bot"全线一致；代价接受（换 bot 重新收资），存量旧 key 3 天 TTL 自然过期
不迁移。（原另案之一 jobIntent 软/硬/时间三分已于 2026-08-25 裁定撤销——M5 裁定七，
全部视为软偏好不分级。）

**附：空标签口径（0820 后端确认）**——529020 返回空 labels 是**数据问题**（后端排查中），
正常情况每个在招岗位都有标签。⚠️ 由此确立 AI 侧口径（0820 用户裁定）：**batch-query
返回空标签的岗位 = 数据异常，直接转人工介入 + 落告警**；**不得**解释为"该岗无筛"
裸放行，也不做兜底续收（判决单源的"没带=无此筛"只适用于字段级缺失，不适用于
整岗空标签）。

## P0（缺了会产生错误行为）

### 1. label 增加 `required: boolean`【0818 已约定方向】

现状无必填标志，AI 只能"返回即全收"。若存在选填标签，现状会过度收资（多问候选人）；
若 AI 猜选填猜错，提交才被打回。

```jsonc
{ "labelId": 300, "labelTitle": "每周可出勤天数", "required": true, ... }
```

若业务语义确为"返回即全部必填"，也请**书面确认**写进接口文档，我们即按此固化。

### 2. errorList 增加 `labelId`

现状 `errorList[].field` 是**展示名称**（"标签说明非空时使用中文括号拼接"），AI 只能
按标题字符串反查是哪个标签——标题重复/改名/拼接规则变化都会失配，失配即整单转人工。

```jsonc
{ "errorList": [{ "labelId": 687, "field": "年龄", "msg": "超出岗位要求" }] }
```

### 3. 身份核四标签必须机读可识别（语义标记）【0818 重写，请纳入明日 spec】

**原诉求已撤回**（原为"把 769/770/687/771 写进文档作保留常量"）。撤回原因：那是
纸面承诺 + AI 侧硬编码贵方数据库主键——测试/生产环境 ID 可能不同、标签表重建即
静默断链、无任何机器校验，与 #8"从猜变读"的论证自相矛盾。

**要什么**：身份四标签带机读语义标记：

```jsonc
{ "labelId": 769, "labelTitle": "姓名", "systemField": "name" }
// systemField: "name" | "phone" | "age" | "gender"，仍要求每岗必含
```

AI 按 systemField 识别身份槽位（报名人键=phone 标签的值），不硬编码任何 labelId。
生产现值 姓名769/手机号770/年龄687/性别771（468 岗实测一致）仅作双方核对基准。
身份识别是人键的前提，此条是明日 spec 的 P0。

### 4.【已撤回 2026-08-18】配置版本号

原诉求为缓存失效信号。AI 侧已裁定**标签零缓存、每次实时查询**——运营改配置
即刻生效于下一轮对话，本条不再需要，撤回以保持需求单最小。

## P1（缺了会产生次优行为）

### 5. TEXT 标签增加值域元数据 `valueSpec`【0818 已约定方向】

**这是年龄筛选的正解**。年龄(687)现为无值域 TEXT，岗位年龄要求（如 20-38 岁）只能
从岗位描述文本里解析（脆弱老路）。建议：

```jsonc
{
  "labelId": 687,
  "labelTitle": "年龄",
  "fieldType": "TEXT",
  "valueSpec": { "kind": "number", "min": 20, "max": 38, "unit": "岁" },
}
// 身高/体重同理：{ "kind": "number", "min": 150, "unit": "cm" }
// 通用文本：{ "kind": "text", "maxLen": 200 }
```

配置了 min/max 即等于年龄筛选结构化——AI 写入时即判、超界即按拒绝流程处理。

### 6. label 增加披露级别 `disclosure`

敏感标签（籍贯/专业/学信网类）实存于生产。候选人不满足筛选时，拒绝理由能否对
候选人明说，应由**配置标签的一方**声明：

```jsonc
{ "labelId": 3, "labelTitle": "籍贯", "disclosure": "RESTRICTED" } // PLAIN | RESTRICTED
```

未带该字段时 AI 按属性族兜底判级（未知默认不明说）——可运行，但所有权错位。

### 7. 要求句标签的机读通道 `requirementNote`

业务侧可能不改「不要学生及暑假工」这类标题。若标题保留，请把要求文本同步放进
机读字段，标题恢复为给候选人的问题：

```jsonc
{ "labelId": 728, "labelTitle": "当前身份", "requirementNote": "本岗位不招在读学生与暑期工" }
```

AI 用 requirementNote 做显式软筛（而不是从标题措辞里猜），标题拼接展示也更体面。
（注：首选方案仍是选项+拒绝配置，见运营修正清单；本字段是标题无法重构时的替代通道。）

### 8. 敏感筛选标签必须可识别（RESTRICTED 标记）——因果链写全

1. **业务要求**：部分岗位按籍贯等敏感条件筛选，已裁定照实执行（2026-08-18）。
2. **用工合法约束**：筛选本身是业务决策，但**拒绝理由绝不能写给候选人**——
   AI 若在聊天里发出"因为你是 XX 省户籍所以不合适"，这段文字就是候选人可截图
   留存的**书面歧视证据**（就业促进法明令禁止以户籍/民族等实施就业歧视）。
   公司据此承担法律与舆情风险。**执行筛选**与**留下书面歧视表述**是两件事，
   后者是绝对不允许发生的技术事故。
3. 所以 AI 的执行方式被设计为：**照配置筛 + 拒因绝口不提**
   （候选人听到的是"帮你匹配了更合适的岗位"）。
4. 做到第 3 条的前提是 AI **认得出**哪个标签属于"筛但不能说"。现状接口没有任何
   标记，AI 只能按标签名猜——"籍贯"猜得到，哪天运营新建一个叫"来源地"的就漏了。
   **猜漏一次 = 书面歧视表述发出去一次**（第 2 条的风险成真）。
5. **要什么**：此类标签带 `disclosure: RESTRICTED`（复用第 6 条字段）。
   哪个标签敏感，配置它的人最清楚——在配置处标一下，AI 侧就从"猜"变成"读"。

### 8.5 提供标签选项全集（现状 AI 看不出"这个岗在排除什么"）

**现状**：batch-query 对每个岗只返回该岗的 `acceptedOptions`（接受哪些）和
`rejectedOptions`（明确拒绝哪些），**不返回这个标签总共有哪些选项可配**。

**现状造成的具体问题（籍贯标签实例）**：A 岗返回 34 个省、B 岗返回 29 个省。
AI 单看 B 岗**无法判断**"29 个就是全部选项"还是"从 34 个里抠掉了 5 个"。
实测是后者——B 岗正在排除 天津/辽宁/吉林/黑龙江/江西 户籍——但这个事实是把
全部 468 个岗的返回做并集对比才偶然发现的，看任何单个岗位都发现不了。
打个比方：接口只给了"允许名单"，没给"花名册"——没有花名册，就永远不知道
允许名单之外还有谁被拒之门外。**看不见排除项，就执行不了排除**。

**要什么**：每个 label 附 `optionUniverse`（该标签可配的全部选项），
或单独提供一个"标签字典"接口（labelId → 全部选项）。AI 拿 accepted 与全集一比，
立即知道该岗在排除什么，按配置执行筛选。

```jsonc
{
  "labelId": 3,
  "labelTitle": "籍贯",
  "optionUniverse": [
    /* 34 项全集 */
  ],
  "acceptedOptions": [
    /* 该岗接受的 29 项 */
  ],
} // 差集=该岗排除的 5 项
```

## P2（改进项）

### 9. labelInstructions 明确受众语义

现状 22 处使用、语义未定义（给候选人看的补充说明？还是给 AI 的收集指引？）。
建议拆分或在文档中定义：`candidateHint`（随问题展示给候选人）/ `aiGuidance`（仅 AI 消费）。

### 10.5 同一 labelId 的 fieldType 全库锁定

实测 561「意向岗位」24 岗配 TEXT、2 岗配 SINGLE_OPTION——同 id 跨岗类型不一致。
消费方按 labelId 沉淀与复用候选人答案时，类型分裂会使历史答案与当前岗位形态不兼容。
建议：labelId 创建时锁定 fieldType，岗位引用不得改型（需要不同类型=新建标签）。

### 10. optionCode 稳定性承诺

文档写明：同一 labelId 下 optionCode 一经发布不复用、不改含义（AI 侧按 code 沉淀
候选人历史答案，code 语义漂移会污染跨岗复用）。

## 与运营修正清单的关系

本建议书解决**契约结构**问题；`label-cleanup-for-ops.md` 解决**配置内容**问题
（语义重复/标题病/类型改造）。两者独立推进：契约字段不落地不阻塞运营修正，
运营修正不落地不阻塞契约演进；AI 侧对两者的缺位各有兜底（短 TTL+提交前重拉、
标题语义族识别、披露默认从严），兜底的存在不改变"源头修正才是正解"。
