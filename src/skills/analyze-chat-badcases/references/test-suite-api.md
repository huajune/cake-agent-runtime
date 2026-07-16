# test-suite API 速查

导入测试集 + 跑测试时要调用的 HTTP 端点。完整实现见 `src/biz/test-suite/test-suite.controller.ts`。

## 默认连接方式

**本地 dev server**（推荐）：`http://localhost:8585`

如需打生产：从 `.env.production` 临时读 `API_GUARD_TOKEN`，加 `Authorization: Bearer <token>`。**不要把 token 落进任何文件。**

## 常用端点

### 仅创建批次元数据

```
POST /test-suite/batches
```

该端点只创建 `test_batches` 元数据，不接受 `caseIds`，也不执行 case。请求体契约参考 `CreateBatchRequestDto`。

### 执行批次

```
POST /test-suite/batch
```

请求体使用 `BatchTestRequestDto`：`cases` 传完整 `TestChatRequestDto[]`，可附 `batchName / parallel`。当前实现会等待全部 case 执行完成后同步返回完整结果，适合定向策展子集；不要把它当异步队列再轮询。

每条 case 的 `userId` 必填。为了隔离长期画像和会话记忆，每条 case 使用唯一且稳定的 `userId / sessionId`。

### 整表快速创建与异步执行

```
POST /test-suite/batches/quick-create
```

该端点从预配置飞书 `测试集 / 验证集` 整表导入并提交队列，适合正式全表回归。它没有 priority/category/sourceType 子集过滤；不要用它运行本轮少量定向 case。返回后再轮询进度。

### 查询批次进度

```
GET /test-suite/batches/:id/progress
GET /test-suite/batches/:id/stats
GET /test-suite/batches/:id/failure-stats
```

### 查看执行记录

```
GET /test-suite/batches/:id/executions
GET /test-suite/executions/:id
```

## 正式数据集导入

### 导入 `测试集`（策展后的 scenario cases）

```
POST /test-suite/datasets/scenario/import-curated
```

请求体核心结构：

```json
{
  "importNote": "2026-04-22 第一轮策展",
  "cases": [
    {
      "caseId": "SCN-20260422-001",
      "caseName": "先澄清地点再推荐岗位",
      "category": "岗位推荐问题",
      "userMessage": "附近有什么兼职",
      "chatHistory": "user: 附近有什么兼职",
      "checkpoint": "必须先问地点",
      "expectedOutput": "先确认地点，再推荐岗位",
      "sourceType": "从BadCase生成",
      "sourceBadCaseIds": ["bad_xxx"],
      "sourceGoodCaseIds": [],
      "sourceChatIds": ["chat_xxx"],
      "participantName": "候选人A",
      "managerName": "招募经理A",
      "consultTime": 1710000000000,
      "remark": "从典型误推 badcase 提炼",
      "enabled": true
    }
  ]
}
```

### 导入 `验证集`（策展后的 conversation cases）

```
POST /test-suite/datasets/conversation/import-curated
```

请求体核心结构：

```json
{
  "importNote": "2026-04-22 第一轮回归样本策展",
  "cases": [
    {
      "validationId": "VAL-20260422-001",
      "validationTitle": "真实生产对话回归样本",
      "conversation": "[04/22 10:00 候选人] 在吗\n[04/22 10:01 招募经理] 在的",
      "chatId": "chat_xxx",
      "participantName": "候选人B",
      "managerName": "招募经理B",
      "consultTime": 1712000000000,
      "sourceType": "真实生产",
      "sourceBadCaseIds": ["bad_xxx"],
      "sourceGoodCaseIds": [],
      "sourceChatIds": ["chat_xxx"],
      "remark": "保留完整上下文用于回归",
      "enabled": true
    }
  ]
}
```

返回结构：

```json
{
  "success": true,
  "data": {
    "created": 3,
    "updated": 2,
    "unchanged": 5,
    "total": 10,
    "recordIds": ["recxxx", "recyyy"]
  }
}
```

语义说明：
- 以 `caseId / validationId` 为稳定键做幂等 upsert
- payload 完全一致时记为 `unchanged`，不会重复重置测试结果
- payload 发生变化时，会把旧的 `测试状态 / 批次 / 分数` 等执行痕迹清回 `待测试`
- 系统会自动同步 `资产关联` 表，一条来源资产对应一条关联边
- 旧关联边不会直接丢失；当某来源不再属于目标资产时，会被标记为 `是否生效 = false`

## 使用原则

- 调用前先 Read 相关 DTO 文件确认契约，不要凭记忆构造请求体
- 调用时做错误处理：HTTP 非 2xx 就把返回值给用户看，不要静默失败
- 轮询进度时给个合理上限（比如 60 次 × 5s），不要死循环
- 导入正式数据集后，只有确实要跑整张正式表时才调用 `POST /test-suite/batches/quick-create`；本轮定向子集继续使用 `POST /test-suite/batch`
- `测试集` 走 `testType: "scenario"`，`验证集` 走 `testType: "conversation"`

## 测试结果同步到生产 Dashboard

策展批次在测试环境执行、评审完成后，使用仓库脚本复制已有结果：

```bash
pnpm sync:test-suite:prod -- <batch-id> [batch-id...]
```

该命令读取 `.env.local` 和 `.env.production`，按原 ID upsert：

- `test_batches`
- `test_executions`
- `test_conversation_snapshots`

它不会执行批次、不会调用模型、不会发送消息，也不会把 case 导入飞书正式测试集。运行前应先把 `review_status / review_comment / failure_reason` 写入测试环境；如果评审发生在同步之后，需要再次运行同一命令幂等覆盖生产记录。

成功条件：

- 输出 `warnings: []`
- `synced.testBatches` 等于目标批次数
- `production.executionCount` 等于目标批次执行记录总数
- 生产 API 能按每个 batch ID 查到相同名称、状态和统计
- `GET /test-suite/batches/:id/executions` 的记录数与评审状态分布一致
- 抽查 `GET /test-suite/executions/:id` 能看到实际回复、工具调用、执行 trace 与评审备注

线上查看入口：`https://cake.duliday.com/web/test-suite`。

不要使用生产 `/test-suite/batch` 或 `/batches/quick-create` 来“同步”结果；这两个端点会产生新的执行，造成重复模型调用和不同版本结果。
