# 群任务通知流水线

群任务定时通知系统，自动向企微群推送业务消息（抢单、兼职岗位、店长通知、工作小贴士）。

## 流水线概览

```
┌─────────────────────────────────────────────────────┐
│                    Cron 触发                         │
│  抢单群: 10:00 / 13:00 / 17:30 (每天)               │
│  兼职群: 13:00 (工作日)                              │
│  店长群: 10:30 (工作日)                              │
│  工作小贴士: 15:00 (周六)                            │
└──────────────────────┬──────────────────────────────┘
                       ▼
         GroupTaskSchedulerService.executeTask()
                       │
           ┌───────────┼────────────┐
           │     前置检查            │
           │  ① enabled 开关        │
           │  ② Redis 分布式锁      │
           │  ③ 非生产环境跳过 Cron  │
           └───────────┬────────────┘
                       ▼
         ┌─ GroupResolverService.resolveGroups(tagPrefix) ─┐
         │  遍历所有小组 token → /stream-api/room/simpleList │
         │  解析 labels → 按 tagPrefix 筛选                  │
         │  10 分钟内存缓存 + stampede 防护                   │
         └───────────────────┬─────────────────────────────┘
                             ▼
              按 (城市 + 行业) 分组
         如: 上海_餐饮(3群), 武汉(2群)
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         每个分组独立处理（同组共享数据 + 文案）
              │
              ├─ ① strategy.fetchData(代表群)
              │     拉取外部数据（BI 订单/岗位/小贴士）
              │
              ├─ ② 生成消息
              │     模板策略 → buildMessage()    (抢单/兼职/店长)
              │     AI 策略  → buildPrompt()     (工作小贴士)
              │               → LlmExecutorService.generateSimple()
              │               → appendFooter()（可选）
              │
              ├─ ③ 同组所有群发送相同消息
              │     NotificationSenderService.sendToGroup()
              │       → 企业级 API (imBotId + imRoomId)
              │       → 兼职群额外发小程序卡片
              │       → 发送前做人类化随机延时
              │       → 群与群之间继续做人类化间隔
              │
              └─ ④ 兼职群记录品牌轮转 (BrandRotationService)
                             │
                             ▼
              NotificationSenderService.reportToFeishu()
              飞书卡片汇报：成功/失败/跳过 + 分组详情
              └─ dryRun 模式：只发飞书预览，不发企微
```

## 四种策略

| 类型 | tagPrefix | 策略类 | 数据源 | 生成方式 |
|------|-----------|--------|--------|----------|
| 抢单群 | `抢单群` | `OrderGrabStrategy` | BI 订单 | 模板 |
| 兼职群 | `兼职群` | `PartTimeJobStrategy` | 岗位列表 | 模板 + 小程序卡片 |
| 店长群 | `店长群` | `StoreManagerStrategy` | BI 数据 | 模板 |
| 工作小贴士 | `店长群` | `WorkTipsStrategy` | 预设话题 | AI 生成 |

## 关键机制

### Redis 分布式锁

防止多实例重复执行，TTL 5 分钟，owner token 保证安全释放（Lua 脚本原子操作）。

### 分组共享

同城市同行业的群只拉一次数据、生成一次文案，N 群复用。例如 5 个"兼职群_上海_餐饮"只拉一次岗位数据、生成一次消息文本，发 5 个群。

### dryRun 模式

DB 开关控制（`system_config` 表），试运行只发飞书预览不发企微。手动触发时可通过 `forceSend` 绕过。

### 环境隔离

非生产环境自动禁用 Cron，仅支持手动触发：

```bash
POST /group-task/trigger/:type
# type: order_grab | part_time | store_manager | work_tips
```

### 品牌轮转（兼职群）

`BrandRotationService` 记录每个群已推送过的品牌，下次推送自动轮转到新品牌，避免重复。

## 核心文件

| 文件 | 职责 |
|------|------|
| `src/biz/group-task/services/group-task-scheduler.service.ts` | Cron 调度 + 核心编排 |
| `src/biz/group-task/services/group-resolver.service.ts` | 群列表获取 + 标签解析 + 缓存 |
| `src/biz/group-task/services/notification-sender.service.ts` | 企微发送 + 飞书汇报 |
| `src/biz/group-task/services/brand-rotation.service.ts` | 品牌轮转记录 |
| `src/biz/group-task/strategies/notification.strategy.ts` | 策略接口定义 |
| `src/biz/group-task/strategies/*.strategy.ts` | 四种策略实现 |
| `src/biz/group-task/group-task.controller.ts` | 手动触发 + 测试端点 |
| `src/biz/group-task/group-task.types.ts` | 类型定义 |

## 配置项

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `GROUP_TASK_TOKENS` | - | 小组 token 映射（格式: `名称:token,名称:token`） |
| `GROUP_TASK_SEND_DELAY_MS` | `60000` | 群任务发送基础间隔（ms，实际会做人类化随机抖动） |
| `GROUP_MEMBER_LIMIT` | `200` | 群成员上限（invite_to_group 容量判断） |
| `STRIDE_ENTERPRISE_TOKEN` | - | 企业级 API token（拉人进群用） |
| `MINIPROGRAM_APPID` | - | 小程序 appid（兼职群卡片） |
| `MINIPROGRAM_USERNAME` | - | 小程序 username |
| `MINIPROGRAM_THUMB_URL` | - | 小程序封面图 URL |
