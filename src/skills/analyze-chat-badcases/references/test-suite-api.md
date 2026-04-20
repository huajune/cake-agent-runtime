# test-suite API 速查

导入测试集 + 跑测试时要调用的 HTTP 端点。完整实现见 `src/biz/test-suite/test-suite.controller.ts`。

## 默认连接方式

**本地 dev server**（推荐）：`http://localhost:8585`

如需打生产：从 `.env.production` 临时读 `API_GUARD_TOKEN`，加 `Authorization: Bearer <token>`。**不要把 token 落进任何文件。**

## 常用端点

### 创建批次 + 测试用例

```
POST /test-suite/batches
```

请求体契约参考 `src/biz/test-suite/dto/` 下的 `*.dto.ts`。Claude 在调用前先 Read 这些 DTO 文件，按照它们的字段结构构造请求。

### 执行批次

```
POST /test-suite/batch
```

触发批次执行（异步）。返回后通过下方查询端点轮询进度。

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

## 使用原则

- 调用前先 Read 相关 DTO 文件确认契约，不要凭记忆构造请求体
- 调用时做错误处理：HTTP 非 2xx 就把返回值给用户看，不要静默失败
- 轮询进度时给个合理上限（比如 60 次 × 5s），不要死循环
