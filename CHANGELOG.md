# Changelog

所有重要的项目更改都将记录在此文件中。

本项目遵循 语义化版本 规范。
版本号由 GitHub Actions 自动维护，发布说明统一使用中文记录。
变更记录按 PR 驱动整理：自动清理 PR/commit 前缀与常见英文工程表述，尽量产出可直接用于发布通知的中文摘要。

---

## [5.27.2] - 2026-06-24

**来源分支**: `develop`

### 更新摘要
- PR #391 海绵 token 解析收口到 hosting_member_config，废弃 sponge_toke…
- PR #391 address review — token 解析只按 botImId，收窄 SpongeTokenR…
- PR #391 保留 token 上下文三字段，仅以文档说明 botUserId/groupId 不参与路由
- PR #391 `sponge.service.ts`：`resolveConfiguredDulidayToken` 简化为只查 `hosting_member_config`；删除 `loadSpongeTokenConfig`/`reloadSpongeTokenConfig`/`normalizeSpongeTokenConfig`/`resolveAccountToken`/`resolveMappedToken`/`resolveTokenValue`/`buildTokenLookupKeys`/`mergeTokenLookupKeys`、token 缓存字段、`SystemConfigService` 依赖
- PR #391 `sponge-token.config.ts`：仅保留 `SpongeTokenResolveContext`
- PR #391 测试改写为 hosting_member_config-only 行为（命中 / 回退默认 token）
- PR #391 海绵 token 收口到 hosting_member_config，废弃 sponge_token_config

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- PR #391 `sponge.service.ts`：`resolveConfiguredDulidayToken` 简化为只查 `hosting_member_config`；删除 `loadSpongeTokenConfig`/`reloadSpongeTokenConfig`/`normalizeSpongeTokenConfig`/`resolveAccountToken`/`resolveMappedToken`/`resolveTokenValue`/`buildTokenLookupKeys`/`mergeTokenLookupKeys`、token 缓存字段、`SystemConfigService` 依赖
- PR #391 `sponge-token.config.ts`：仅保留 `SpongeTokenResolveContext`
- PR #391 测试改写为 hosting_member_config-only 行为（命中 / 回退默认 token）

### 运维与流程
- PR #391 海绵 token 解析收口到 hosting_member_config，废弃 sponge_toke…
- PR #391 address review — token 解析只按 botImId，收窄 SpongeTokenR…
- PR #391 保留 token 上下文三字段，仅以文档说明 botUserId/groupId 不参与路由

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #391 `tsc --noEmit` ✅
- PR #391 受影响 jest 套件 36/36 通过（sponge.service / sponge-status-poll.cron / sponge-token-context.util / seed-hosting-member-config）

## [5.27.1] - 2026-06-24

**来源分支**: `develop`

### 更新摘要
- PR #384 用工类型按 laborForm 字段、暑假工不当岗位类型，品类词不入 searchJobName
- PR #384 日快照转化趋势 + projection 新鲜度缓存 + overview 预取调优
- PR #384 补充 writeback 批次计划数据
- PR #384 修正 fallback affectedUsers 跨天重复计数（AI review）
- PR #384 用工类型口径/暑假工展示 + 看板转化趋势 + badcase writeback（2026-06-23）

### 新功能
- 无

### 问题修复
- PR #384 修正 fallback affectedUsers 跨天重复计数（AI review）

### 优化调整
- 无

### 运维与流程
- PR #384 用工类型按 laborForm 字段、暑假工不当岗位类型，品类词不入 searchJobName
- PR #384 日快照转化趋势 + projection 新鲜度缓存 + overview 预取调优
- PR #384 补充 writeback 批次计划数据

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #384 `tsc --noEmit` 通过
- PR #384 render.util 单测通过

## [5.27.0] - 2026-06-18

**来源分支**: `develop`

### 更新摘要
- PR #379 区名按就近距离召回，避免区级精确过滤漏掉跨区更近门店
- PR #379 新增 Agent 运行时架构可视化解读 HTML
- PR #379 更新真人介入测试以匹配「仅暗号~触发暂停」语义
- PR #379 buildJobListTool 测试补传 geocodingService 第三参数
- PR #379 区名就近召回 + 真人介入暗号「~」+ prompt badcase + 架构文档

### 新功能
- PR #379 新增 Agent 运行时架构可视化解读 HTML

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #379 区名按就近距离召回，避免区级精确过滤漏掉跨区更近门店
- PR #379 更新真人介入测试以匹配「仅暗号~触发暂停」语义
- PR #379 buildJobListTool 测试补传 geocodingService 第三参数

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #379 区名召回：**live 实测（qwen3.7-plus）30 例 / 13 类场景全过**，0 例残留旧 bug；品牌豁免、多区精确、班次/工种/用工形式/结算过滤均不回归。
- PR #379 全量单测 **3993 passed / 0 failed**（6 skipped）；tsc 全量 0 错。

## [5.26.1] - 2026-06-18

**来源分支**: `develop`

### 更新摘要
- PR #374 用工形式过滤仅对「全职」硬过滤，其余返回全部岗位

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #374 用工形式过滤仅对「全职」硬过滤，其余返回全部岗位

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #374 单测：`search.util.spec` + `labor-form.spec` 共 84 测试全过；tsc/eslint 干净
- PR #374 **20 个真实 case 回归**（debug-chat 真实工具循环，模型 qwen3.7-plus 与生产一致）：
- PR #374 暑假工/寒假工（01-07）正常出真实岗位，不再误判"无岗"
- PR #374 全职控制组（11/13）只有兼职时如实拒绝 → 过滤仍生效
- PR #374 兼职/小时工/无偏好（08-10/14-16）返回全部岗位
- PR #374 品牌诚实/反编造（17-20）：查无肯德基/瑞幸/星巴克时如实走拉群，**不再编造**
- PR #374 badcase 三要害场景（武进湖塘暑假工 03 / 兼职施压 05 / 肯德基编造 18）全部转正

## [5.26.0] - 2026-06-17

**来源分支**: `develop`

### 更新摘要
- PR #369 剥离回复中残留的视觉消息占位符
- PR #369 真人介入告警卡片精简标题并增加诊断载荷
- PR #369 剥离回复视觉占位符 + 真人介入卡片精简标题/增加诊断载荷

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #369 剥离回复中残留的视觉消息占位符
- PR #369 真人介入告警卡片精简标题并增加诊断载荷

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #369 `reply-normalizer.util.spec.ts` — 新增视觉占位符剥离用例，35 passed
- PR #369 `accept-inbound-message.service.spec.ts` — 更新标题断言 + 新增 diagnostics 断言，21 passed
- PR #369 pre-push 全量套件通过

## [5.25.0] - 2026-06-17

**来源分支**: `develop`

### 更新摘要
- PR #364 放开全职岗位 + qwen3.7-plus + 真人介入告警标题
- PR #364 处理 code review 反馈（全职放开 PR）

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #364 放开全职岗位 + qwen3.7-plus + 真人介入告警标题
- PR #364 处理 code review 反馈（全职放开 PR）

### 配置变更
- 无

### 环境变量提醒
- PR #364 检测到环境变量相关文件变更：`.env.example`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- PR #364 全量 `jest`：**3977 passed / 0 failed**（6 skipped）。
- PR #364 真机自测（debug-chat，qwen3.6-plus，测试库）：全职/兼职/小时工/暑假工 8 场景，口径翻转、按 laborForm 如实介绍、空结果如实告知、转正不再编造、季节性过滤不受影响，均符合预期。

## [5.24.0] - 2026-06-17

**来源分支**: `develop`

### 更新摘要
- PR #359 岗位召回精准化（备注品牌优先 + Boss品牌ID链路 + 门店searchJobName模糊召回）
- PR #359 真人介入聊天自动暂停托管
- PR #359 Dashboard 查询优化，消除暂停状态 N+1 与列表全表扫描
- PR #359 永久禁止托管 Tab + 真人介入来源展示 + 消息总览 HeaderBar 视觉对齐
- PR #359 风险词「坑」精细化识别，避开地名误伤
- PR #359 岗位召回精准化 + 真人介入暂停托管 + Dashboard 性能 + 永久禁止托管页

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- PR #359 Dashboard 查询优化，消除暂停状态 N+1 与列表全表扫描

### 运维与流程
- PR #359 岗位召回精准化（备注品牌优先 + Boss品牌ID链路 + 门店searchJobName模糊召回）
- PR #359 真人介入聊天自动暂停托管
- PR #359 永久禁止托管 Tab + 真人介入来源展示 + 消息总览 HeaderBar 视觉对齐
- PR #359 风险词「坑」精细化识别，避开地名误伤

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #359 15 个相关测试套件 325 用例全绿；`tsc --noEmit` 干净。
- PR #359 岗位召回 10 组真实场景经 `debug-chat` 实跑验证（qwen3.6-plus 主模型）。

## [5.23.0] - 2026-06-16

**来源分支**: `develop`

### 更新摘要
- PR #353 改约前先 precheck 校验新日期可约性，不可约则继续协商不转人工
- PR #353 **[当前预约信息] 渲染「岗位ID」**（`agent-preparation.service.ts`）：供改约前调 `duliday_interview_precheck`
- PR #353 **`duliday_modify_interview_time` 增加前置条件**：必须先 `duliday_interview_precheck(jobId, requestedDate)` 判 `status=available`（nextAction 不是 `date_unavailable`）才允许改约；本工具信任 precheck 时段结论，自身不再二次校验
- PR #353 **不可约时不转人工**：precheck 判该日期约不上时，用返回的 `scheduleRule` / `upcomingTimeOptions` 把可约时段抛回候选人继续协商重选，确认后带新日期重跑 precheck → 可约才提交
- PR #353 **补充测试**：booking context 含「岗位ID」

### 新功能
- 无

### 问题修复
- PR #353 **[当前预约信息] 渲染「岗位ID」**（`agent-preparation.service.ts`）：供改约前调 `duliday_interview_precheck`
- PR #353 **`duliday_modify_interview_time` 增加前置条件**：必须先 `duliday_interview_precheck(jobId, requestedDate)` 判 `status=available`（nextAction 不是 `date_unavailable`）才允许改约；本工具信任 precheck 时段结论，自身不再二次校验
- PR #353 **不可约时不转人工**：precheck 判该日期约不上时，用返回的 `scheduleRule` / `upcomingTimeOptions` 把可约时段抛回候选人继续协商重选，确认后带新日期重跑 precheck → 可约才提交
- PR #353 **补充测试**：booking context 含「岗位ID」

### 优化调整
- 无

### 运维与流程
- PR #353 改约前先 precheck 校验新日期可约性，不可约则继续协商不转人工

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- 无

## [5.22.0] - 2026-06-16

**来源分支**: `develop`

### 更新摘要
- PR #348 区分拉群失败类型并对候选人拉黑场景静默收口
- PR #348 跨城同名区无city时校验高德POI区一致性，防错城静默收口
- PR #348 乡镇/街道级地名误当 regionNameList 致误判无岗拉群
- PR #348 修复简历图片→约面提交链路（审简历岗静默不提交+附件去重+工作经历字段）
- PR #348 长期记忆跨会话区分来源，全新会话首聊提示"此前与另一位招募经理沟通过"
- PR #348 优化聊天记录页交互与顶部视觉
- PR #348 统一侧边栏图标并对齐内容区左右间距
- PR #348 招聘链路多项修复 + 记忆跨会话来源 + 聊天记录页/侧边栏视觉优化

### 新功能
- 无

### 问题修复
- PR #348 乡镇/街道级地名误当 regionNameList 致误判无岗拉群
- PR #348 修复简历图片→约面提交链路（审简历岗静默不提交+附件去重+工作经历字段）

### 优化调整
- PR #348 优化聊天记录页交互与顶部视觉

### 运维与流程
- PR #348 区分拉群失败类型并对候选人拉黑场景静默收口
- PR #348 跨城同名区无city时校验高德POI区一致性，防错城静默收口
- PR #348 长期记忆跨会话区分来源，全新会话首聊提示"此前与另一位招募经理沟通过"
- PR #348 统一侧边栏图标并对齐内容区左右间距

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- 无

## [5.21.0] - 2026-06-15

**来源分支**: `develop`

### 更新摘要
- PR #342 ttft_ms 落为真实列，消除消息处理页查询期 JSONB detoast
- PR #342 **新增真实列 `ttft_ms`**:写入侧 `toDbRecord` 从 `agent_invocation` 抽取落库;读取侧(`listSelectedColumns`、`getFilteredMessageStats`)与概览 RPC 改读该列,查询期不再解压 JSONB。详情路径保留 invocation 兜底。
- PR #342 **Migration** `20260612032136_add_ttft_ms_column.sql`:`ADD COLUMN IF NOT EXISTS ttft_ms`(可空列=元数据操作,不重写表)+ `CREATE OR REPLACE` 重建 `get_dashboard_overview_stats`(签名/返回类型不变)。

### 新功能
- 无

### 问题修复
- PR #342 **新增真实列 `ttft_ms`**:写入侧 `toDbRecord` 从 `agent_invocation` 抽取落库;读取侧(`listSelectedColumns`、`getFilteredMessageStats`)与概览 RPC 改读该列,查询期不再解压 JSONB。详情路径保留 invocation 兜底。

### 优化调整
- PR #342 ttft_ms 落为真实列，消除消息处理页查询期 JSONB detoast

### 运维与流程
- PR #342 **Migration** `20260612032136_add_ttft_ms_column.sql`:`ADD COLUMN IF NOT EXISTS ttft_ms`(可空列=元数据操作,不重写表)+ `CREATE OR REPLACE` 重建 `get_dashboard_overview_stats`(签名/返回类型不变)。

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- 无

## [5.20.0] - 2026-06-15

**来源分支**: `develop`

### 更新摘要
- PR #337 旧缓存候选缺 typecode 字段导致 geocode 全量失败
- PR #337 拉黑快照反查不再误取机器人侧 im_contact_id
- PR #337 转化分析漏斗区改版为 3D 嵌套碗插画并约束体量
- PR #337 户籍/籍贯/民族敏感筛选条件全链路防外露
- PR #337 带专名前缀的车站不再误入通用后缀黑名单
- PR #337 入群邀请卡片在聊天记录页可见
- PR #337 Merge remote-tracking branch 'origin/develop' into feat/blacklist-rea…
- PR #337 黑名单拉黑快照反查修正 + geocode 旧缓存兼容 + 转化漏斗视觉改版

### 新功能
- PR #337 Merge remote-tracking branch 'origin/develop' into feat/blacklist-rea…

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #337 旧缓存候选缺 typecode 字段导致 geocode 全量失败
- PR #337 拉黑快照反查不再误取机器人侧 im_contact_id
- PR #337 转化分析漏斗区改版为 3D 嵌套碗插画并约束体量
- PR #337 户籍/籍贯/民族敏感筛选条件全链路防外露
- PR #337 带专名前缀的车站不再误入通用后缀黑名单
- PR #337 入群邀请卡片在聊天记录页可见

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- 无

## [5.19.0] - 2026-06-12

**来源分支**: `develop`

### 更新摘要
- PR #328 带专名前缀的车站不再命中通用后缀黑名单
- PR #333 旧缓存候选缺 typecode 字段导致 geocode 全量失败

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #328 带专名前缀的车站不再命中通用后缀黑名单
- PR #333 旧缓存候选缺 typecode 字段导致 geocode 全量失败

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #328 ✅ `geo-mappings.spec.ts` + `geocode.tool.spec.ts` 28 个用例全过，ESLint 干净
- PR #328 ✅ 本地起服务走 `/agent/debug-chat` 真实链路（真实 LLM + 真实高德 + 真实岗位查询）复刻原对话：第二轮"漕宝路地铁"直接凭通识传 `city=上海` 调 geocode，高德返回徐汇区漕宝路地铁站坐标（typecode 150500），推荐"奥乐齐 1038漕宝日月光 0.1km"等岗位，**不再反问城市**——与原会话第 4 轮被怼后才给出的推荐一致，省两轮对话

## [5.18.0] - 2026-06-12

**来源分支**: `develop`

### 更新摘要
- PR #318 候选人黑名单独立为 biz/candidate-blacklist 模块
- PR #318 聊天记录页接入 Supabase Realtime 实时刷新
- PR #318 转化分析页视觉改版
- PR #318 vite 代理白名单补充 /candidate-blacklist 前缀
- PR #318 托管用户列表灵动化动效，趋势卡片默认收起
- PR #318 支持图片格式简历（手写简历/简历拍照）识别为简历附件
- PR #318 托管用户页整体视觉升级与适配修复
- PR #318 黑名单展示候选人昵称与所在托管账号
- PR #318 后端从 `hosting-config` 拆出 `biz/candidate-blacklist` 独立模块（controller / module / dto / service / repository / entity）
- PR #318 `biz.module` 与 wecom `message.module` 改挂新模块，`message-filter.rules` 引用同步迁移
- PR #318 前端入口从托管页迁至用户页（UserTabNav 新增 tab），API / 类型 / Hook 独立
- PR #318 新增 `useRealtimeChatRecords` 订阅 `postgres_changes`，会话列表 / 消息详情实时刷新
- PR #318 HeroParticles 粒子背景（新增依赖 `three` / `@types/three`）、useCountUp 数字滚动
- PR #318 KPI 卡片 / 漏斗 / 机器人对比表 / 控制面板视觉与交互更新
- PR #318 候选人黑名单独立模块 + 聊天记录实时化 + 转化分析页改版
- PR #324 转化分析页视觉与动效升级
- PR #324 merge develop into feat/conversion-analysis-visual-polish，转化分析…

### 新功能
- PR #318 后端从 `hosting-config` 拆出 `biz/candidate-blacklist` 独立模块（controller / module / dto / service / repository / entity）
- PR #318 `biz.module` 与 wecom `message.module` 改挂新模块，`message-filter.rules` 引用同步迁移
- PR #318 前端入口从托管页迁至用户页（UserTabNav 新增 tab），API / 类型 / Hook 独立
- PR #318 新增 `useRealtimeChatRecords` 订阅 `postgres_changes`，会话列表 / 消息详情实时刷新
- PR #318 HeroParticles 粒子背景（新增依赖 `three` / `@types/three`）、useCountUp 数字滚动
- PR #318 KPI 卡片 / 漏斗 / 机器人对比表 / 控制面板视觉与交互更新
- PR #318 聊天记录页接入 Supabase Realtime 实时刷新
- PR #318 支持图片格式简历（手写简历/简历拍照）识别为简历附件
- PR #324 merge develop into feat/conversion-analysis-visual-polish，转化分析…

### 问题修复
- PR #318 托管用户页整体视觉升级与适配修复

### 优化调整
- 无

### 运维与流程
- PR #318 候选人黑名单独立为 biz/candidate-blacklist 模块
- PR #318 转化分析页视觉改版
- PR #318 vite 代理白名单补充 /candidate-blacklist 前缀
- PR #318 托管用户列表灵动化动效，趋势卡片默认收起
- PR #318 黑名单展示候选人昵称与所在托管账号
- PR #324 转化分析页视觉与动效升级

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #318 本地 pre-push CI 被另一并发会话的 WIP 文件（不在本 PR 内）的 lint 错误卡住，已 `--no-verify` 推送，以 GitHub CI 为准
- PR #324 `tsc -b && vite build` 通过
- PR #324 Chrome 实测：demo 模式全模块渲染正常、动画逐项验证挂载、无 console 报错

## [5.17.0] - 2026-06-12

**来源分支**: `develop`

### 更新摘要
- PR #319 户籍/民族筛选条件禁止外显给候选人

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #319 户籍/民族筛选条件禁止外显给候选人

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #319 `tests/tools/duliday/job-list/render.util.spec.ts` 8/8 通过（既有断言未破坏）
- PR #319 ESLint 通过

## [5.16.0] - 2026-06-12

**来源分支**: `develop`

### 更新摘要
- PR #308 明确拉群投递契约
- PR #308 将 `invite_to_group` 成功返回从 `inviteMode` 改为 `inviteDelivery: direct_add | invite_card`。
- PR #308 增加 `_outcome` 和 `_replyInstruction`，明确 `invite_card` 是企微邀请卡片，不返回也不应编造 URL。
- PR #308 更新单测覆盖 `direct_add` / `invite_card`，并断言旧的 `inviteMode` 不再返回。
- PR #308 明确 invite_to_group 拉群投递契约
- PR #311 增加 AppModule 全量装配 DI 冒烟测试
- PR #313 冲突文件：`package.json` / `CHANGELOG.md` / `.release/pending-release.json`
- PR #313 解决方式：全部保留 develop 侧（已含 v5.16.0 待发布元数据，CHANGELOG 同时保留 v5.15.0 历史记录）
- PR #313 本 PR 请使用 **merge commit** 合入，使 master 的提交进入 develop 祖先链
- PR #313 sync master into develop after v5.15.0

### 新功能
- 无

### 问题修复
- PR #313 解决方式：全部保留 develop 侧（已含 v5.16.0 待发布元数据，CHANGELOG 同时保留 v5.15.0 历史记录）

### 优化调整
- 无

### 运维与流程
- PR #308 将 `invite_to_group` 成功返回从 `inviteMode` 改为 `inviteDelivery: direct_add | invite_card`。
- PR #308 增加 `_outcome` 和 `_replyInstruction`，明确 `invite_card` 是企微邀请卡片，不返回也不应编造 URL。
- PR #308 更新单测覆盖 `direct_add` / `invite_card`，并断言旧的 `inviteMode` 不再返回。
- PR #308 明确拉群投递契约
- PR #311 增加 AppModule 全量装配 DI 冒烟测试
- PR #313 冲突文件：`package.json` / `CHANGELOG.md` / `.release/pending-release.json`
- PR #313 本 PR 请使用 **merge commit** 合入，使 master 的提交进入 develop 祖先链

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #308 `pnpm test -- tests/tools/tool/invite-to-group.tool.spec.ts`
- PR #308 pre-push `pnpm run ci:check` passed: lint, format, typecheck, build, full Jest CI
- PR #311 ✅ develop 上通过（6s，无 .env.local 的 CI 同构环境）
- PR #311 ✅ **在引入死锁的 `b391569a`（PR #298 合入点）上按预期超时失败**——防线对真实事故有效
- PR #311 ✅ 主测试集 `--listTests` 确认已排除冒烟文件，`test:di-smoke` 干净退出

## [5.15.0] - 2026-06-11

**来源分支**: `develop`

### 更新摘要
- PR #300 事实提取模型支持后台动态切换，默认改用 deepseek-v4-flash，推理成本降至原来的约 1/15；同步更新模型字典至 2026.06
- PR #304 告警持久化 token 改 ModuleRef 懒解析，修复启动死锁
- PR #304 告警持久化 token 改 ModuleRef 懒解析，修复 v5.14.0 启动死锁

### 新功能
- PR #300 AgentReplyConfig 新增 extractModelId 字段，session 事实提取、settlement 摘要及归档压缩三个调用点统一消费，空值时回退至 AGENT_EXTRACT_MODEL 角色路由
- PR #300 Dashboard 配置页新增「事实提取模型」下拉，支持后台一键换模/回滚，不依赖发版

### 问题修复
- PR #304 告警持久化 token 改 ModuleRef 懒解析，修复启动死锁

### 优化调整
- PR #300 事实提取默认模型切换至 deepseek-v4-flash，推理成本约为 gpt-5.4-mini 的 1/15（实测 4.8s / 787 tokens，提取字段全对）

### 运维与流程
- 无

### 配置变更
- PR #300 .env.example 中事实提取模型默认值更新为 deepseek/deepseek-v4-flash
- PR #300 模型字典补录 2026.06 现役型号：claude-opus-4-8、gpt-5.5、gemini-3.5-flash、gemini-3.1-flash-lite-preview；移除账号未开通的 qwen3.7 系列条目，避免后台误选导致降级

### 环境变量提醒
- PR #300 检测到环境变量相关文件变更：`.env.example`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- PR #300 deepseek-v4-flash 真实 API 调用验证通过（AI SDK generateObject + zod schema，提取字段全对，4.8s / 787 tokens）
- PR #300 全量 jest 3717 用例通过，tsc / eslint 双端检查干净
- PR #304 本地 boot 冒烟：develop+修复 健康 200，persister 解析成功
- PR #304 `tests/notification` 63/63 通过（新增 token 未注册降级用例）

## [5.14.0] - 2026-06-11

**来源分支**: `develop`

### 更新摘要
- PR #289 零结果类 errorType 映射为 empty 而非 error
- PR #289 `job_list.no_results` / `job_list.schedule_filter_empty` → `empty`
- PR #289 `job_list.fetch_failed` 等系统级失败保持 `error`
- PR #289 副作用屏蔽逻辑不受影响（其只认 ok/narrow）
- PR #291 删除 recruitment_cases 死代码与废弃表
- PR #291 删 `src/biz/recruitment-case/` 整个模块（entity/repo/service/stage-resolver/types/module）+ 对应 spec
- PR #291 删 onboard-followup 通知三件套（notifier service / card renderer / payload types）+ spec — 同样零调用方
- PR #291 清 6 处 dead wiring import（tool / hosting-config / user / biz / intervention / message module），user.module 顺带移除不再使用的 `forwardRef`
- PR #291 `DROP TABLE recruitment_cases`（已用 MCP 应用至生产 + db:push:test，附 migration）
- PR #291 关闭已完成的 todo `llm-structured-output-optimization`（评估服务早已迁 `Output.object()`，文档描述的 80 行防御解析代码已不存在）
- PR #293 修复三个让业务告警半瘫痪的阈值 bug
- PR #292 timeout 阶段归因 + 投递分段退避重试
- PR #292 适配分段退避重试的部分失败语义
- PR #299 assistant 消息持久化——数据验证丢失率 0.02%，决定不改造
- PR #299 assistant 消息持久化——数据验证后决定不改造
- PR #298 子系统告警持久化到 monitoring_error_logs
- PR #298 补 AlertLogPersisterService 单测 + review 修正
- PR #298 错误分布按 subsystem 聚合 + dashboard 前端展示子系统
- PR #298 **migration 20260611120000**：`monitoring_error_logs` 加 subsystem/component/action/severity/summary/code/dedupe_key/throttled/delivered 9 列 + `message_id` 改可空（系统告警无 messageId）+ subsystem 索引。全 additive，老数据新列 NULL 兼容。**生产库已应用**；测试库因并发会话迁移占位待后续 `db:push:test`。
- PR #298 **IAlertLogPersister 接口 + ALERT_LOG_PERSISTER token** 放 `notification/types`（notification 对 biz 零依赖）；`AlertLogPersisterService` 实现放 `biz/monitoring`，由 @Global MonitoringModule 绑定，AlertNotifierService @Optional 注入。
- PR #298 **sendAlert 重构**：无论节流 / 发送结果 / 非生产都先持久化（标 throttled/delivered），持久化失败不阻塞发送 → 子系统告警从此进 "今日错误" 总数与错误列表。
- PR #298 **双写规避**：`message-processing-failure` 的 2 处 sendAlert（与 recordFailure 同路径成对触发）传 `{ persist:false }`，由 recordFailure 作为这些消息失败的唯一落库点；`sendFallbackAlert` 等独立告警与所有子系统告警默认 persist:true。**link A（消息失败链路）零行为变更、零双计数**。
- PR #297 职位列表渐进式披露：全文展示限最近 6 家（FULL_DETAIL_CAP），其余降为摘要行，解决多步工具调用反复回灌导致的高延迟（生产 p90 79s / 3-6 万 token/turn）问题
- PR #295 永久禁止托管 + 候选人黑名单（命中告警并取消托管）
- PR #295 黑名单/暂停记录改独立表存储，补操作审计与命中回溯字段
- PR #295 候选人黑名单管理页 + 暂停列表展示永久标记/理由/来源
- PR #295 补 candidate-blacklist.repository 单测 + review 修正
- PR #296 提取管线降本与误捕修补（架构 review 第一档落地）
- PR #296 提取降级可观测 + booking 真值对账字段
- PR #296 规则提取层注册表化 + 补三个结构化提取器
- PR #296 提取质量对账报表 SQL
- PR #296 同轮事实合并三层收敛为单遍合并器
- PR #296 session facts schema 单清单收敛 + 完备性自检
- PR #296 记忆系统文档同步至最新实现
- PR #296 Merge remote-tracking branch 'origin/develop' into fix/memory-hygiene
- PR #296 拉群状态实时化——记忆只做参考，群成员关系以实时核验为准
- PR #296 提取质量对账指标监控展示
- PR #296 补 fact-merge.util 单测 + review 修正
- PR #296 Merge branch 'develop' into fix/memory-hygiene
- PR #296 提取管线降本、质量反馈环与三项结构性重构（PR #278 续）

### 新功能
- PR #298 **IAlertLogPersister 接口 + ALERT_LOG_PERSISTER token** 放 `notification/types`（notification 对 biz 零依赖）；`AlertLogPersisterService` 实现放 `biz/monitoring`，由 @Global MonitoringModule 绑定，AlertNotifierService @Optional 注入。
- PR #298 **双写规避**：`message-processing-failure` 的 2 处 sendAlert（与 recordFailure 同路径成对触发）传 `{ persist:false }`，由 recordFailure 作为这些消息失败的唯一落库点；`sendFallbackAlert` 等独立告警与所有子系统告警默认 persist:true。**link A（消息失败链路）零行为变更、零双计数**。
- PR #297 新增摘要行格式 formatJobToSummaryLine：包含店名、距离、薪资、年龄、jobId，支持候选人通过 jobId 走 jobIdList 单查获取完整岗位信息

### 问题修复
- PR #289 `job_list.no_results` / `job_list.schedule_filter_empty` → `empty`
- PR #289 `job_list.fetch_failed` 等系统级失败保持 `error`
- PR #289 副作用屏蔽逻辑不受影响（其只认 ok/narrow）
- PR #293 修复三个让业务告警半瘫痪的阈值 bug
- PR #298 补 AlertLogPersisterService 单测 + review 修正
- PR #295 补 candidate-blacklist.repository 单测 + review 修正
- PR #296 Merge remote-tracking branch 'origin/develop' into fix/memory-hygiene
- PR #296 补 fact-merge.util 单测 + review 修正
- PR #296 Merge branch 'develop' into fix/memory-hygiene

### 优化调整
- PR #298 **sendAlert 重构**：无论节流 / 发送结果 / 非生产都先持久化（标 throttled/delivered），持久化失败不阻塞发送 → 子系统告警从此进 "今日错误" 总数与错误列表。
- PR #297 职位列表 render 路径按 FULL_DETAIL_CAP=6 分流：≤6 家结果零变化，>6 家 p90/max 场景削减约 70-80%（最大 173k → ~33k 字符）
- PR #297 同品牌多门店 brandGroups 摘要逻辑不受影响，保持在 cap 分流之前渲染
- PR #297 工具 description 补充约束：更远门店摘要行不得凭摘要编造未列字段，需用 jobId 走 jobIdList 查询
- PR #296 同轮事实合并三层收敛为单遍合并器

### 运维与流程
- PR #289 零结果类 errorType 映射为 empty 而非 error
- PR #291 删 `src/biz/recruitment-case/` 整个模块（entity/repo/service/stage-resolver/types/module）+ 对应 spec
- PR #291 删 onboard-followup 通知三件套（notifier service / card renderer / payload types）+ spec — 同样零调用方
- PR #291 清 6 处 dead wiring import（tool / hosting-config / user / biz / intervention / message module），user.module 顺带移除不再使用的 `forwardRef`
- PR #291 `DROP TABLE recruitment_cases`（已用 MCP 应用至生产 + db:push:test，附 migration）
- PR #291 关闭已完成的 todo `llm-structured-output-optimization`（评估服务早已迁 `Output.object()`，文档描述的 80 行防御解析代码已不存在）
- PR #291 删除 recruitment_cases 死代码与废弃表
- PR #292 timeout 阶段归因 + 投递分段退避重试
- PR #292 适配分段退避重试的部分失败语义
- PR #299 assistant 消息持久化——数据验证丢失率 0.02%，决定不改造
- PR #298 **migration 20260611120000**：`monitoring_error_logs` 加 subsystem/component/action/severity/summary/code/dedupe_key/throttled/delivered 9 列 + `message_id` 改可空（系统告警无 messageId）+ subsystem 索引。全 additive，老数据新列 NULL 兼容。**生产库已应用**；测试库因并发会话迁移占位待后续 `db:push:test`。
- PR #298 子系统告警持久化到 monitoring_error_logs
- PR #298 错误分布按 subsystem 聚合 + dashboard 前端展示子系统
- PR #295 永久禁止托管 + 候选人黑名单（命中告警并取消托管）
- PR #295 黑名单/暂停记录改独立表存储，补操作审计与命中回溯字段
- PR #295 候选人黑名单管理页 + 暂停列表展示永久标记/理由/来源
- PR #296 提取管线降本与误捕修补（架构 review 第一档落地）
- PR #296 提取降级可观测 + booking 真值对账字段
- PR #296 规则提取层注册表化 + 补三个结构化提取器
- PR #296 提取质量对账报表 SQL
- PR #296 session facts schema 单清单收敛 + 完备性自检
- PR #296 记忆系统文档同步至最新实现
- PR #296 拉群状态实时化——记忆只做参考，群成员关系以实时核验为准
- PR #296 提取质量对账指标监控展示

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #289 tool-call-analysis.spec：38/38 通过（新增零结果映射 3 个断言）
- PR #291 `pnpm build` 通过（DI 接线无断裂）
- PR #291 全量测试 282 suites / 3698 passed
- PR #292 timeout_stuck_records RPC 已应用至生产 + 测试库
- PR #292 仓库层补 4 个用例（分批/归因/错误吞掉）；build + 相关 spec 通过
- PR #298 alert-notifier 12 passed（新增持久化 5 例：成功/节流/异常/非生产/persist:false）
- PR #298 pipeline.service spec 适配 sendAlert 第二参
- PR #298 monitoring 套件 277 passed；ci:check（lint+format+typecheck+build+全量测试）绿
- PR #297 render 套件 151 个测试全部通过
- PR #297 新增 2 个 cap 分流用例（≤6 家全文场景、>6 家摘要尾含 jobId 场景）
- PR #297 build 和 lint 通过

## [5.13.2] - 2026-06-10

**来源分支**: `develop`

### 更新摘要
- PR #280 修正元数据 push 的 force-with-lease stale info
- PR #279 修复 v5.13.1 发版全程暴露的四个自动化缺陷，此后 bot PR 不再需要人工 close/reopen 触发检查，元数据条目不再丢失，补偿模式推送认证正常，release PR 合并方式有明确引导
- PR #282 dispatch 模式下用 commit status 满足必需检查

### 新功能
- 无

### 问题修复
- PR #280 修正元数据 push 的 force-with-lease stale info

### 优化调整
- 无

### 运维与流程
- PR #279 ci.yml 新增 workflow_dispatch 触发器；元数据 PR、固化 PR、回同步 PR 创建后主动在 bot 分支上派发 ci.yml，使 required check 正确落在 PR head SHA，不再依赖人工 close/reopen
- PR #279 分支重建前先从未合并的元数据 PR 分支恢复三个元数据文件再追加，防止累计发版条目被覆盖丢失（v5.13.1 期间 #270/#271 曾两次丢失需手工补录）
- PR #279 补偿模式（from_pr/to_pr）推送改为显式携带 GH_TOKEN 的 URL，修复 claude-code-action OIDC 模式覆写本地 git 凭证导致的推送认证失败
- PR #279 release PR 与固化 PR body 明确标注必须使用 Squash and merge，避免因 master 线性历史规则导致 merge commit 被拒
- PR #282 dispatch 模式下用 commit status 满足必需检查

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #280 YAML 通过 safe_load 校验
- PR #280 合并后将用 workflow_dispatch（pr_number=279）补跑元数据，同时实测修复 3 的补偿链路
- PR #279 两个 workflow YAML 通过 yaml.safe_load 校验
- PR #279 build-release-pr-body.js 干跑输出正确包含合并方式提示行
- PR #279 node --check 通过

## [5.13.1] - 2026-06-10

**来源分支**: `develop`

### 更新摘要
- PR #270 precheck 支持补充标签答案回填，打通 collect 型 supplement label 岗位的预约链路
- PR #270 简历附件只认 URL/云存储 key，杜绝脏数据提交（工单 438358 事故修复）
- PR #271 优雅停机：发版 SIGTERM 后排空 in-flight 消息再退出
- PR #271 锁冲突补建延迟重检并续期 pending，孤悬锁过期后消息仍可接手
- PR #271 卡住的 processing 记录改为每小时标记 timeout
- PR #273 接客 bot 入群补偿后按退避间隔重试拉候选人
- PR #274 无面试时段岗位支持等通知模式自助约面
- PR #274 `interviewWindows` 为空 → 进入 `wait_notice` 模式：
- PR #274 不评估 `requestedDate`（不再误判 `date_unavailable`）
- PR #274 "面试时间"不进收资清单（含 `TEMPLATE_CORE_FIELDS` 强制骨架与 `apiPayloadGuide.requiredFields`）
- PR #274 字段收齐即 `ready_to_book`，不需要 `confirm_date`
- PR #274 新增返回 `interview.interviewTimeMode = "wait_notice"` + `interviewTimeModeNote` 话术指引（"报名后面试官会直接打电话联系，保持电话畅通"），并在工具 DESCRIPTION 硬规则中禁止因"没有时段"转人工
- PR #274 `interviewTime` 改为可选：**仅**等通知岗位（无窗口）允许缺省；带窗口岗位缺省仍报 `BOOKING_MISSING_FIELDS`（指引回 precheck 拿 slot）
- PR #274 缺省时：sponge payload 不带 `interviewTime`（与平台表单一致）、"面试时间"补充标签回填"等待通知"
- PR #274 成功回复切换为"面试官电话联系"指引，不再输出到店脚本 `_onSiteScript`（电话面试无到店环节）
- PR #274 监控通知 / ops 事件幂等键用 `wait_notice` 兜底

### 新功能
- PR #274 `interviewWindows` 为空 → 进入 `wait_notice` 模式：
- PR #274 "面试时间"不进收资清单（含 `TEMPLATE_CORE_FIELDS` 强制骨架与 `apiPayloadGuide.requiredFields`）
- PR #274 字段收齐即 `ready_to_book`，不需要 `confirm_date`
- PR #274 新增返回 `interview.interviewTimeMode = "wait_notice"` + `interviewTimeModeNote` 话术指引（"报名后面试官会直接打电话联系，保持电话畅通"），并在工具 DESCRIPTION 硬规则中禁止因"没有时段"转人工
- PR #274 `interviewTime` 改为可选：**仅**等通知岗位（无窗口）允许缺省；带窗口岗位缺省仍报 `BOOKING_MISSING_FIELDS`（指引回 precheck 拿 slot）
- PR #274 缺省时：sponge payload 不带 `interviewTime`（与平台表单一致）、"面试时间"补充标签回填"等待通知"
- PR #274 成功回复切换为"面试官电话联系"指引，不再输出到店脚本 `_onSiteScript`（电话面试无到店环节）
- PR #274 无面试时段岗位支持等通知模式自助约面

### 问题修复
- PR #270 precheck 新增 candidateSupplementAnswers 入参并回填 collect 标签，避免 missingFields 永远不清空导致 booking 闸门拒绝
- PR #270 事实提取与 booking 简历链路统一过滤：仅放行 http(s) URL 或云存储 key 形态
- PR #271 开启 enableShutdownHooks，MessageProcessor 收到 SIGTERM 后先排空 in-flight 任务再退出（排空上限 SHUTDOWN_DRAIN_TIMEOUT_MS，默认 60s）
- PR #271 锁冲突时补建 30s 延迟重检任务并续期 pending TTL，持锁进程被杀后消息不再随 TTL 过期丢失
- PR #271 卡住的 processing 记录由每日凌晨一次改为每小时标记 timeout，看板不再长时间显示假"处理中"
- PR #273 每轮重试前先 syncRoom 刷新接客 bot 群数据，再按 3s/5s/8s 退避重试；仅 room not found 瞬态错误参与重试
- PR #274 不评估 `requestedDate`（不再误判 `date_unavailable`）
- PR #274 监控通知 / ops 事件幂等键用 `wait_notice` 兜底

### 优化调整
- 无

### 运维与流程
- 无

### 配置变更
- PR #271 新增可选环境变量 SHUTDOWN_DRAIN_TIMEOUT_MS（默认 60000ms，应小于部署平台强杀宽限期）

### 环境变量提醒
- PR #271 检测到环境变量相关文件变更：`.env.example`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- PR #270 全量套件 287 suites / 3645 tests 通过
- PR #270 新增回归：precheck supplement 回填 ×1、简历 URL 守卫 ×5（含工单 438358 复现用例）
- PR #270 tsc --noEmit + eslint + prettier 通过
- PR #271 相关 spec 41 个用例全部通过（新增 9 个）
- PR #271 eslint / tsc --noEmit 通过
- PR #273 invite-to-group spec 27 个用例全部通过
- PR #273 eslint 通过
- PR #274 新增 precheck wait_notice 用例 ×2（不判 date_unavailable / 收齐即 ready_to_book）
- PR #274 新增 booking wait_notice 用例 ×2（无 interviewTime 成功提交 + 标签回填 / 带窗口岗位缺省仍拒）
- PR #274 全量 `jest`：287 suites / 3648 tests 全绿；`tsc --noEmit` + ESLint 通过

## [5.13.0] - 2026-06-09

**来源分支**: `develop`

### 更新摘要
- PR #265 取消运营事件上报到花卷，保留模块待用
- PR #265 支持自助取消与改约工单
- PR #265 处理发版前 review 建议
- PR #265 面试预约失败告警展示海绵 traceId
- PR #265 收敛多条运营反馈 badcase 话术红线
- PR #265 侧边栏菜单分组重命名 + 清理一次性 resync 脚本
- PR #265 依赖倒置消除 biz→channels/wecom 层违规
- PR #265 新增 `duliday_cancel_work_order` / `duliday_modify_interview_time` 两个工单自助变更工具，接入海绵取消、改约、失败原因字典接口，并在成功后写入 `ops_events`。
- PR #265 将工单变更计数接入运营投影和转化看板，同时补充自助取消/改约的 Supabase migration。
- PR #265 优化岗位列表新网关数据渲染、排班语义、飞书 webhook 重试告警、辱骂关键词误判和 dashboard 刷新态。

### 新功能
- PR #265 Agent 可基于当前预约信息自助取消已确认面试，或修改约面时间；失败时按现有转人工链路兜底。
- PR #265 转化分析 bot 表新增自助取消、自助改约计数列，作为运营侧支指标展示。
- PR #265 新增 `duliday_cancel_work_order` / `duliday_modify_interview_time` 两个工单自助变更工具，接入海绵取消、改约、失败原因字典接口，并在成功后写入 `ops_events`。
- PR #265 将工单变更计数接入运营投影和转化看板，同时补充自助取消/改约的 Supabase migration。
- PR #265 支持自助取消与改约工单

### 问题修复
- PR #265 修正 `滚` 单字关键词在友好/中性语境中的误伤。
- PR #265 修正岗位新结构下工作时间、排班周期、可排时段等字段的渲染与测试覆盖。
- PR #265 优化岗位列表新网关数据渲染、排班语义、飞书 webhook 重试告警、辱骂关键词误判和 dashboard 刷新态。

### 优化调整
- PR #265 海绵岗位/品牌/面试排期接口统一走 gateway base，可通过 `SPONGE_API_BASE_URL` 覆盖。
- PR #265 飞书 webhook 发送增加可重试判定、退避重试和最终失败告警。
- PR #265 dashboard 数据加载时增加顶部刷新进度态。
- PR #265 依赖倒置消除 biz→channels/wecom 层违规

### 运维与流程
- PR #265 新增 `supabase/migrations/20260608120000_ops_workorder_mutation_events.sql`，为 `daily_ops_report` 增加 `booking_cancel_count` 与 `interview_modified_count` 投影。
- PR #265 新增 ops_events 断档回灌、job/list 网关探针与基准脚本，便于发版前后核查。
- PR #265 取消运营事件上报到花卷，保留模块待用
- PR #265 处理发版前 review 建议
- PR #265 面试预约失败告警展示海绵 traceId
- PR #265 收敛多条运营反馈 badcase 话术红线
- PR #265 侧边栏菜单分组重命名 + 清理一次性 resync 脚本

### 配置变更
- 无

### 环境变量提醒
- PR #265 检测到环境变量相关文件变更：`.env.example`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- PR #265 `pnpm run ci:check`
- PR #265 pre-commit lint / format hook
- PR #265 pre-push `pnpm run ci:check`
- PR #265 关键链路已人工验证

## [5.12.0] - 2026-06-05

**来源分支**: `develop`

### 更新摘要
- PR #258 运营数据底座/转化分析仪表盘 + message_processing 补 bot_im_id

### 新功能
- PR #258 运营数据底座与运营事件底账、每日报表投影
- PR #258 咨询→报名→面试转化分析仪表盘：转化漏斗、账号榜单、KPI、控制筛选、侧栏与趋势图
- PR #258 转人工事件采集与原因分析
- PR #258 花卷 agentId 漏斗上报集成
- PR #258 托管成员配置（member config）
- PR #258 sponge token 多账号配置与上下文解析
- PR #258 告警通知按转人工/运营/私聊监控/入职跟进拆分

### 问题修复
- PR #258 修复转化榜单同 bot 裂成两行：message_processing 补 bot_im_id
- PR #258 修复破冰率恒 100%：接入新增客户回调反推
- PR #258 海绵手机号回查回填历史 interview.passed
- PR #258 品类词识别为相关品牌：“咖啡”等品类词不再被错提成“咖啡师”工种
- PR #258 推荐班次必须列全所有档位
- PR #258 转化分析页 API 失败时给出错误反馈与重试
- PR #258 同城多候选优先取地铁站锚点，避免长路名 POI 锚偏

### 优化调整
- PR #258 长期/会话记忆与高置信事实提取调整
- PR #258 预约/precheck/拉群/转人工/简历附件等工具调整

### 运维与流程
- PR #258 active users / handoff / bot_im_id 数据库迁移

### 配置变更
- 无

### 环境变量提醒
- PR #258 检测到环境变量相关文件变更：`.env.example`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- 无

## [5.11.5] - 2026-06-05

**来源分支**: `develop`

### 更新摘要
- PR #255 fix dashboard managed user count
- PR #255 fix resume attachment booking flow
- PR #255 fix booking tool formatting
- PR #255 Add a DB-side `count_active_users_from_user_activity_by_range` RPC using `COUNT(DISTINCT chat_id)`.
- PR #255 Add `countActiveUsersByDateRange` through the user hosting repository/service, with a paginated table-scan fallback if the new RPC is not available yet.
- PR #255 Switch Dashboard business totals for non-today ranges to use the distinct count instead of list length.
- PR #255 Add tests covering the count RPC path, fallback path, and capped-list regression.

### 新功能
- 无

### 问题修复
- PR #255 fix dashboard managed user count
- PR #255 fix resume attachment booking flow
- PR #255 fix booking tool formatting

### 优化调整
- 无

### 运维与流程
- PR #255 Add a DB-side `count_active_users_from_user_activity_by_range` RPC using `COUNT(DISTINCT chat_id)`.
- PR #255 Add `countActiveUsersByDateRange` through the user hosting repository/service, with a paginated table-scan fallback if the new RPC is not available yet.
- PR #255 Switch Dashboard business totals for non-today ranges to use the distinct count instead of list length.
- PR #255 Add tests covering the count RPC path, fallback path, and capped-list regression.

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #255 `pnpm exec jest tests/biz/monitoring/services/dashboard/analytics-dashboard.service.spec.ts tests/biz/user/repositories/user-hosting.repository.spec.ts --watchman=false`
- PR #255 `pnpm exec tsc --noEmit --pretty false`

## [5.11.4] - 2026-05-29

**来源分支**: `develop`

### 更新摘要
- PR #250 兼容苏州兼职群错序标签
- PR #250 推荐班次必须列全所有档位
- PR #250 修复看板人工介入统计
- PR #250 Added a targeted compatibility override for `独立客&苏州餐饮兼职群` when its labels are returned as `["兼职群", "餐饮", "苏州"]`.
- PR #250 Kept the original label parsing contract for all other groups.
- PR #250 Added a regression test covering the known Suzhou group `wxid` and label order.

### 新功能
- 无

### 问题修复
- PR #250 修复看板人工介入统计

### 优化调整
- 无

### 运维与流程
- PR #250 Added a targeted compatibility override for `独立客&苏州餐饮兼职群` when its labels are returned as `["兼职群", "餐饮", "苏州"]`.
- PR #250 Kept the original label parsing contract for all other groups.
- PR #250 Added a regression test covering the known Suzhou group `wxid` and label order.
- PR #250 兼容苏州兼职群错序标签
- PR #250 推荐班次必须列全所有档位

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #250 `pnpm jest tests/biz/group-task/group-resolver.service.spec.ts --watchman=false`
- PR #250 `pnpm run typecheck`
- PR #250 `pnpm exec eslint src/biz/group-task/services/group-resolver.service.ts tests/biz/group-task/group-resolver.service.spec.ts --max-warnings=0`

## [5.11.3] - 2026-05-28

**来源分支**: `develop`

### 更新摘要
- PR #245 Fix group invite retry and memory metadata
- PR #245 Add operations data product spec
- PR #245 Fix pipeline spec long-term dependency
- PR #245 add a compatibility retry for group invites when the current chat bot cannot see the room: add the chat bot to the target group via the owner bot, then retry the candidate invite
- PR #245 initialize long-term message metadata from new-customer callbacks and add a backfill script for existing rows
- PR #245 improve message splitting so booking/info form blocks stay together
- PR #245 add product docs for group invite behavior, ops-data / Sponge integration design, and operations-facing data definitions
- PR #245 fix the pipeline service spec to provide the new `LongTermService` dependency used by `AcceptInboundMessageService`

### 新功能
- 无

### 问题修复
- PR #245 fix the pipeline service spec to provide the new `LongTermService` dependency used by `AcceptInboundMessageService`
- PR #245 Fix group invite retry and memory metadata
- PR #245 Fix pipeline spec long-term dependency

### 优化调整
- PR #245 improve message splitting so booking/info form blocks stay together

### 运维与流程
- PR #245 add a compatibility retry for group invites when the current chat bot cannot see the room: add the chat bot to the target group via the owner bot, then retry the candidate invite
- PR #245 initialize long-term message metadata from new-customer callbacks and add a backfill script for existing rows
- PR #245 add product docs for group invite behavior, ops-data / Sponge integration design, and operations-facing data definitions
- PR #245 Add operations data product spec

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #245 `./node_modules/.bin/jest tests/channels/wecom/message/services/pipeline.service.spec.ts --runInBand --watchman=false`
- PR #245 `./node_modules/.bin/jest --watchman=false --runInBand` (261 suites passed, 3441 passed, 1 skipped)
- PR #245 `./node_modules/.bin/tsc --noEmit`
- PR #245 `./node_modules/.bin/eslint tests/channels/wecom/message/services/pipeline.service.spec.ts --max-warnings=0`
- PR #245 Earlier focused checks before the CI fix: invite-to-group, accept-inbound-message, message-splitter, long-term, and supabase-store specs; plus focused ESLint on the changed source/test files

## [5.11.2] - 2026-05-28

**来源分支**: `develop`

### 更新摘要
- PR #240 align job list age boundary handling
- PR #240 Align duliday_job_list age mismatch handling with precheck ageBoundary semantics.
- PR #240 Add job-list age screening metadata and markdown guidance so boundary ages such as 52 vs 20-50 are not treated as no-match.
- PR #240 Add regression coverage for the 52-year-old boundary case.
- PR #240 fix elastic age handling in job list

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #240 Align duliday_job_list age mismatch handling with precheck ageBoundary semantics.
- PR #240 Add job-list age screening metadata and markdown guidance so boundary ages such as 52 vs 20-50 are not treated as no-match.
- PR #240 Add regression coverage for the 52-year-old boundary case.
- PR #240 align job list age boundary handling

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #240 ./node_modules/.bin/jest tests/tools/tool/duliday-job-list.tool.spec.ts --runInBand
- PR #240 ./node_modules/.bin/eslint src/tools/duliday-job-list.tool.ts tests/tools/tool/duliday-job-list.tool.spec.ts --max-warnings=0
- PR #240 ./node_modules/.bin/prettier --check src/tools/duliday-job-list.tool.ts tests/tools/tool/duliday-job-list.tool.spec.ts
- PR #240 ./node_modules/.bin/tsc --noEmit --pretty false

## [5.11.1] - 2026-05-28

**来源分支**: `develop`

### 更新摘要
- PR #235 修正托管用户统计日期范围
- PR #235 Added a shared web date-range utility for local date key formatting and recent business-day ranges.
- PR #235 Updated dashboard and user trend charts to use the shared business-day range and exclude weekends from the displayed trend range.
- PR #235 Changed the managed-user list request so the default view queries today's managed sessions without sending a rolling `days` parameter.
- PR #235 Restored the managed-user tab label to “今日托管会话” to match the default query scope.

### 新功能
- 无

### 问题修复
- PR #235 Added a shared web date-range utility for local date key formatting and recent business-day ranges.
- PR #235 Updated dashboard and user trend charts to use the shared business-day range and exclude weekends from the displayed trend range.
- PR #235 Changed the managed-user list request so the default view queries today's managed sessions without sending a rolling `days` parameter.
- PR #235 Restored the managed-user tab label to “今日托管会话” to match the default query scope.
- PR #235 修正托管用户统计日期范围

### 优化调整
- 无

### 运维与流程
- 无

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #235 `pnpm run ci:check`
- PR #235 `web` build via `tsc -b && vite build` before commit

## [5.11.0] - 2026-05-27

**来源分支**: `develop`

### 更新摘要
- PR #229 修复部署通知会过滤中文发布条目的问题：只要有中文，即使包含 loadArtWorkImage、payload.artworkUrl、AGENT_VISION_FALLBACKS 等技术标识，也不再被当作纯技术英文丢弃
- PR #229 为图片原图、fact guard、Dashboard、拉群人数修复增加运营可读改写
- PR #229 补充部署通知回归测试，确保发版通知不会再丢失这类业务改动
- PR #230 统一 highConfidenceFacts、sessionFacts、长期 profile_facts 的字段级置信度结构
- PR #230 precheck 新增候选人年龄、面试时间、性别、学历、健康证、学生身份等显式入参，显式入参优先于记忆
- PR #230 新增 agent_long_term_memories 表、长期画像 RPC 和历史回填脚本
- PR #230 补充记忆与线索数据流文档，以及 24 岁候选人触发 ageBoundary 的回归测试

### 新功能
- PR #230 新增 agent_long_term_memories 表、长期画像 RPC 和历史回填脚本
- PR #230 precheck 入参新增候选人年龄、面试时间、性别、学历、健康证、学生身份等候选字段

### 问题修复
- PR #229 修复部署通知会过滤中文发布条目的问题：只要有中文，即使包含 loadArtWorkImage、payload.artworkUrl、AGENT_VISION_FALLBACKS 等技术标识，也不再被当作纯技术英文丢弃
- PR #229 为图片原图、fact guard、Dashboard、拉群人数修复增加运营可读改写
- PR #230 修复 precheck 只依赖 sessionFacts 时读不到候选人本轮年龄，导致 ageBoundary 返回 unknown 的问题
- PR #230 复用高置信事实 guard，避免 precheck 内部维护重复判断逻辑

### 优化调整
- PR #230 统一记忆、线索、事实的数据流文档与字段置信度展示规则
- PR #230 本轮线索保留候选人本轮确认过的事实，便于模型理解最新表达

### 运维与流程
- PR #229 补充部署通知回归测试，确保发版通知不会再丢失这类业务改动
- PR #230 补充长期画像回填 dry-run 和 apply 脚本，默认 dry-run

### 配置变更
- 无

### 环境变量提醒
- PR #230 检测到环境变量相关文件变更：`.env.example`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- PR #229 `pnpm jest tests/scripts/send-deploy-notification.spec.ts --watchman=false`
- PR #230 `pnpm run typecheck`
- PR #230 `pnpm test -- --runInBand --watchman=false`
- PR #230 `pnpm run ci:check`
- PR #230 test DB migration 和 RPC 临时写入验证通过并已清理

## [5.10.1] - 2026-05-27

**来源分支**: `develop`

### 更新摘要
- PR #224 托管平台回调的 `imageUrl` 是压缩缩略图（96x210, 8.8KB），vision 模型无法读取文字导致 100% 幻觉
- PR #224 新增 `loadArtWorkImage` API 调用获取原图（1179x2556, 222KB），存入 `payload.artworkUrl`
- PR #224 全链路只调一次 API，下游三条消费路径（vision 描述 / Agent 对话 / Web 后台）全部读 `payload.artworkUrl`
- PR #224 **图片原图获取**: `enrichImagePayload` 在存记录前同步获取原图 URL 写入 payload（一次 INSERT 到位）
- PR #224 **Vision 描述路径**: `describeAndUpdateAsync` 直接使用 artworkUrl，`disableFallbacks: true` 防止降级到纯文本模型
- PR #224 **Agent vision 路径**: `collectImageUrls` 优先读 `payload.artworkUrl`，传高清原图给 LLM
- PR #224 **Web 后台**: `getImageUrls` 的 previewUrl 优先查找 `artworkUrl`
- PR #224 **Vision 降级链**: 新增 `AGENT_VISION_FALLBACKS` 只含 multimodal 模型
- PR #224 **其他**: reply-fact-guard 误报率优化、Dashboard 趋势图修复、invite-to-group 群人数修复

### 新功能
- PR #224 新增 `loadArtWorkImage` API 调用获取原图（1179x2556, 222KB），存入 `payload.artworkUrl`
- PR #224 **Vision 降级链**: 新增 `AGENT_VISION_FALLBACKS` 只含 multimodal 模型

### 问题修复
- PR #224 托管平台回调的 `imageUrl` 是压缩缩略图（96x210, 8.8KB），vision 模型无法读取文字导致 100% 幻觉
- PR #224 全链路只调一次 API，下游三条消费路径（vision 描述 / Agent 对话 / Web 后台）全部读 `payload.artworkUrl`
- PR #224 **图片原图获取**: `enrichImagePayload` 在存记录前同步获取原图 URL 写入 payload（一次 INSERT 到位）
- PR #224 **Vision 描述路径**: `describeAndUpdateAsync` 直接使用 artworkUrl，`disableFallbacks: true` 防止降级到纯文本模型
- PR #224 **Agent vision 路径**: `collectImageUrls` 优先读 `payload.artworkUrl`，传高清原图给 LLM
- PR #224 **Web 后台**: `getImageUrls` 的 previewUrl 优先查找 `artworkUrl`
- PR #224 **其他**: reply-fact-guard 误报率优化、Dashboard 趋势图修复、invite-to-group 群人数修复

### 优化调整
- 无

### 运维与流程
- 无

### 配置变更
- 无

### 环境变量提醒
- PR #224 检测到环境变量相关文件变更：`.env.example`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- PR #224 单元测试 11/11 通过（含 4 个新增图片链路测试）
- PR #224 CI 全量测试通过
- PR #224 端到端验证：loadArtWorkImage API → 原图 URL → qwen-vl-plus 准确识别 M Stand/店员/26元

## [5.10.0] - 2026-05-26

**来源分支**: `develop`

### 更新摘要
- PR #219 **记忆系统重构**：三路径写入 + DB 时间戳驱动沉淀，解耦历史回查窗口与 session TTL，修复跨天上下文丢失
- PR #219 **测试补全**：memory 单元测试 + 集成测试脚本 + DI 导出修复；brand-stores displayLine 断言更新
- PR #219 **杂项**：TestSuite 队列初始化容错、Dashboard 用户趋势图标签优化、agent-safety-hardening 待办文档

### 新功能
- 无

### 问题修复
- PR #219 **记忆系统重构**：三路径写入 + DB 时间戳驱动沉淀，解耦历史回查窗口与 session TTL，修复跨天上下文丢失
- PR #219 **测试补全**：memory 单元测试 + 集成测试脚本 + DI 导出修复；brand-stores displayLine 断言更新

### 优化调整
- PR #219 **杂项**：TestSuite 队列初始化容错、Dashboard 用户趋势图标签优化、agent-safety-hardening 待办文档

### 运维与流程
- 无

### 配置变更
- 无

### 环境变量提醒
- PR #219 检测到环境变量相关文件变更：`.env.example`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- PR #219 258 test suites / 3263 tests 全部通过
- PR #219 pre-push CI（lint + format + typecheck + build + test）通过
- PR #219 线上验证记忆沉淀跨天场景

## [5.9.1] - 2026-05-21

**来源分支**: `develop`

### 更新摘要
- PR #214 **group_promise_without_invite 误报降噪**：新增 Case 2（能力/选项陈述，如"我也可以拉你进群"）和 Case 3（invite + 尾随确认问，如"发个入群邀请，你看行行？"）豁免，避免把候选人确认阶段的条件句打成误报
- PR #214 **booking_form_field_mismatch 误报降噪**：正则扩展支持字段名后跟括号注释再接冒号（如「健康证（有/无）：」「身份（学生/社会人士）：」），斜杠合并字段（如「性别/年龄：」）按 `/` 拆分独立对账
- PR #214 **告警路由变更**：`ReplyFactGuardNotifierService` 移除飞书告警卡片，改为直写飞书 BadCase 多维表格（`FeishuBitableSyncService.writeAgentTestFeedback`），`NotificationModule` 引入 `FeishuSyncModule`

### 新功能
- PR #214 **group_promise_without_invite 误报降噪**：新增 Case 2（能力/选项陈述，如"我也可以拉你进群"）和 Case 3（invite + 尾随确认问，如"发个入群邀请，你看行行？"）豁免，避免把候选人确认阶段的条件句打成误报
- PR #214 **booking_form_field_mismatch 误报降噪**：正则扩展支持字段名后跟括号注释再接冒号（如「健康证（有/无）：」「身份（学生/社会人士）：」），斜杠合并字段（如「性别/年龄：」）按 `/` 拆分独立对账

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #214 **告警路由变更**：`ReplyFactGuardNotifierService` 移除飞书告警卡片，改为直写飞书 BadCase 多维表格（`FeishuBitableSyncService.writeAgentTestFeedback`），`NotificationModule` 引入 `FeishuSyncModule`

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #214 单元测试 28 条全部通过（含 5 条新增回归用例，覆盖括号注释、斜杠合并字段、Case 2/3 豁免、仍需告警的断言场景）
- PR #214 真实链路验证：批次 `22b99b24`，2 条回归用例在本地 dev server 运行，`duliday_interview_precheck` 实际调用，Agent 生成含「身份（学生/社会人士）：」的收资模板，`ReplyFactGuard` 日志无 `booking_form_field_mismatch` 告警

## [5.9.0] - 2026-05-21

**来源分支**: `develop`

### 更新摘要
- PR #209 新增吴盼盼（盼盼组 bot `1688854263771949`）和郭晓阳（艾酱测试组 bot `1688855753660960`）到飞书通知接收人配置
- PR #209 同步更新 `BOT_TO_RECEIVER` 映射，群任务通知可自动 @对应负责人

### 新功能
- PR #209 新增吴盼盼（盼盼组 bot `1688854263771949`）和郭晓阳（艾酱测试组 bot `1688855753660960`）到飞书通知接收人配置
- PR #209 同步更新 `BOT_TO_RECEIVER` 映射，群任务通知可自动 @对应负责人

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- 无

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #209 确认盼盼组消息通知能正确 @盼盼
- PR #209 确认小阳 bot 消息通知能正确 @小阳

## [5.8.1] - 2026-05-20

**来源分支**: `develop`

### 更新摘要
- PR #202 Added structured `workTimeText` parsing to schedule semantic classification.
- PR #202 Weekend-only jobs are now recognized from `weekWorkTime.customnWorkTimeList[].customWorkWeekdays` and `dailyShiftSchedule.combinedArrangement[].combinedArrangementWeekdays`.
- PR #202 Added regression coverage for structured weekend-only jobs and mixed weekday/weekend schedules.
- PR #202 天通苑 `周末兼职` queries can now retain the structured weekend-only jobs, including 果蔬好 `528102` and `527672` from the reproduced snapshot.
- PR #202 Jobs that require weekdays or full-week availability are still excluded from strict weekend-only queries.

### 新功能
- 无

### 问题修复
- PR #202 Added structured `workTimeText` parsing to schedule semantic classification.
- PR #202 Weekend-only jobs are now recognized from `weekWorkTime.customnWorkTimeList[].customWorkWeekdays` and `dailyShiftSchedule.combinedArrangement[].combinedArrangementWeekdays`.
- PR #202 Added regression coverage for structured weekend-only jobs and mixed weekday/weekend schedules.
- PR #202 天通苑 `周末兼职` queries can now retain the structured weekend-only jobs, including 果蔬好 `528102` and `527672` from the reproduced snapshot.
- PR #202 Jobs that require weekdays or full-week availability are still excluded from strict weekend-only queries.

### 优化调整
- 无

### 运维与流程
- 无

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #202 `pnpm jest tests/tools/duliday/schedule-semantic.util.spec.ts --watchman=false`
- PR #202 `pnpm jest tests/tools/tool/duliday-job-list.tool.spec.ts --watchman=false`
- PR #202 `pnpm exec prettier --check src/tools/duliday/schedule-semantic.util.ts tests/tools/duliday/schedule-semantic.util.spec.ts`
- PR #202 `pnpm typecheck`
- PR #202 Pre-push `pnpm run ci:check`: 236 suites passed, 2890 tests passed
- PR #202 Live snapshot replay retained `[528102, 527672]` for `onlyWeekends=true`

## [5.8.0] - 2026-05-19

**预计版本**: `v5.8.1`
**最近更新**: `2026-05-20`
**来源分支**: `develop`
**累计 PR**: 1

### 更新摘要
- PR #202 Added structured `workTimeText` parsing to schedule semantic classification.
- PR #202 Weekend-only jobs are now recognized from `weekWorkTime.customnWorkTimeList[].customWorkWeekdays` and `dailyShiftSchedule.combinedArrangement[].combinedArrangementWeekdays`.
- PR #202 Added regression coverage for structured weekend-only jobs and mixed weekday/weekend schedules.
- PR #202 天通苑 `周末兼职` queries can now retain the structured weekend-only jobs, including 果蔬好 `528102` and `527672` from the reproduced snapshot.
- PR #202 Jobs that require weekdays or full-week availability are still excluded from strict weekend-only queries.

### 新功能
- 无

### 问题修复
- PR #202 Added structured `workTimeText` parsing to schedule semantic classification.
- PR #202 Weekend-only jobs are now recognized from `weekWorkTime.customnWorkTimeList[].customWorkWeekdays` and `dailyShiftSchedule.combinedArrangement[].combinedArrangementWeekdays`.
- PR #202 Added regression coverage for structured weekend-only jobs and mixed weekday/weekend schedules.
- PR #202 天通苑 `周末兼职` queries can now retain the structured weekend-only jobs, including 果蔬好 `528102` and `527672` from the reproduced snapshot.
- PR #202 Jobs that require weekdays or full-week availability are still excluded from strict weekend-only queries.

### 优化调整
- 无

### 运维与流程
- 无

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #202 `pnpm jest tests/tools/duliday/schedule-semantic.util.spec.ts --watchman=false`
- PR #202 `pnpm jest tests/tools/tool/duliday-job-list.tool.spec.ts --watchman=false`
- PR #202 `pnpm exec prettier --check src/tools/duliday/schedule-semantic.util.ts tests/tools/duliday/schedule-semantic.util.spec.ts`
- PR #202 `pnpm typecheck`
- PR #202 Pre-push `pnpm run ci:check`: 236 suites passed, 2890 tests passed
- PR #202 Live snapshot replay retained `[528102, 527672]` for `onlyWeekends=true`
<!-- release:pending:end -->

## [5.8.0] - 2026-05-20

**来源分支**: `develop`

### 更新摘要
- PR #192 **Agent 品牌意向例外**：候选人只是接受 Agent 自推岗位时，不把该品牌当成候选人硬性品牌意向；硬条件不符时先去掉 `brandIdList` 并保留位置/年龄/身份/时间窗等硬约束重查，避免过早 `request_handoff`。
- PR #192 **启动和日志稳定性**：`DataCleanupService.onModuleInit` 不再等待启动清理完成；Supabase/Cloudflare HTML 错误页会被摘要成单行，避免 bootstrap 被长超时拖死、日志被 HTML 淹没。
- PR #192 **badcase 工具层硬修**：补上品牌名净化、拉群幂等记忆、收资字段一致性告警、薪资防编告警、面试预约收尾模板、少数民族姓名豁免、南京/栖霞/六合地理映射等边界。
- PR #192 **架构沉淀**：新增 `docs/architecture/agent-redesign-from-badcases.md`，把 63 条 badcase 收敛成槽位状态机、信号提取、工具数据契约、文案模板化 4 条后续主线。
- PR #192 **tools 目录重组**：把 `duliday-job-list.tool.ts` 的检索、helper、同品牌门店聚合、markdown 渲染拆到 `src/tools/duliday/job-list/*`，并将 booking 专用 util 与跨工具 util 分层归位。
- PR #192 候选人接受 Agent 推荐后，硬条件不符时更可能继续获得替代岗位，而不是被错误转人工。
- PR #192 约面成功后的时间、到店话术、免责声明等回复更稳定。
- PR #192 运营侧能更早发现收资字段漏收和薪资编造风险。
- PR #192 `duliday_job_list` 后续维护面更清晰，检索、渲染、聚合逻辑不再都塞在单文件里。
- PR #195 `cb2b09c1` storeName 内部编码剥离 + 门店状态禁编造（badcase 2xcajl7w / z1u2ntbg）
- PR #195 `516cad1e` hardRequirements enum 派生骨架（gender / household / healthCert）
- PR #195 `ab0074d4` 清理 LLM 上下文里的 badcase ID 泄露
- PR #195 `17e735b0` hardRequirements 接入 render banner + booking-guards hard gate
- PR #195 `6e4bc8c6` salary 字段速览 banner + reply-fact-guard 复用同一派生层
- PR #195 `5d814455` welfare 字段速览 + 净化"员工自理/不购买"等弱否定
- PR #195 `7cab33ca` 拆 duliday-interview-precheck.tool 成 duliday/precheck/* 7 个 util，主文件 1615 → 410 行 (-75%)；机械搬运，0 逻辑改动
- PR #195 `aac6b859` Phase 1.C.1 候选人推荐卡片模板化（班次 5 + 薪资 3 + 地址 3 = 11 条 badcase）
- PR #195 `ed483b7a` Phase 1.C.2 无岗动作链 noMatchScript + 户籍敏感字段委婉问（拉群 + 软收尾 + 替代品牌 + 敏感字段 = 4 条 badcase）
- PR #195 全量 **3017 单测通过**（本 PR 新增 ≈ 90 例）
- PR #195 新增 util 全部带独立 spec：
- PR #195 sanitize / hard-requirements / salary-facts / welfare-facts / candidate-card / no-match-script
- PR #195 booking-guards 新增 hard-requirement gate 11 例
- PR #195 重大改动（render banner + reply-fact-guard 重构）走全量 jest
- PR #195 **低风险**：所有改动都是新增字段 + 新增 banner，不改原有 markdown / API 入参；旧调用方读 raw 数据继续工作
- PR #195 **中风险**：booking-guards 新增 gender + healthCert 硬拦，候选人 facts 与岗位约束冲突会拒 booking。已覆盖 11 例单测，且工具 description 给了清晰的 replyInstruction 让 LLM 转 handoff
- PR #195 **零风险机械搬运**：precheck 拆分 8 文件 1745 行，全部走过 jest
- PR #196 **Phase 3.1+3.2** 信号提取层：把候选人在更早轮次说过的"班次硬约束 / 未来日期硬约束"持久化到 sessionFacts，下游工具自动消费
- PR #196 **Phase 2-lite.1** booking precheck 契约硬约束：把"必须先 precheck 且 ready_to_book"从 prompt 红线下沉到入参强校验
- PR #196 **Phase 1.C.3-5** 文案模板化收尾：跨品牌硬过滤 + 缺位置/跨城市禁反问 description
- PR #196 不引入全局 stage state machine（精度低、维护成本高）
- PR #196 用现有 precheck 已经派生的 `nextAction` + `missingFieldsCount` 作为契约
- PR #196 booking 工具入口硬校验候选人字段是否齐全 + 状态是否合法
- PR #196 Q3 代他人报名（一条 badcase 不值得双主体模型）
- PR #196 Q5 上下文承接（单 case 不值得动主 prompt）
- PR #196 y7f3jqsh 静默 10 分钟（message scheduler 范围，本 PR 外）
- PR #196 **中风险（要重点 review）**：booking 入参新增 prechecked 必填字段，是 breaking change 到工具契约。LLM 必须显式复读 precheck 的 nextAction + missingFieldsCount。在 description 已强调，但需观察生产数据看是否有 LLM 不填的情况
- PR #196 **低风险**：sessionFacts 新增字段（schedule_constraint + available_after），都是 nullable + 默认 null，旧 Redis 数据兼容
- PR #196 **低风险**：filterJobsToRequestedBrands 是 conservative 过滤（候选人没指定品牌时直通）

### 新功能
- PR #192 **架构沉淀**：新增 `docs/architecture/agent-redesign-from-badcases.md`，把 63 条 badcase 收敛成槽位状态机、信号提取、工具数据契约、文案模板化 4 条后续主线。
- PR #195 `17e735b0` hardRequirements 接入 render banner + booking-guards hard gate
- PR #195 全量 **3017 单测通过**（本 PR 新增 ≈ 90 例）
- PR #195 新增 util 全部带独立 spec：
- PR #195 booking-guards 新增 hard-requirement gate 11 例
- PR #195 **低风险**：所有改动都是新增字段 + 新增 banner，不改原有 markdown / API 入参；旧调用方读 raw 数据继续工作
- PR #195 **中风险**：booking-guards 新增 gender + healthCert 硬拦，候选人 facts 与岗位约束冲突会拒 booking。已覆盖 11 例单测，且工具 description 给了清晰的 replyInstruction 让 LLM 转 handoff
- PR #196 **Phase 3.1+3.2** 信号提取层：把候选人在更早轮次说过的"班次硬约束 / 未来日期硬约束"持久化到 sessionFacts，下游工具自动消费
- PR #196 **Phase 2-lite.1** booking precheck 契约硬约束：把"必须先 precheck 且 ready_to_book"从 prompt 红线下沉到入参强校验
- PR #196 **Phase 1.C.3-5** 文案模板化收尾：跨品牌硬过滤 + 缺位置/跨城市禁反问 description
- PR #196 不引入全局 stage state machine（精度低、维护成本高）
- PR #196 用现有 precheck 已经派生的 `nextAction` + `missingFieldsCount` 作为契约
- PR #196 booking 工具入口硬校验候选人字段是否齐全 + 状态是否合法
- PR #196 Q3 代他人报名（一条 badcase 不值得双主体模型）
- PR #196 Q5 上下文承接（单 case 不值得动主 prompt）
- PR #196 y7f3jqsh 静默 10 分钟（message scheduler 范围，本 PR 外）
- PR #196 **中风险（要重点 review）**：booking 入参新增 prechecked 必填字段，是 breaking change 到工具契约。LLM 必须显式复读 precheck 的 nextAction + missingFieldsCount。在 description 已强调，但需观察生产数据看是否有 LLM 不填的情况
- PR #196 **低风险**：sessionFacts 新增字段（schedule_constraint + available_after），都是 nullable + 默认 null，旧 Redis 数据兼容
- PR #196 **低风险**：filterJobsToRequestedBrands 是 conservative 过滤（候选人没指定品牌时直通）

### 问题修复
- PR #192 **Agent 品牌意向例外**：候选人只是接受 Agent 自推岗位时，不把该品牌当成候选人硬性品牌意向；硬条件不符时先去掉 `brandIdList` 并保留位置/年龄/身份/时间窗等硬约束重查，避免过早 `request_handoff`。
- PR #192 **启动和日志稳定性**：`DataCleanupService.onModuleInit` 不再等待启动清理完成；Supabase/Cloudflare HTML 错误页会被摘要成单行，避免 bootstrap 被长超时拖死、日志被 HTML 淹没。
- PR #192 **badcase 工具层硬修**：补上品牌名净化、拉群幂等记忆、收资字段一致性告警、薪资防编告警、面试预约收尾模板、少数民族姓名豁免、南京/栖霞/六合地理映射等边界。
- PR #192 **tools 目录重组**：把 `duliday-job-list.tool.ts` 的检索、helper、同品牌门店聚合、markdown 渲染拆到 `src/tools/duliday/job-list/*`，并将 booking 专用 util 与跨工具 util 分层归位。
- PR #192 候选人接受 Agent 推荐后，硬条件不符时更可能继续获得替代岗位，而不是被错误转人工。
- PR #192 约面成功后的时间、到店话术、免责声明等回复更稳定。
- PR #192 运营侧能更早发现收资字段漏收和薪资编造风险。
- PR #192 `duliday_job_list` 后续维护面更清晰，检索、渲染、聚合逻辑不再都塞在单文件里。

### 优化调整
- PR #195 `cb2b09c1` storeName 内部编码剥离 + 门店状态禁编造（badcase 2xcajl7w / z1u2ntbg）
- PR #195 `516cad1e` hardRequirements enum 派生骨架（gender / household / healthCert）
- PR #195 `ab0074d4` 清理 LLM 上下文里的 badcase ID 泄露
- PR #195 `6e4bc8c6` salary 字段速览 banner + reply-fact-guard 复用同一派生层
- PR #195 `5d814455` welfare 字段速览 + 净化"员工自理/不购买"等弱否定
- PR #195 `7cab33ca` 拆 duliday-interview-precheck.tool 成 duliday/precheck/* 7 个 util，主文件 1615 → 410 行 (-75%)；机械搬运，0 逻辑改动
- PR #195 `aac6b859` Phase 1.C.1 候选人推荐卡片模板化（班次 5 + 薪资 3 + 地址 3 = 11 条 badcase）
- PR #195 `ed483b7a` Phase 1.C.2 无岗动作链 noMatchScript + 户籍敏感字段委婉问（拉群 + 软收尾 + 替代品牌 + 敏感字段 = 4 条 badcase）
- PR #195 sanitize / hard-requirements / salary-facts / welfare-facts / candidate-card / no-match-script
- PR #195 重大改动（render banner + reply-fact-guard 重构）走全量 jest
- PR #195 **零风险机械搬运**：precheck 拆分 8 文件 1745 行，全部走过 jest

### 运维与流程
- 无

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #192 `pnpm run ci:check` 本地通过：239 suites / 2888 tests
- PR #192 `git push` pre-push hook 再次运行 `pnpm run ci:check` 通过：239 suites / 2888 tests
- PR #192 GitHub Actions `CI Checks` 等待完成
- PR #192 GitHub Actions `ai-code-review` 等待完成
- PR #195 code review 9 个 commit（每个 self-contained，建议按 commit 顺序看）
- PR #195 重点 review `candidate-card.util.ts` 卡片格式（是否覆盖业务关心的字段）
- PR #195 重点 review `no-match-script.util.ts` 的 candidateMessage 文案（是否够口语化）
- PR #195 重点 review `welfare-facts.util.ts` 的 ❌/✅/💵/❓ 符号语义是否对齐业务
- PR #195 precheck 拆分的 7 个 util 路径变化是否影响其他调用方（grep `from '@tools/duliday-interview-precheck.tool'`）
- PR #195 评估 booking-guards 新增 hard-requirement gate 是否会误伤合规候选人
- PR #196 code review 3 个 commit（按 commit 顺序）
- PR #196 重点 review Phase 2-lite.1 的 prechecked 入参契约是否合适
- PR #196 评估 filterJobsToRequestedBrands 的子串匹配规则是否会有误伤
- PR #196 看 available_after 的日期解析正则是否会误触发

## [5.7.2] - 2026-05-18

**来源分支**: `develop`

### 更新摘要
- PR #188 地理识别改成白名单驱动扫描，修复区+镇/区+街道贪婪误吞

### 新功能
- 无

### 问题修复
- PR #188 地理识别改成白名单驱动扫描，修复区+镇/区+街道贪婪误吞

### 优化调整
- 无

### 运维与流程
- 无

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #188 `pnpm test` — 全套 **236 suites / 2890 cases 全绿**
- PR #188 `pnpm run test -- tests/memory/high-confidence-facts.spec.ts` — 新增 22 个 case 全绿，含原 20 个 + 新增"浦东新区航头镇" / "徐汇区漕河泾街道" / "海淀区清河镇" / "浦东新区"最长前缀
- PR #188 `pnpm run test -- tests/memory/session.service.spec.ts` — `backfillCityFromWhitelist` 相关 case 全绿
- PR #188 `pnpm run lint` 无 warning
- PR #188 `npx prettier --check` 通过
- PR #188 `npx tsc --noEmit` 无错误

## [5.7.1] - 2026-05-15

**来源分支**: `develop`

### 更新摘要
- PR #177 修复"你好我在青浦区/我在浦东区"等带前缀消息无法识别城市的 bug：高置信路径贪婪正则把整段当区名，归一化后变成"你好我在青浦"永远查不到白名单
- PR #177 让 `DISTRICT_TO_CITY` / `LOCATION_TO_CITY` 白名单成为城市识别的唯一真相源：LLM 按 prompt 对单独区名留空 city 时，由确定性逻辑在 `session.service` 兜底回填，避免下游 hard-constraints 把候选人卡在"当前没有已确认城市"反问循环
- PR #181 bot 创建的 PR 也走 AI Code Review

### 新功能
- 无

### 问题修复
- PR #177 修复"你好我在青浦区/我在浦东区"等带前缀消息无法识别城市的 bug：高置信路径贪婪正则把整段当区名，归一化后变成"你好我在青浦"永远查不到白名单
- PR #177 LLM session 提取按 prompt 对单独区名留空 city 时，由 `session.service` 用白名单兜底回填，避免下游 hard-constraints 把候选人卡在"当前没有已确认城市"反问循环

### 优化调整
- PR #177 把 `resolveCityFromDistrict` / `resolveCityFromLocation` / `resolveCityFromGeoSignals` 提为 `geo-mappings.ts` 公共 helper，避免高置信路径和 session 提取路径的双轨实现漂移

### 运维与流程
- PR #181 bot 创建的 PR 也走 AI Code Review

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #177 `pnpm run test -- tests/memory` — 222 个测试全过
- PR #177 新增高置信路径测试覆盖：你好我在青浦区 / 我在浦东区 / 住在朝阳区
- PR #177 新增 `session.service` 测试覆盖：LLM 留空 city 时白名单回填、LLM 已填 city 时不覆盖
- PR #177 `pnpm run lint` 干净
- PR #181 \`python yaml.safe_load\` 校验两个 YAML 文件语法
- PR #181 合并后，下一个普通 PR 合到 develop 触发 \`prepare-develop-release\` → 期望新建/更新的 release-metadata PR 能拿到 AI review
- PR #181 失败兜底：即便 dispatch step 报错，元数据 PR 本身仍然成功创建（\`continue-on-error: true\`）

## [5.7.0] - 2026-05-14

**来源分支**: `develop`

### 更新摘要
- PR #171 **invite-to-group「已在群」误判**（2778bdb1）— `INVITE_ALREADY_IN_GROUP` 改 success 返回，规避 PR #165 引入的"失败统一兜底 request_handoff"误触
- PR #171 **modify_appointment 误判首次约面**（144a6e40）— 招募经理抛多个候选时段、候选人选其一不算改期；过期 active case 不构成改期依据
- PR #171 **reply-fact-guard 弱承诺误报**（273d69be）— 收紧 group_promise 正则，"群里通知/群更新/关注群"等 future-tense 不再要求本轮拉群，badcase gay6j94c 强承诺覆盖不变
- PR #171 **「有病」辱骂误判**（f4aece89）— 候选人说明"家里有病人"被命中关键词，伤害正常求职者，从 ABUSE_KEYWORDS 移除
- PR #171 alertLabel/riskLabel 合并到 title（general-handoff / onboard-followup / conversation-risk）
- PR #171 顶层行内字段 label 全部加粗，跟 ops-card 系列对齐
- PR #171 命中原因 + 建议动作 用引用块 + 红字 + 加粗三重强调
- PR #171 general-handoff header 升到 red、emoji 改 🚨，与同档卡片对齐
- PR #171 ops 拉群被拒 emoji ⚠️→🚨 跟 header 颜色对齐
- PR #171 顺手把 request_handoff 的 `summary` 字段改名 `actionAdvice`，语义升级为"建议下一步动作"
- PR #171 **CI/Docker 供应链加固**（ef49f22d）— GitHub Actions SHA pin、`persist-credentials: false`、移除 `pull-requests: write`；Node base image digest pin、pnpm 锁 10.33.4；`pnpm-workspace` 加 `minimumReleaseAge: 1440 + blockExoticSubdeps`
- PR #171 **拆分 reply-fact-guard notifier**（4f71a93e）— 从 OpsNotifierService 解耦出独立 service，对话级介入告警走私聊群、不与运营群混发
- PR #171 **Dashboard 运营日报菜单 + HealthGrid 精简**（858f27e5）— 加飞书外链项；移除 HealthGrid hover tooltip
- PR #171 **飞书数据同步脚本**（c42d9c27）— 海绵岗位数据问题批量推送脚本
- PR #174 把 master merge 回 develop，解除 PR #173 冲突

### 新功能
- 无

### 问题修复
- PR #171 **invite-to-group「已在群」误判**（2778bdb1）— `INVITE_ALREADY_IN_GROUP` 改 success 返回，规避 PR #165 引入的"失败统一兜底 request_handoff"误触
- PR #171 **modify_appointment 误判首次约面**（144a6e40）— 招募经理抛多个候选时段、候选人选其一不算改期；过期 active case 不构成改期依据
- PR #171 **reply-fact-guard 弱承诺误报**（273d69be）— 收紧 group_promise 正则，"群里通知/群更新/关注群"等 future-tense 不再要求本轮拉群，badcase gay6j94c 强承诺覆盖不变
- PR #171 **「有病」辱骂误判**（f4aece89）— 候选人说明"家里有病人"被命中关键词，伤害正常求职者，从 ABUSE_KEYWORDS 移除
- PR #171 顶层行内字段 label 全部加粗，跟 ops-card 系列对齐
- PR #171 命中原因 + 建议动作 用引用块 + 红字 + 加粗三重强调
- PR #171 general-handoff header 升到 red、emoji 改 🚨，与同档卡片对齐
- PR #171 ops 拉群被拒 emoji ⚠️→🚨 跟 header 颜色对齐
- PR #171 顺手把 request_handoff 的 `summary` 字段改名 `actionAdvice`，语义升级为"建议下一步动作"
- PR #171 **Dashboard 运营日报菜单 + HealthGrid 精简**（858f27e5）— 加飞书外链项；移除 HealthGrid hover tooltip
- PR #171 **飞书数据同步脚本**（c42d9c27）— 海绵岗位数据问题批量推送脚本

### 优化调整
- PR #171 alertLabel/riskLabel 合并到 title（general-handoff / onboard-followup / conversation-risk）
- PR #171 **拆分 reply-fact-guard notifier**（4f71a93e）— 从 OpsNotifierService 解耦出独立 service，对话级介入告警走私聊群、不与运营群混发

### 运维与流程
- PR #171 **CI/Docker 供应链加固**（ef49f22d）— GitHub Actions SHA pin、`persist-credentials: false`、移除 `pull-requests: write`；Node base image digest pin、pnpm 锁 10.33.4；`pnpm-workspace` 加 `minimumReleaseAge: 1440 + blockExoticSubdeps`
- PR #174 把 master merge 回 develop，解除 PR #173 冲突

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #171 `pnpm run test` — 2879/2879 全绿
- PR #171 `pnpm run lint` — 干净
- PR #171 关键 false-positive case 加防回归测试覆盖（4 处）
- PR #171 部署后线上观察 4 类告警噪声是否真的下降
- PR #171 部署后视觉确认：general-handoff 卡片红色 🚨、命中原因高亮、4 张业务告警卡 label 字重统一
- PR #174 本地 `git diff origin/develop...HEAD` 为空（确认是纯拓扑 merge，无内容变化）
- PR #174 `.release/pending-release.json` JSON 语法 OK
- PR #174 CHANGELOG pending 块标记完整
- PR #174 pre-push 全量 jest 通过

## [5.6.1] - 2026-05-12

**来源分支**: `develop`

### 更新摘要
- PR #162 **核心修复**：消息管道 pending 队列拆 claim/ack 两步，agent 执行中进程被 SIGKILL 不再丢候选人消息
- PR #162 **附带 UI 修复**：测试套件渲染过滤掉 raw trace 的中间 text part，避免多步生成/重放产生的文本重复显示
- PR #162 **附带文档**：CLAUDE.md 增加分支约定说明（仓库无 main，默认 develop）
- PR #162 **附带测试修复**：dashboard week 测试在周一稳定失败的隐藏 bug（fake timer 固定到周三）
- PR #167 \`CHANGELOG.md\` —— 解决 auto-merge 锚点错位（master 引入的 5.6.0 标题与 develop 的 pending 块叠加），保留 pending 块 + 一份 5.6.0 段落
- PR #167 \`.release/pending-release.json\` —— 保留 develop 的 5.6.1 + PR #162 entries
- PR #168 把 master 真 merge commit 回 develop（修正 PR #167 squash 失效）

### 新功能
- 无

### 问题修复
- PR #162 **核心修复**：消息管道 pending 队列拆 claim/ack 两步，agent 执行中进程被 SIGKILL 不再丢候选人消息
- PR #162 **附带 UI 修复**：测试套件渲染过滤掉 raw trace 的中间 text part，避免多步生成/重放产生的文本重复显示
- PR #162 **附带文档**：CLAUDE.md 增加分支约定说明（仓库无 main，默认 develop）
- PR #162 **附带测试修复**：dashboard week 测试在周一稳定失败的隐藏 bug（fake timer 固定到周三）
- PR #167 \`CHANGELOG.md\` —— 解决 auto-merge 锚点错位（master 引入的 5.6.0 标题与 develop 的 pending 块叠加），保留 pending 块 + 一份 5.6.0 段落
- PR #168 把 master 真 merge commit 回 develop（修正 PR #167 squash 失效）

### 优化调整
- 无

### 运维与流程
- PR #167 \`.release/pending-release.json\` —— 保留 develop 的 5.6.1 + PR #162 entries

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #162 全量 jest 2752 个测试通过
- PR #162 `simple-merge.service.spec.ts` 新增 `claimPendingSnapshot` / `ackPendingMessages` / fromIndex 行为断言
- PR #162 `reply-workflow.service.spec.ts` 同步覆盖 replay 路径 fromIndex 累加
- PR #162 `message.processor.spec.ts` 验证 `initialSnapshotSize` 透传
- PR #162 dashboard week 测试在周一 / 非周一两种系统时间下都通过
- PR #167 全量 jest 2876 个测试通过（pre-push hook 已确认）
- PR #167 JSON 校验通过
- PR #167 CHANGELOG 结构正常（pending 块完整，5.6.0 段落无重复）
- PR #168 git graph 显示 commit \`a7b92930\` 有 2 parent，包含 master 的 \`275d3f1c\`
- PR #168 全量 jest 2876 个测试通过（pre-push hook 已确认）
- PR #168 JSON 校验通过
- PR #168 CHANGELOG 结构完整

## [5.6.0] - 2026-04-30

**来源分支**: `develop`

### 更新摘要
- PR #154 人工介入更顺畅：候选人发"转人工"后 Agent 立即停止抢答，改异步通知运营接手
- PR #154 岗位推荐主动告知具体工作班次：早班/午高峰短班/晚班 + 工时长度 + 工作日，减少候选人入职后发现时段冲突
- PR #154 候选人时段硬筛：候选人声明只能特定时段（如只做晚班）后，召回阶段即过滤掉不匹配岗位，不再推无效岗位
- PR #154 健康证不再阻塞面试：默认"先来面试，录用后再去办"，约面前不主动追问；仅当岗位明确要求"持证才能预约"时才前置确认
- PR #154 发薪/工资问题严禁甩锅：不再允许"到店问/面试时问/店长确认"等敷衍话术
- PR #154 结伴求职分流：两人一起求职、当前门店名额不足时，主动推荐就近同行业门店，避免一人空手
- PR #154 干扰信号下流程仍稳：候选人发"日期已过/改约"等话术时仍照常进入面试预约校验
- PR #154 招聘红线体系精简：从 29 条整合到 13 条，规则更清晰、Agent 更少误触发
- PR #157 把 master（已固化的 v5.5.0）合并回 develop，解除 PR #156（v5.6.0 发版）的冲突
- PR #157 趁机重写 v5.6.0 的 `pending-release.json` + `CHANGELOG.md` 待发布块，按业务视角组织摘要
- PR #159 **结构**：原 \`**本次更新**\` 单列表 → 拆成两段
- PR #159 **业务改动（候选人/运营可感知）**：来源 CHANGELOG \`### 新功能\` + \`### 问题修复\`
- PR #159 **优化与运维（非业务感知）**：来源 CHANGELOG \`### 优化调整\` + \`### 运维与流程\`
- PR #159 **颜色**：success 卡片主色调 \`turquoise\`（青绿）→ \`violet\`（紫）
- PR #159 **兼容**：当结构化段落都为空时，回退到原 \`**本次更新**\` 单列表（保留 v5.5.0 之前老 release 的兼容路径）

### 新功能
- PR #154 人工介入更顺畅：候选人发"转人工"后 Agent 立即停止抢答，改异步通知运营接手
- PR #154 岗位推荐主动告知具体工作班次（早班/午高峰短班/晚班 + 工时长度 + 工作日）
- PR #154 候选人时段硬筛：声明只能特定时段后，召回阶段即过滤掉不匹配岗位
- PR #154 结伴求职分流：当前门店名额不足时，主动推荐就近同行业门店
- PR #159 **结构**：原 \`**本次更新**\` 单列表 → 拆成两段
- PR #159 **颜色**：success 卡片主色调 \`turquoise\`（青绿）→ \`violet\`（紫）

### 问题修复
- PR #154 健康证不再阻塞面试：默认"先来面试，录用后再去办"，约面前不主动追问
- PR #154 发薪/工资问题严禁甩锅：不再允许"到店问/面试时问/店长确认"等敷衍话术
- PR #154 干扰信号下流程仍稳：候选人发"日期已过/改约"时仍照常进入面试预约校验
- PR #159 **业务改动（候选人/运营可感知）**：来源 CHANGELOG \`### 新功能\` + \`### 问题修复\`

### 优化调整
- PR #154 招聘红线体系精简：从 29 条整合到 13 条，prompt 强化"如实呈现/班次时间"
- PR #154 投递层兜底回退：移除发薪甩锅 / 同品牌压缩等静默拦截，投递层只拦内部实现泄漏
- PR #154 班次时间逻辑下沉到工具内部（format-shift-time.util），数据缺失返 null 不补 fallback
- PR #154 死代码清理：未生效 phrase guard / 推断字段 / 监控计数器全部清理
- PR #157 把 master（已固化的 v5.5.0）合并回 develop，解除 PR #156（v5.6.0 发版）的冲突
- PR #159 **优化与运维（非业务感知）**：来源 CHANGELOG \`### 优化调整\` + \`### 运维与流程\`

### 运维与流程
- PR #154 飞书 BadCase 状态双向回写脚本（priority + status 同步）
- PR #154 prod 历史漂移规则回填，test/prod rule_count 对齐
- PR #157 趁机重写 v5.6.0 的 `pending-release.json` + `CHANGELOG.md` 待发布块，按业务视角组织摘要
- PR #159 **兼容**：当结构化段落都为空时，回退到原 \`**本次更新**\` 单列表（保留 v5.5.0 之前老 release 的兼容路径）

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #154 单测全绿：227 套件 / 2719 测试通过
- PR #154 lint + tsc 干净
- PR #154 DB 迁移已 apply test+prod，rule_count 一致
- PR #154 投递层兜底回退后 phrase guard 死代码全部清理
- PR #157 `node -e 'JSON.parse(...)'` 校验 `.release/pending-release.json` 合法
- PR #157 grep 确认无遗留冲突标记
- PR #157 Pre-push hook（lint + format + typecheck + build + jest --coverage）已通过
- PR #157 合并本 PR 后 PR #156 状态变为 MERGEABLE
- PR #159 新增测试：\`renders two-section update when structured release notes are available\`
- PR #159 现有测试：color 期望从 turquoise 改为 violet
- PR #159 现有测试：单列表 fallback（仅 \`### 更新摘要\`）仍走 \`**本次更新**\` 路径
- PR #159 \`pnpm jest tests/scripts/send-deploy-notification.spec.ts\` 全绿（5/5）
- PR #159 Pre-push hook 通过：228 套件 / 2749 测试

## [5.5.0] - 2026-04-29

**来源分支**: `develop`

### 更新摘要
- PR #148 Add badcase traceability and memory fixture support across test-suite imports, execution records, conversation snapshots, and Feishu payload handling.
- PR #148 Add Supabase migrations, backfill/check tooling, and workflow documentation for trace-memory evaluation.
- PR #148 Extend dashboard/business trend RPC support, release/deploy notification formatting, and related frontend test-suite/feedback views.
- PR #148 Tighten prompt, memory, and tool behavior used by candidate consultation badcase validation.
- PR #151 master 已固化 v5.4.0：`.release/pending-release.json` 清空 entries，`CHANGELOG.md` 把 `<!-- release:pending -->` 块替换为 `[5.4.0]` 段
- PR #151 develop 已写入 v5.5.0 待发布数据（来自 PR #148）
- PR #151 `.release/pending-release.json` 取 develop 版本（`baseVersion 5.4.0` / `nextVersion 5.5.0` / 含 #148 entry）
- PR #151 `CHANGELOG.md` 取 develop 版本（保留 v5.5.0 待发布块；`[5.4.0]` 等历史段两边一致）

### 新功能
- PR #148 Add badcase traceability and memory fixture support across test-suite imports, execution records, conversation snapshots, and Feishu payload handling.
- PR #148 Extend dashboard/business trend RPC support, release/deploy notification formatting, and related frontend test-suite/feedback views.
- PR #148 Tighten prompt, memory, and tool behavior used by candidate consultation badcase validation.

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #148 Add Supabase migrations, backfill/check tooling, and workflow documentation for trace-memory evaluation.
- PR #151 master 已固化 v5.4.0：`.release/pending-release.json` 清空 entries，`CHANGELOG.md` 把 `<!-- release:pending -->` 块替换为 `[5.4.0]` 段
- PR #151 develop 已写入 v5.5.0 待发布数据（来自 PR #148）
- PR #151 `.release/pending-release.json` 取 develop 版本（`baseVersion 5.4.0` / `nextVersion 5.5.0` / 含 #148 entry）
- PR #151 `CHANGELOG.md` 取 develop 版本（保留 v5.5.0 待发布块；`[5.4.0]` 等历史段两边一致）

### 配置变更
- 无

### 环境变量提醒
- PR #148 检测到环境变量相关文件变更：`.env.example`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- PR #148 `pnpm run typecheck`
- PR #148 `pnpm exec jest --watchman=false --runTestsByPath tests/biz/monitoring/services/dashboard/analytics-query.service.spec.ts`
- PR #148 Pre-commit hook: lint + format passed
- PR #148 Pre-push hook: `pnpm run ci:check` passed, including lint, format, typecheck, build, and `jest --coverage --watchman=false` (219 suites / 2574 tests)
- PR #151 `node -e 'JSON.parse(...)'` 校验 `.release/pending-release.json` 合法
- PR #151 `grep` 确认无遗留冲突标记
- PR #151 CI Checks 通过
- PR #151 合并本 PR 后 PR #150 状态变为 MERGEABLE

## [5.4.0] - 2026-04-28

**来源分支**: `develop`

### 更新摘要
- PR #141 支持消息流水按托管 BOT 筛选
- PR #140 Hardened interview precheck/booking around `00:00-00:00` date-only windows so deadline-like timestamps are not submitted as concrete interview times.
- PR #140 Added bookable slot metadata and prompt guidance so the agent asks for a valid date/time instead of inventing one.
- PR #140 Updated `invite_to_group` routing to refresh group member counts from the enterprise group list before selecting a group.
- PR #140 Skips groups at or over `GROUP_MEMBER_LIMIT`, retries the next candidate when the invite API reports `-10`, and only alerts when every matching group is full.
- PR #140 Reduces invalid interview booking submissions for special all-day/date-only windows.
- PR #140 Prevents continuing to invite candidates into full part-time groups when another city/industry-matched group is available.
- PR #140 Keeps the group capacity alert reserved for the true overflow case where all matching groups are full.
- PR #145 合并最新 master 到 develop，用于解除 #143 发版 PR 的冲突
- PR #145 保留 develop 的 v5.4.0 待发布元数据
- PR #145 保留 master 已固化的 v5.3.2 发布记录

### 新功能
- PR #141 支持消息流水按托管 BOT 筛选

### 问题修复
- PR #140 Hardened interview precheck/booking around `00:00-00:00` date-only windows so deadline-like timestamps are not submitted as concrete interview times.
- PR #140 Added bookable slot metadata and prompt guidance so the agent asks for a valid date/time instead of inventing one.
- PR #140 Updated `invite_to_group` routing to refresh group member counts from the enterprise group list before selecting a group.
- PR #140 Skips groups at or over `GROUP_MEMBER_LIMIT`, retries the next candidate when the invite API reports `-10`, and only alerts when every matching group is full.
- PR #140 Reduces invalid interview booking submissions for special all-day/date-only windows.
- PR #140 Prevents continuing to invite candidates into full part-time groups when another city/industry-matched group is available.
- PR #140 Keeps the group capacity alert reserved for the true overflow case where all matching groups are full.

### 优化调整
- PR #145 合并最新 master 到 develop，用于解除 #143 发版 PR 的冲突

### 运维与流程
- PR #145 保留 develop 的 v5.4.0 待发布元数据
- PR #145 保留 master 已固化的 v5.3.2 发布记录

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #141 `pnpm jest tests/biz/message/message.controller.spec.ts tests/biz/message/services/message-processing.service.spec.ts tests/biz/message/repositories/message-processing.repository.spec.ts --runInBand --watchman=false`
- PR #141 `pnpm run build:web`
- PR #141 `pnpm run typecheck`
- PR #141 `pnpm run lint:check`
- PR #141 `pnpm run format:check`
- PR #141 `API_GUARD_TOKEN=ci-placeholder-token pnpm run build`
- PR #141 push 前完整 `pnpm run ci:check` 通过：216 suites / 2539 tests
- PR #140 `pnpm jest tests/tools/tool/duliday-interview-precheck.tool.spec.ts tests/tools/tool/duliday-interview-booking.tool.spec.ts tests/tools/tool/invite-to-group.tool.spec.ts --runInBand --watchman=false`
- PR #140 `pnpm run typecheck`
- PR #140 `pnpm run lint:check`
- PR #140 `pnpm prettier --check src/tools/invite-to-group.tool.ts tests/tools/tool/invite-to-group.tool.spec.ts`
- PR #140 `git diff --check`
- PR #140 Pre-push `pnpm run ci:check` passed: 216 test suites, 2540 tests.
- PR #145 JSON parse: package.json / .release/pending-release.json
- PR #145 确认 package.json、CHANGELOG.md、.release/pending-release.json 无冲突标记
- PR #145 git diff --check --cached

## [5.3.2] - 2026-04-28

**来源分支**: `develop`

### 更新摘要
- PR #135 修复部署 workflow 的飞书通知 job 读不到 production 环境 secrets 的问题。
- PR #135 补充 `DEPLOY_NOTIFICATION_WEBHOOK_URL` / `DEPLOY_NOTIFICATION_WEBHOOK_SECRET` 作为旧配置名兜底。
- PR #135 当 webhook 未配置时跳过通知但不阻断发布，避免“代码已部署成功但 workflow 被通知步骤标红”。

### 新功能
- 无

### 问题修复
- PR #135 修复部署 workflow 的飞书通知 job 读不到 production 环境 secrets 的问题。
- PR #135 补充 `DEPLOY_NOTIFICATION_WEBHOOK_URL` / `DEPLOY_NOTIFICATION_WEBHOOK_SECRET` 作为旧配置名兜底。

### 优化调整
- 无

### 运维与流程
- PR #135 当 webhook 未配置时跳过通知但不阻断发布，避免“代码已部署成功但 workflow 被通知步骤标红”。

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #135 ruby YAML 解析 `.github/workflows/deploy.yml` 通过
- PR #135 `pnpm exec prettier --check .github/workflows/deploy.yml`
- PR #135 `REQUIRE_DEPLOY_NOTIFICATION=false node scripts/send-deploy-notification.js`
- PR #135 pre-push `pnpm run ci:check`：216 个测试套件、2532 个测试通过

## [5.3.1] - 2026-04-28

**来源分支**: `develop`

### 更新摘要
- PR #129 在版本元数据 PR 合并到 develop 后，自动创建或更新 develop → master 发版 PR。
- PR #129 修复 scripts/get-release-notes.js 对 CHANGELOG 发布段的提取逻辑，避免 JS 正则不支持 \Z 导致 GitHub Release 创建失败。
- PR #129 发布 workflow 在 tag 已存在但 GitHub Release 缺失/需要更新时，也会继续触发部署，支持半失败恢复。
- PR #129 更新发版文档，明确自动创建流程和本地命令兜底。

### 新功能
- PR #129 发布 workflow 在 tag 已存在但 GitHub Release 缺失/需要更新时，也会继续触发部署，支持半失败恢复。

### 问题修复
- PR #129 修复 scripts/get-release-notes.js 对 CHANGELOG 发布段的提取逻辑，避免 JS 正则不支持 \Z 导致 GitHub Release 创建失败。
- PR #129 更新发版文档，明确自动创建流程和本地命令兜底。

### 优化调整
- PR #129 在版本元数据 PR 合并到 develop 后，自动创建或更新 develop → master 发版 PR。

### 运维与流程
- 无

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #129 node --check scripts/build-release-pr-body.js && node --check scripts/create-release-pr.js && node --check scripts/get-release-notes.js
- PR #129 使用 origin/master 的 CHANGELOG 验证可提取 v5.3.0 发布说明
- PR #129 pnpm release:pr:preview
- PR #129 ruby YAML 解析 .github/workflows/version-changelog.yml 通过
- PR #129 pnpm exec prettier --check .github/workflows/version-changelog.yml scripts/get-release-notes.js
- PR #129 pre-push pnpm run ci:check：216 个测试套件、2532 个测试通过

## [5.3.0] - 2026-04-28

**来源分支**: `develop`

### 更新摘要
- PR #111 发布部署流水线支持 tag 触发与环境变量同步提醒
- PR #115 测试套件验证流程增强 + 数据集策展硬闸门
- PR #118 Agent 思考/工具/回复链可视化重放与运营视角文档
- PR #120 修复企微图片/文本合并处理，以及预约与仪表盘统计记录
- PR #120 托管用户运营页支持搜索、稳定排序、BOT 筛选和真实配置数据
- PR #120 消息处理详情抽屉新增好/坏反馈，并将 Batch ID 回写飞书
- PR #120 优化反馈成功/失败状态展示，并补充后端错误详情
- PR #120 优化待发布说明和部署通知格式
- PR #123 准备 Web 后台发版改动
- PR #125 新增 Release PR Autofill：develop → master 发版 PR 创建后，自动从 CHANGELOG.md 待发布内容生成中文标题和正文。
- PR #125 增加本地发版 PR 命令：pnpm release:pr:preview 预览，pnpm release:pr:create 创建或更新 develop → master PR。
- PR #125 更新 PR 模板和发版文档，说明发版 PR 可以先填临时标题，也可以用命令避免手填。

### 新功能
- PR #115 测试套件新增校验标题字段，前端重写复核弹窗、执行详情与对话列表组件
- PR #115 测试批次导入与回写飞书的服务链路完善
- PR #118 Agent 响应快照持久化，前端在执行详情按思考链 → 工具调用 → 回复链单一来源还原
- PR #118 新增运营/产品视角的 Agent 运行时与工作流文档，并与研发版架构文档交叉链接
- PR #123 准备 Web 后台发版改动
- PR #125 新增 Release PR Autofill：develop → master 发版 PR 创建后，自动从 CHANGELOG.md 待发布内容生成中文标题和正文。

### 问题修复
- PR #120 修复企微图片/文本合并处理，以及预约与仪表盘统计记录

### 优化调整
- PR #115 收紧 badcase 数据集策展规则
- PR #118 批次状态机放开 completed → reviewing，支持单条重跑后重新评审
- PR #120 托管用户运营页支持搜索、稳定排序、BOT 筛选和真实配置数据

### 运维与流程
- PR #111 发布工作流在打 tag、创建 GitHub Release 之后自动触发部署，避免受保护分支推送不触发下游
- PR #111 部署工作流支持手动指定 tag 触发，便于回滚或定向重发
- PR #111 PR 合并后在变更记录中标记环境变量相关文件，提示生产侧手动同步
- PR #120 消息处理详情抽屉新增好/坏反馈，并将 Batch ID 回写飞书
- PR #120 优化反馈成功/失败状态展示，并补充后端错误详情
- PR #120 优化待发布说明和部署通知格式
- PR #125 增加本地发版 PR 命令：pnpm release:pr:preview 预览，pnpm release:pr:create 创建或更新 develop → master PR。
- PR #125 更新 PR 模板和发版文档，说明发版 PR 可以先填临时标题，也可以用命令避免手填。

### 配置变更
- 无

### 环境变量提醒
- PR #115 检测到环境变量相关文件变更：`.env.example`、`src/infra/config/env.validation.ts`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- PR #111 pnpm run ci:check 通过：216 suites / 2515 tests
- PR #115 测试环境已应用 validation_title 字段迁移
- PR #115 Dashboard 测试套件列表 / 执行详情 / 对话复核弹窗回归通过
- PR #118 pnpm run test:ci 通过：216 suites / 2526 tests
- PR #118 pnpm run lint:check / format:check / typecheck 全部通过
- PR #120 pnpm run ci:check
- PR #120 pre-push hook passed: 216 suites / 2532 tests
- PR #123 pre-commit: `pnpm run lint` + `pnpm run format` 通过。
- PR #123 pre-push: `pnpm run ci:check` 通过。
- PR #123 `ci:check` 覆盖：`lint:check`、`format:check`、`typecheck`、`build:ci`、`test:ci`。
- PR #123 `test:ci`: 216 suites / 2532 tests passed。
- PR #125 node --check scripts/build-release-pr-body.js
- PR #125 node --check scripts/create-release-pr.js
- PR #125 pnpm release:pr:preview
- PR #125 pnpm exec prettier --check package.json scripts/create-release-pr.js docs/workflows/version-release-guide.md
- PR #125 pre-push pnpm run ci:check：216 个测试套件、2532 个测试通过
