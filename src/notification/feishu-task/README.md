# 飞书人工介入任务

总部任务沿用应用身份创建并分配。河南任务由应用身份创建到独立清单，再以已授权的内部委派人身份添加外部联系人为负责人。负责人来自托管账号的飞书绑定；缺少绑定或授权时停止派单并告警，不回落到总部负责人。

## 用户授权配置

- `HENAN_FEISHU_TASK_TASKLIST_GUID`：河南清单，必须与总部清单不同。
- `FEISHU_TASK_DELEGATOR_OPEN_ID`：完成 OAuth 授权的内部委派人。
- `FEISHU_TASK_DELEGATOR_ENCRYPTION_KEY`：32 字节随机值的 Base64，仅保存在服务端私有环境配置。
- 复用 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 和 Redis 配置。

委派人须能编辑河南清单、与外部负责人建立联系人关系，并本人授权 `task:task:write` 和 `offline_access`。用户授权仅用于河南任务分配；应用身份继续负责建任务及既有总部业务。

凭据通过 AES-256-GCM 加密存入 Redis，无自动过期；密文绑定环境、应用与委派人。运行时使用 `RUNTIME_ENV`，其次 `NODE_ENV`，默认 `development` 作为 Redis 前缀。不得把生产凭据复制到测试环境或提交 Git。

在仓库根目录、安装开发依赖的受控工作站执行首次导入：

```sh
node scripts/feishu-task-delegator.cjs --env-file .env.production --environment production --action install --credentials-file /private/path/authorized-user.json
node scripts/feishu-task-delegator.cjs --env-file .env.production --environment production --action check
```

输入 JSON 包含 `appId`、`expectedOpenId`、`access_token`、`refresh_token`、`obtainedAt`（毫秒）、`expires_in`、`refresh_token_expires_in`（秒）及 `scope`。导入会在线核验用户身份，且拒绝覆盖已有凭据。脚本只输出状态，不输出密钥。首次导入后 Redis 是唯一运行时凭据来源；不要再用旧本地文件单独刷新授权。

## 刷新与失败恢复

每 15 分钟检查一次授权，派单前也检查；访问凭据不足 5 分钟有效期时刷新。刷新使用 Redis 互斥锁，先保存待确认标记，收到新凭据并核验身份后才原子更新。

刷新请求超时或刷新后无法保存时，旧刷新凭据可能已被消耗。程序保留待确认标记，停止自动重放刷新并发出授权告警。恢复步骤：暂停使用该委派人的服务实例；保留当前密文以供排查；由同一委派人重新授权；核对环境及身份后，由运维仅移除对应的 `<environment>:feishu:task-delegator:<appId>:<openId>` 记录并运行首次导入；检查成功后恢复服务。不要清空 Redis、改写其他环境或把旧刷新凭据再次导入。服务长时间停机导致授权过期也按此流程恢复。

## 队列与重复请求

任务创建前冻结清单、负责人及委派人；创建成功先保存任务 GUID，再分配负责人。分配失败会按既有队列策略退避重试同一任务。重试耗尽交由后台告警处理，可核对已有任务后重试对应队列任务，不应另建任务。

创建请求结果不确定或 GUID 保存失败时停止自动创建，需人工对账。分配已经成功但队列完成状态保存失败时，只重复同一任务的添加负责人操作。已存在 GUID 且没有新分配状态的旧队列任务不会被补派给其他人。更换委派人后，旧队列中冻结的身份不匹配会报错，须先核对再处理。
