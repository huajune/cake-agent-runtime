# 候选人档案域架构

**最后更新**：2026-08-28
**代码居所**：`src/resolution/{candidate,notary,turn-hints,brand,geo}/`、`src/memory/`、
`src/agent/generator/preparation/`

> 本文只描述当前实现。记忆存储与生命周期见
> [memory-architecture.md](./memory-architecture.md)，收资事务见
> [collection-form-machine.md](./collection-form-machine.md)。

## 1. 两个聚合，不是一份万能事实

系统保留两个生命周期不同的业务聚合：

1. **候选人档案**描述“这个人长期是什么情况”，由 short-term / long-term memory 持有；
2. **岗位收资表单**描述“这个候选人报名这个岗位办理到哪一步”，由 collection form 持有。

档案可以为检索、Prompt 和预填提供历史线索，但不能授予报名资格。报名字段能否进入提交
payload，只由 collection form machine 判断。表单实体也不会进入 `factsv2:*`。

## 2. 提取—公证—确认

候选人报名证据链采用统一表述：**模型提取、代码公证、候选人确认**。

- **模型提取**：从候选人消息和附件提出结构化字段值与 citation；
- **代码公证**：机械核验引文存在性、确认问答绑定、值形态、身份归属与契约成员关系；
- **候选人确认**：确认预填值、显式冲突和提交前汇总。

`notary` 是 citation verification 与 provenance / attribution validation 的项目借喻。
它不判断候选人陈述是否符合客观真相，不合并跨聚合状态，也不拥有任何表单写入权。

```text
候选人消息 / 附件
        │
        ▼
模型或规则提出字段值 + citation
        │
        ▼
notary / candidate 机械核验
        │
        ▼
collection form machine 写槽
        │
        ▼
候选人 recap 确认 → ready_to_book → booking payload
```

## 3. 当前代码地图

```text
src/resolution/
├── candidate/
│   ├── types.ts                    # CandidateFactProducer、候选人字段词汇
│   ├── value-shape.ts              # 字段形态与确定性值推导
│   ├── value-equivalence.ts        # 归一化与等价比较
│   └── identity-attribution.ts     # 姓名/手机号是否属于候选人本人
├── notary/
│   ├── notary.types.ts             # 通用机械检查结果
│   ├── citation.types.ts           # TextCitation、CitationVerificationResult
│   ├── citation-verifier.ts        # verifyCitation()
│   ├── text-normalization.ts       # NFKC、折空白、normalizedIncludes()
│   ├── dialogue-confirmation.ts    # 短答与真实相邻问句绑定
│   └── assistant-echo.ts           # detectAssistantEcho()
├── turn-hints/
│   ├── turn-hint.types.ts
│   ├── projection.types.ts
│   ├── policies.ts
│   ├── reducer.ts
│   ├── admission.ts
│   └── producers/
├── brand/                          # 品牌自己的意图与状态策略
├── geo/                            # 城市自己的裁决与偏好清除策略
└── collection/                     # 岗位表单纯逻辑与唯一槽位写入口

src/memory/
├── short-term/                     # 当前会话认知、工作台与品牌状态
└── long-term/                      # 候选人 × bot 长期关系档
```

候选人事实来源词汇只在 `resolution/candidate/types.ts` 定义：

```text
candidate_quote / rule / model / system / manual / archive
```

来源说明事实从哪里来；置信度说明证据质量。两者不能互相替代。

## 4. Turn hints：本轮临时线索

`TurnHints` 只表示本轮临时线索。`produceTurnHints()` 从连续候选人消息和已授权视觉 sheet
产生提示，`resolveTurnHints()` 按字段策略归并，`projectTurnHints()` 投影成消费视图。

它可以被以下可逆面消费：

- Prompt 的本轮提示；
- 岗位检索、地理锚点与工具上下文；
- 回合末偏好类 session facts 准入。

它不能直接写 collection 槽位、产生 booking payload 或写入身份档案。身份类 turn hint
只作为当前轮提示；报名身份字段经表单逐格落定后才以 medium 回写 session facts。

## 5. Session facts 与 long-term profile

### 5.1 Session facts

`factsv2:{corpId}:{userId}:{sessionId}` 保存当前会话认知与工作台，业务 TTL 为 3 天并带
consolidation 安全余量。

- 表单逐格落定的身份字段写 medium；
- booking 成功的身份字段写 high；
- 回合末模型只写偏好类软事实；
- `BookingCollectionForm` 和槽位状态不进入该 key。

### 5.2 Long-term profile

长期关系档按 `(corpId, userId, botUserId)` 隔离：

- booking 成功写 high；
- consolidation 写 medium；
- 历史值属于待确认线索，不能直接获得报名权限；
- Prompt 中 session 与历史 profile 的冲突由
  `agent/generator/preparation/prompt-memory-adjudicator.ts` 解决，只影响展示，不写状态。

## 6. Collection 桥接边界

表单按候选人 × bot × job 持有事务进度，负责契约槽位、筛选、复述、纠错、熔断、后端
打回和提交终态。memory 与表单互写只发生在
`tools/collection/collection-form.service.ts`：

- memory → form：只预填 empty 槽，且排在本轮字段值提案之后；
- form → session：逐格落定写 medium；
- booking → session / long-term：成功后写 high；
- booking payload：只从持久表单生成。

Prompt、turn hints、session facts、long-term profile 和模型工具参数都不能旁路改变槽位状态。

## 7. 依赖方向

```text
candidate ─────┐
notary ────────┼──→ collection
               │
turn-hints     │     不依赖 collection
brand / geo ───┘     各自持有领域裁决

tools/collection → resolution/collection
tools/collection → memory → Redis / Supabase
```

禁止 `resolution → tools`、`resolution → memory`、`memory → tools`、
`turn-hints → collection` 和 `collection → memory`。这些约束由 `.eslintrc.js` 的 import
边界固化。

## 8. 消费门槛

| 消费面 | 可用信息 | 约束 |
| --- | --- | --- |
| Prompt | session、历史 profile、turn hints | 同值只展示一处；异值标待确认 |
| job search | 档案与本轮 ledger | 可用于可逆检索，不得伪装成已确认事实 |
| collection | 本轮字段值提案、实时契约、持久表单 | 所有值经过同一个写入口 |
| booking | 本轮 `ready_to_book` ledger 凭据与持久表单 | payload 只能由表单生成 |
| consolidation | session facts 与消息原文 | 更新 profile / intent / episode，不碰表单 |

## 9. 排障顺序

1. 模型看到错值：查 memory snapshot、turn hints 与 Prompt 展示裁决；
2. 工具拿到错线索：查 `ToolBuildContext` 与 `TurnLedger`；
3. 下一轮记住未说过的话：查 `TurnFinalizer` 与 session facts 准入；
4. 报名重复或字段错写：查 collection form、字段值提案审计与 recap；
5. 长期档案串 bot：查稳定 `botUserId` 与三维关系隔离；
6. booking payload 异常：只查持久表单与本轮 ready 凭据，不从 Prompt 或 profile 反推。

## 10. 相关文档

- [Memory 当前实现](../../src/memory/README.md)
- [记忆系统架构与数据流](./memory-architecture.md)
- [记忆与状态全局视图](./memory-and-state.md)
- [收资表单域架构](./collection-form-machine.md)
- [品牌解析架构](./brand-resolution.md)
- [地理解析架构](./geo-resolution.md)
- [Redis Schema](../db/redis-schema.md)
