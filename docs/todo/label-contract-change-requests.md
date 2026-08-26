# 报名标签契约：剩余后端协作项

**最后核对**：2026-08-26
**接口**：`/ai/api/jobs/interview-labels/batch-query`、`/ai/api/workorder/entryUser`

> 本文只保留尚未由接口稳定提供的字段。契约 v2 已完成的 `required`、`valueSpec`、
> `disclosure`、`rejectedOptions`，以及 AI 侧收资状态机的实现过程均已从 todo 删除，历史见 Git。
> 当前代码权威见 `src/sponge/collection-contract.types.ts` 与
> `docs/architecture/collection-form-machine.md`。

## P0：已有后端承诺

### 1. 身份四槽提供 `systemField`

每个岗位的姓名、手机号、年龄、性别标签必须带稳定语义标记：

```jsonc
{
  "labelId": 769,
  "labelTitle": "姓名",
  "systemField": "name",
}
```

`systemField` 取值为 `name | phone | age | gender`。AI 按语义标记识别身份槽位，不能把
任一环境的 `labelId` 写成系统常量。

当前 AI 兜底：实时契约标题语义 + 环境锚点核验；不匹配时降为通用标签并告警。
后端字段上线后代码会自动优先采用 `systemField`，但仍需生产探针确认四槽覆盖率。

### 2. `errorList[]` 提供 `labelId`

提交失败时，错误项需要返回产生错误的标签 ID：

```jsonc
{
  "errorList": [{ "labelId": 687, "field": "年龄", "msg": "超出岗位要求" }],
}
```

当前 `field` 是展示标题，可能因改名、重复标题或说明拼接而失配。AI 已支持可选 `labelId`；
缺失时只能按标题反查，无法唯一定位则转人工。

### 3. 专业等敏感筛选标签补 `RESTRICTED`

契约已有 `disclosure: PLAIN | RESTRICTED`，籍贯标签已验证为 `RESTRICTED`；专业族
（已知 659/544）仍需由配置侧补齐。敏感字段命中筛选时可以执行业务拒绝，但不得把
籍贯、专业等拒绝原因写给候选人。

当前 AI 兜底：`resolution/collection/disclosure-policy.ts` 的敏感属性词表会覆盖错误的
`PLAIN`，因此不阻塞运行；源契约补标后仍需抽样验证所有敏感标签，而不是只核已知 ID。

## P2：契约稳定性建议（未承诺排期）

- 明确 `labelInstructions` 的受众：候选人可见提示与 AI 内部指引最好拆字段。
- 同一 `labelId` 的 `fieldType` 应全库固定；需要不同形态时创建新标签。
- 同一 `labelId` 下的 `optionCode` 发布后不复用、不改语义，保证跨岗位答案可复用。

## 验收

1. 在测试与生产分别抽取在招岗位，确认身份四槽 `systemField` 覆盖且语义唯一。
2. 构造一次服务端字段校验失败，确认 `errorList[].labelId` 可定位表单 slot。
3. 枚举带筛选的敏感标签，确认均为 `RESTRICTED`；AI 兜底与契约判断无冲突。
4. 跑收资状态机回归，确保旧响应（缺新增字段）仍按兼容路径工作。

## 相关文档

- [收资表单域架构](../architecture/collection-form-machine.md)
- [运营标签清理](./label-cleanup-for-ops.md)
- [运营标签补数据清单](./label-backfill-for-ops-20260820.md)
