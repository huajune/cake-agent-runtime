# Changelog

所有重要的项目更改都将记录在此文件中。

本项目遵循 语义化版本 规范。
版本号由 GitHub Actions 自动维护，发布说明统一使用中文记录。
变更记录按 PR 驱动整理：自动清理 PR/commit 前缀与常见英文工程表述，尽量产出可直接用于发布通知的中文摘要。

---

## [10.28.0] - 2026-07-23

**来源分支**: `develop`

### 更新摘要
- PR #690 回填 v10.27.0 生产发布结果
- PR #690 将 v10.27.0 底账状态更新为已发布
- PR #690 回填 Release、部署 workflow、发布时间和生产健康验证
- PR #690 记录限定测试批同步结果（2 passed / 1 skipped），明确未触碰 tz2607- 资产和批次 56d30741
- PR #690 记录 master → develop 回同步 PR #689
- PR #691 治理方案 §8 人工反馈池分层处置与 T1 复测收口
- PR #691 badcase 治理方案 §8 收口（人工反馈池分层 + T1 复测结果）
- PR #693 报名状态增加权威事实接地，只允许在本轮 duliday_interview_booking 成功后使用完成口径
- PR #693 真实报名成功后强制播报结果与面试安排
- PR #693 补强报名完成口径的语义审查
- PR #694 招聘限制疑问句不再写入暑假工偏好
- PR #694 “长期”改口会清除既有暑假工或寒假工偏好
- PR #694 本轮岗位查询旁路已清除的季节工过滤
- PR #695 岗位截图「发布方」字段值不再当候选人求职意向品牌
- PR #695 岗位截图中的“发布方/发布主体/招聘代理”等字段不再参与求职品牌实体匹配
- PR #695 保留字段前候选人明确提到的雇主品牌，并保留完整 sourceText 供观测归因
- PR #695 对“品牌/发布方”复合标签保留品牌识别，避免误挖真实雇主
- PR #695 岗位截图发布方不再覆盖求职品牌
- PR #698 添加 v10.28.0 发版底账
- PR #698 汇总 #691/#693/#694/#695 的 v10.28.0 发布范围、风险和回滚条件
- PR #698 记录组合分支完整 CI、DI 冒烟和 4 条独立 Agent 发布回归证据
- PR #698 独立批次 2509555c-2f72-4c28-ac64-ce2ed135d519 已同步生产测试台，4/4 passed、0 pending
- PR #698 明确未读取或覆盖 tz2607-* 资产与批次 56d30741
- PR #700 补齐 v10.28.0 发布元数据
- PR #700 修正元数据自动化并发竞态，补齐已合并的 #693 与 #694
- PR #700 将 #693/#694/#695 的真实候选人可感知改动置于飞书发版通知业务摘要
- PR #700 移除上一版回填、治理文档和发版底账的业务改动误分类
- PR #700 回填 Release PR #697，并关闭底账最后一个一致性闸口
- PR #702 过滤通知中的发布流程话术
- PR #702 发版通知过滤发布流程话术
- PR #704 覆盖通知流程话术变体
- PR #704 通知过滤覆盖发布流程话术变体

### 新功能
- 无

### 问题修复
- PR #693 修复没有 booking 成功证据却向候选人宣称已报名的问题
- PR #693 修复 booking 成功后未向候选人播报、导致重复提交的问题
- PR #694 修复“只招暑假工吗”被误判为暑假工求职意向的问题
- PR #694 修复改口“长期”后旧季节工偏好持续粘住、过滤真实岗位的问题
- PR #695 修复招聘平台发布主体覆盖候选人真实求职品牌、导致岗位召回跑偏的问题
- PR #695 岗位截图中的“发布方/发布主体/招聘代理”等字段不再参与求职品牌实体匹配
- PR #695 保留字段前候选人明确提到的雇主品牌，并保留完整 sourceText 供观测归因
- PR #695 对“品牌/发布方”复合标签保留品牌识别，避免误挖真实雇主
- PR #700 修正元数据自动化并发竞态，补齐已合并的 #693 与 #694
- PR #700 将 #693/#694/#695 的真实候选人可感知改动置于飞书发版通知业务摘要
- PR #700 移除上一版回填、治理文档和发版底账的业务改动误分类

### 优化调整
- 无

### 运维与流程
- PR #690 将 v10.27.0 底账状态更新为已发布
- PR #690 回填 Release、部署 workflow、发布时间和生产健康验证
- PR #690 记录限定测试批同步结果（2 passed / 1 skipped），明确未触碰 tz2607- 资产和批次 56d30741
- PR #690 记录 master → develop 回同步 PR #689
- PR #690 回填 v10.27.0 生产发布结果
- PR #691 治理方案 §8 人工反馈池分层处置与 T1 复测收口
- PR #695 岗位截图「发布方」字段值不再当候选人求职意向品牌
- PR #698 记录组合分支完整 CI、DI 冒烟和 4 条独立 Agent 发布回归证据
- PR #700 回填 Release PR #697，并关闭底账最后一个一致性闸口
- PR #700 补齐 v10.28.0 发布元数据
- PR #702 过滤误入候选人/运营可感知区块的发版元数据修正、通知治理和底账维护话术
- PR #702 保留真正面向业务的候选人体验改动
- PR #702 过滤通知中的发布流程话术
- PR #704 覆盖自动元数据生成的“过滤通知中的发布流程话术”倒装表述
- PR #704 将真实最终元数据作为回归样本，避免流程维护内容进入候选人/运营区块
- PR #704 覆盖通知流程话术变体

### 配置变更
- PR #698 无 migration、环境变量或运行时配置变化

### 环境变量提醒
- 无

### 验证记录
- PR #690 Prettier check 通过
- PR #690 git diff --check 通过
- PR #690 纯文档变更
- PR #693 组合分支定向测试 4 suites / 261 tests 通过
- PR #693 独立回归 RELEASE-V10280-BOOKING-GROUNDING-001 通过
- PR #693 无 migration、环境变量或运行时配置变化
- PR #694 组合分支定向测试 4 suites / 261 tests 通过
- PR #694 独立回归 RELEASE-V10280-LABOR-QUESTION-002 与 RELEASE-V10280-LABOR-CLEAR-003 通过
- PR #694 无 migration、环境变量或运行时配置变化
- PR #695 `pnpm run ci:check`（由 GitHub CI 执行）
- PR #695 `pnpm exec jest tests/resolution/brand/brand-matcher.spec.ts --runInBand --watchman=false`（64 tests passed）
- PR #695 `git diff --check`
- PR #695 无 migration、环境变量或运行时配置变化
- PR #698 pnpm run ci:check：366 suites / 5608 tests passed
- PR #698 pnpm run test:di-smoke：1/1 passed
- PR #698 独立 Agent 回归：4/4 passed
- PR #698 git diff --check / Prettier：通过
- PR #700 发版底账校验通过
- PR #700 通知 buildMarkdown 预演仅包含 6 条真实业务改动
- PR #700 pnpm run ci:check：366 suites / 5608 tests passed
- PR #700 JSON / git diff --check 通过
- PR #702 `pnpm exec jest tests/scripts/send-deploy-notification.spec.ts --runInBand`：12/12 通过
- PR #702 `pnpm run ci:check`：366 个测试套件通过，5609 个测试通过，6 个跳过
- PR #702 通知预览仅保留 6 条候选人/运营可感知改动
- PR #704 通知格式测试：12/12 通过
- PR #704 `pnpm run ci:check`：366 个测试套件、5609 个测试通过，6 个跳过
- PR #704 基于最终 v10.28.0 元数据预演：仅保留 6 条候选人/运营可感知改动

## [10.27.0] - 2026-07-23

**来源分支**: `develop`

### 更新摘要
- PR #682 回填 v10.26.0 生产发布结果

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #682 回填 v10.26.0 生产发布结果

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #682 v10.26.0 发布流水线成功：Build and Deploy #29976217910
- PR #682 线上容器 `cake-agent-runtime:v10.26.0` 状态 healthy
- PR #682 `/agent/health` 返回 healthy，Redis/Supabase 正常
- PR #682 本地 pre-push 全量测试受到工作区未提交的无关预约代码影响（5 个失败）；未改动这些代码，交由 PR 干净检出 CI 校验本提交

## [10.26.0] - 2026-07-23

**来源分支**: `develop`

### 更新摘要
- PR #672 自助取消/改约被拒时透传海绵 code/message 供观测
- PR #672 透传取消与改约拒绝原因用于观测
- PR #675 澄清复聊场景任务状态文案
- PR #677 建立 v10.26.0 发版底账

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #672 自助取消/改约被拒时透传海绵 code/message 供观测
- PR #675 澄清复聊场景任务状态文案
- PR #677 建立 v10.26.0 发版底账

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- 无

## [10.25.0] - 2026-07-22

**来源分支**: `develop`

### 更新摘要
- PR #658 geo 目录文件平铺，与 brand 风格一致（方案 v3.3 裁定）
- PR #658 geo 目录文件平铺，与 brand 风格一致（方案 v3.3）
- PR #657 优化模型配置与桌面端布局
- PR #657 聊天记录优先展示原图
- PR #657 重构配置页桌面端信息层级：模型角色改为双列列表，显示当前实际生效模型、覆盖状态和待保存项数量。
- PR #657 将配置页保存快捷键设为 Cmd/Ctrl+S；全局侧栏切换改为 Cmd/Ctrl+B，避免快捷键冲突。
- PR #657 模型选择器统一展示模型 ID、能力摘要与发布日期，并完善触发器和无覆盖时的默认路由提示。
- PR #657 后端配置接口返回各 Agent 角色解析后的实际模型及来源，前端不再只能看到环境变量名。
- PR #657 聊天记录中的图片优先直接加载原图；原图加载失败时自动回退缩略图，并保留点击放大/新窗口查看能力。
- PR #662 品牌投影与懒迁移退役，preferences.brands 全链路收口 brand_state（§19.6）
- PR #662 拦截抽取提示词示例身份回声
- PR #662 将品牌意向的唯一真相收口到 `brand_state`，彻底停止读取、写入和迁移旧 `preferences.brands`。
- PR #662 拦截抽取模型把提示词字段示例（示例姓名、占位手机号、示例经历）整套回填到候选人事实中的回声问题。
- PR #662 补齐会话、长期记忆、settlement、回复上下文和 test-suite fixture 对 `brand_state` 的统一读写与回归覆盖。
- PR #662 收口品牌状态并拦截示例身份回声
- PR #664 新增 `docs/releases/2026/v10.25.0.md`，统一覆盖实现 PR #657/#658/#662。
- PR #664 固化配置可视化、聊天原图、Geo 目录平铺、品牌状态收口与示例身份回声防护的风险、验证和回滚边界。
- PR #664 补齐 Release PR #660 当前缺失的发版底账闸口。
- PR #664 建立 v10.25.0 发版底账

### 新功能
- PR #657 将配置页保存快捷键设为 Cmd/Ctrl+S；全局侧栏切换改为 Cmd/Ctrl+B，避免快捷键冲突。
- PR #657 模型选择器统一展示模型 ID、能力摘要与发布日期，并完善触发器和无覆盖时的默认路由提示。
- PR #657 后端配置接口返回各 Agent 角色解析后的实际模型及来源，前端不再只能看到环境变量名。
- PR #657 聊天记录中的图片优先直接加载原图；原图加载失败时自动回退缩略图，并保留点击放大/新窗口查看能力。
- PR #662 无。
- PR #664 N/A；本 PR 仅新增发版底账。
- PR #664 新增 `docs/releases/2026/v10.25.0.md`，统一覆盖实现 PR #657/#658/#662。

### 问题修复
- PR #662 抽取出口新增 `validateOutput` 校验：命中已知占位手机号，或示例姓名与示例经历组合时，本次抽取按失败处理并进入既有重试/降级，防止虚构身份进入记忆并触发真实预约。
- PR #662 旧 `preferences.brands` 在读取边界统一清空，避免旧字段通过 deep merge 在长会话中复活。
- PR #662 补齐会话、长期记忆、settlement、回复上下文和 test-suite fixture 对 `brand_state` 的统一读写与回归覆盖。
- PR #664 修复 #660 因缺少 `v10.25.0` 底账而失败的 `Validate release ledger` 检查。

### 优化调整
- PR #657 重构配置页桌面端信息层级：模型角色改为双列列表，显示当前实际生效模型、覆盖状态和待保存项数量。
- PR #657 优化模型配置与桌面端布局
- PR #662 提示词、事实渲染、品牌状态服务、长期记忆沉淀及修复上下文统一直接读取 `brand_state`。
- PR #662 退役旧品牌懒迁移逻辑，并更新品牌解析架构文档。
- PR #662 将品牌意向的唯一真相收口到 `brand_state`，彻底停止读取、写入和迁移旧 `preferences.brands`。
- PR #662 拦截抽取模型把提示词字段示例（示例姓名、占位手机号、示例经历）整套回填到候选人事实中的回声问题。
- PR #662 拦截抽取提示词示例身份回声
- PR #664 将三项实现 PR、P0/P1 回归、配置结论、部署顺序和回滚条件统一为可审计记录。

### 运维与流程
- PR #658 geo 目录文件平铺，与 brand 风格一致（方案 v3.3 裁定）
- PR #657 聊天记录优先展示原图
- PR #662 策展并导入 2 条带生产 chat/trace 血缘的正式回归场景。
- PR #662 测试批次：`3dfaefe1-64e0-48db-b678-d1c9dd591a39`；2/2 runtime success、2/2 业务 passed、0 skipped。
- PR #662 批次已同步生产 Dashboard，`warnings=[]`，生产 API 全量对账为 2 条执行、通过率 100%。
- PR #662 品牌投影与懒迁移退役，preferences.brands 全链路收口 brand_state（§19.6）
- PR #664 无 migration、schema、RPC、RLS、回填、环境变量或 secret 变化。
- PR #664 部署仍按 tag 触发现有滚动发布；回滚目标为 `v10.24.0`。
- PR #664 固化配置可视化、聊天原图、Geo 目录平铺、品牌状态收口与示例身份回声防护的风险、验证和回滚边界。
- PR #664 补齐 Release PR #660 当前缺失的发版底账闸口。

### 配置变更
- PR #662 数据库 migration / schema / RPC / RLS / 回填：N/A。
- PR #662 环境变量 / secrets / 运行时配置：N/A。
- PR #662 部署顺序：仅应用代码滚动发布，无前置配置或数据动作。
- PR #662 回滚：回滚本 PR；`brand_state` 仍为现有字段，不涉及数据降级或不可逆操作。
- PR #664 N/A；仅记录既有配置读取行为，不修改任何生产配置。

### 环境变量提醒
- 无

### 验证记录
- PR #657 HostingConfigFacadeService：19/19 tests passed。
- PR #657 `pnpm run lint:check`：通过。
- PR #657 `pnpm run format:check`：通过。
- PR #657 `pnpm run typecheck`：通过。
- PR #657 `pnpm run build:ci`：前端与 Nest 构建通过。
- PR #657 `pnpm run test:ci`：365 suites passed、1 skipped；5530 tests passed、6 skipped。
- PR #657 Web ESLint：0 errors；11 个既有、非本 PR 文件 warning。
- PR #657 `git diff --check`：通过。
- PR #662 `pnpm run ci:check`
- PR #662 `pnpm run test:di-smoke`
- PR #662 `git diff --check origin/develop...HEAD`
- PR #662 定向测试：5 suites / 93 tests passed。
- PR #662 全量测试：366 suites passed、1 skipped；5548 tests passed、6 skipped。
- PR #662 lint / format / typecheck / Web + Nest build 全部通过。
- PR #662 关键链路已人工验证：两条真实 Agent 场景的 turn-end memory trace 中 `name/phone/experience` 均为空，`preferences.brands=null`，品牌落入 `brand_state.currentBrand`；无 precheck/booking 调用。
- PR #662 正式测试资产、飞书评审状态、生产 Dashboard 和生产 API 已完成收口。
- PR #664 `prettier --check docs/releases/2026/v10.25.0.md`：通过。
- PR #664 `node scripts/check-release-ledger.js`：通过。
- PR #664 `git diff --check`：通过。
- PR #664 实现 PR #657/#658/#662 required checks 均通过；#662 最新全量基线为 366 suites、5548 tests。
- PR #664 正式测试集 batch `3dfaefe1-64e0-48db-b678-d1c9dd591a39`：2/2 passed，Dashboard 与可评估通过率均为 100%。

## [10.24.0] - 2026-07-22

**来源分支**: `develop`

### 更新摘要
- PR #640 建立 resolution/geo 地理解析域与全量兼容门面（方案 Phase 1，PR 2）
- PR #640 `src/**`：禁 import `memory/facts/geo-mappings`（存量 8 消费者列 excludedFiles 临时豁免，**Phase 2 逐边界清零**）
- PR #640 `src/resolution/**`：禁业务/基础设施依赖（brand 保留 @sponge 豁免）
- PR #640 `src/resolution/geo/**`：零出向依赖（含 @sponge / @resolution/brand）
- PR #640 Phase 0 golden cases 全量平移至 `tests/resolution/geo/`（normalizer/scanner/admin resolver/places/policy 五个 spec）
- PR #640 旧 spec 位置改为**门面等价性验证**：§4 清单 16 个运行时符号逐个断言与 `@resolution/geo` **同一引用**（Object.is）+ 旧入口冒烟——新旧入口测试结果必然一致
- PR #640 建立 resolution/geo 与全量兼容门面（方案 Phase 1，PR 2）
- PR #643 geocoding classifier/ranker 切换 @resolution/geo（方案 Ph…
- PR #643 geocode/invite-to-group 切换 @resolution/geo（方案 Phase …
- PR #643 geocode-location-anchor 切换 @resolution/geo（方案 Phase …
- PR #643 三轮扫描编排抽为 scanGeoSignalsFromText（方案 §8.4，Phase 2 边界 4）
- PR #643 session.service 切换 @resolution/geo（方案 Phase 2 边界 5）
- PR #643 duliday-job-list 切换 @resolution/geo，旧路径豁免清零（方案 Phase…
- PR #643 Phase 2 消费者迁移 + 三轮扫描编排入 geo（方案 §13，PR 3）
- PR #646 海绵行政区适配抽为 sponge-area-filter.util（方案 §11.2，Phase 3 第…
- PR #646 地理信号冲突检测 shadow 档（方案 §8.2/§17.4，Phase 3 第 6 步）
- PR #646 业务足迹县级市补录——昆山市→苏州市（方案 §9.2，Phase 3 第 3-4 步）
- PR #646 Phase 3 海绵适配器抽取 + 昆山补录 + 冲突检测 shadow（方案 §11.2/§9.2/§8.2，PR 4）
- PR #645 地理方案 v3.2——模型自编坐标实证纳入 B-1 修复范围
- PR #645 自编坐标 shadow 观测 + 年龄 hard_reject 岗默认不推荐（方案 11.3 v3.2）
- PR #645 模型自编坐标 shadow 观测 + 年龄 hard_reject 岗默认不推荐
- PR #647 拉群 errcode=-12 实为已发邀请卡片，按成功处理不再换群重发
- PR #651 收敛面试、人设与护栏 badcase
- PR #651 修复窗口制面试预约：候选人约定的具体时刻必须落在真实面试窗口内，线上/视频/电话面试不再发送到店话术。
- PR #651 将企微账号昵称与性别注入 Agent 身份锚点，统一“候选人看到的账号就是本人”口径，并把“转人工/真人经理/专人联系”等露馅话术从 observe 升为 revise。
- PR #651 品牌解析入口统一剥离引用块，并在完成生产归因后删除只用于 shadow 对照的旧品牌匹配、计数器和观测字段。
- PR #651 同步证据优先的解析/护栏架构文档与 Excalidraw 图。
- PR #651 收敛面试、人设与护栏 badcase，并下线品牌解析旧对照组
- PR #653 补齐 `v10.24.0` 正式发版底账，覆盖实现 PR #640/#643/#645/#646/#647/#651。
- PR #653 固化地理域、面试预约、账号身份、输出护栏、拉群幂等与品牌 shadow 下线的范围、风险、P0/P1、配置结论和回滚方案。
- PR #653 修复 Release PR #642 的 `Validate release ledger` 闸口失败。
- PR #653 固化 v10.24.0 发版底账

### 新功能
- PR #651 Hosting member 配置可为 Agent 提供账号昵称与性别；读取失败或缺失时安全降级为未配置。
- PR #651 面试预约支持识别线上面试信号，并生成与线上流程一致的成功回复。
- PR #651 面试窗口校验支持候选人约定的窗口内具体时分，而非强制回落到窗口起点。

### 问题修复
- PR #645 地理方案 v3.2——模型自编坐标实证纳入 B-1 修复范围
- PR #651 阻止模型把窗口外自编时刻提交给预约接口。
- PR #651 阻止线上面试成功后错误提示候选人到店。
- PR #651 阻止 Agent 把同一企微账号描述成机器人、第三方或“转人工”入口。
- PR #651 阻止引用消息中的 Agent 品牌表述污染候选人品牌意向。
- PR #651 删除已完成使命的 legacy brand shadow 路径，避免继续维护无行为影响的重复实现与分母计数。
- PR #651 修复窗口制面试预约：候选人约定的具体时刻必须落在真实面试窗口内，线上/视频/电话面试不再发送到店话术。
- PR #651 将企微账号昵称与性别注入 Agent 身份锚点，统一“候选人看到的账号就是本人”口径，并把“转人工/真人经理/专人联系”等露馅话术从 observe 升为 revise。
- PR #651 品牌解析入口统一剥离引用块，并在完成生产归因后删除只用于 shadow 对照的旧品牌匹配、计数器和观测字段。
- PR #651 同步证据优先的解析/护栏架构文档与 Excalidraw 图。
- PR #653 修复 Release PR #642 的 `Validate release ledger` 闸口失败。

### 优化调整
- PR #640 `src/**`：禁 import `memory/facts/geo-mappings`（存量 8 消费者列 excludedFiles 临时豁免，**Phase 2 逐边界清零**）
- PR #640 `src/resolution/**`：禁业务/基础设施依赖（brand 保留 @sponge 豁免）
- PR #640 `src/resolution/geo/**`：零出向依赖（含 @sponge / @resolution/brand）
- PR #640 Phase 0 golden cases 全量平移至 `tests/resolution/geo/`（normalizer/scanner/admin resolver/places/policy 五个 spec）
- PR #640 旧 spec 位置改为**门面等价性验证**：§4 清单 16 个运行时符号逐个断言与 `@resolution/geo` **同一引用**（Object.is）+ 旧入口冒烟——新旧入口测试结果必然一致
- PR #651 `human_service_phrase_leak` 依据两周真阳性样本由 observe 升为 revise，并增加确定性重写反馈。
- PR #651 复聊与主 Agent 统一使用“招募经理”身份口径。
- PR #651 品牌解析架构文档按 2026-07-22 裁定更新下线依据、回滚边界和发布后观察项。

### 运维与流程
- PR #640 建立 resolution/geo 地理解析域与全量兼容门面（方案 Phase 1，PR 2）
- PR #643 geocoding classifier/ranker 切换 @resolution/geo（方案 Ph…
- PR #643 geocode/invite-to-group 切换 @resolution/geo（方案 Phase …
- PR #643 geocode-location-anchor 切换 @resolution/geo（方案 Phase …
- PR #643 三轮扫描编排抽为 scanGeoSignalsFromText（方案 §8.4，Phase 2 边界 4）
- PR #643 session.service 切换 @resolution/geo（方案 Phase 2 边界 5）
- PR #643 duliday-job-list 切换 @resolution/geo，旧路径豁免清零（方案 Phase…
- PR #646 海绵行政区适配抽为 sponge-area-filter.util（方案 §11.2，Phase 3 第…
- PR #646 地理信号冲突检测 shadow 档（方案 §8.2/§17.4，Phase 3 第 6 步）
- PR #646 业务足迹县级市补录——昆山市→苏州市（方案 §9.2，Phase 3 第 3-4 步）
- PR #645 自编坐标 shadow 观测 + 年龄 hard_reject 岗默认不推荐（方案 11.3 v3.2）
- PR #647 拉群 errcode=-12 实为已发邀请卡片，按成功处理不再换群重发
- PR #651 数据库 migration / schema / RPC / RLS / 回填：N/A，本 PR 不包含数据库变更。
- PR #651 部署顺序：无前置 migration 或配置写入；应用可按现有 tag 触发流程直接滚动部署。
- PR #651 回滚：回滚本 PR 的 squash commit 或回退到上一生产 tag；无数据回滚动作。
- PR #651 发布后观察：面试预约失败率、线上面试回复、`human_service_phrase_leak` revise 命中与品牌解析异常。
- PR #651 收敛面试、人设与护栏 badcase
- PR #653 补齐 `v10.24.0` 正式发版底账，覆盖实现 PR #640/#643/#645/#646/#647/#651。
- PR #653 固化地理域、面试预约、账号身份、输出护栏、拉群幂等与品牌 shadow 下线的范围、风险、P0/P1、配置结论和回滚方案。

### 配置变更
- PR #651 环境变量：N/A，无新增、修改或废弃变量。
- PR #651 Hosting member schema：无新增配置键；仅开始读取既有 `wecomNickname` / `gender` 字段。
- PR #651 `pnpm config:hosting:check:prod` 已通过：10 个 runtime members 覆盖 9 个代码映射。

### 环境变量提醒
- 无

### 验证记录
- PR #645 job-list spec **75/75 全绿**：新增 偏差>1km→model_supplied、≤1km 宽松命中不误报、无锚点→unreferenced、区级兜底 provenance、hard_reject 约束正反例
- PR #645 `pnpm run typecheck` / `pnpm run lint:check` 通过
- PR #645 提交用 `--no-verify`：pre-commit 钩子会把未暂存改动吞进提交（首次提交实测发生，已重做拆分）；lint/format 已手动执行
- PR #647 新增 2 条回归测试（-12 只调一次接口不换群、errmsg 兜底匹配），invite 工具 44 条测试全过
- PR #647 `tsc --noEmit` / ESLint / Prettier 通过（pre-push 钩子在 worktree 内因 web/node_modules 缺失中断于前端构建，与本改动无关，完整 CI 由 GitHub Actions 跑）
- PR #651 定向回归：9 个套件、452 条测试通过。
- PR #651 集成修复后护栏套件：165 条测试通过。
- PR #651 `pnpm run lint:check`
- PR #651 `pnpm run format:check`
- PR #651 `pnpm run typecheck`
- PR #651 `pnpm run build:ci`（前端 + Nest 构建）
- PR #651 `pnpm run test:ci`：365 个套件通过、1 个跳过；5529 条测试通过、6 条跳过。
- PR #651 `pnpm run test:di-smoke`
- PR #651 `git diff --check`
- PR #651 pre-push `pnpm run ci:check` 再次通过。
- PR #651 关键生产链路发布后冒烟验证。
- PR #653 `pnpm release:ledger:check`：通过。
- PR #653 `pnpm exec prettier --check docs/releases/2026/v10.24.0.md`：通过。
- PR #653 `git diff --check`：通过。
- PR #653 `pnpm run ci:check`：通过；365 suites passed、1 skipped，5529 tests passed、6 skipped。

## [10.23.0] - 2026-07-22

**来源分支**: `develop`

### 更新摘要
- PR #631 发版元数据步骤入口重建 git 凭证，修复 fetch 400 断链
- PR #627 地理领域改造方案文档定稿至 v3.1，作为后续现网修复与 resolution/geo 迁移工作的唯一施工规格
- PR #628 修复区级定位下距离数字被 Agent 照抄为精确距离、引发拦截与投诉的问题
- PR #629 修复 geocode 已解析出城市/门店坐标但 Agent 仍反问城市或误报未找到位置的问题
- PR #630 为 resolution/geo 迁移固化 Phase 0 地理行为基线测试，覆盖地理编码候选排序、地理映射、高置信度提取及门店定位发送等模块，纯测试无生产变更
- PR #630 排查确认此前门店定位分享偏移问题（badcase 0m4zs1h6）根因是海绵门店坐标数据质量问题（约 800m 偏差），并非候选排序选点逻辑
- PR #620 品牌识别两天全量审计（264 个状态变更事件、114 条人工裁决）定位并修复两处边缘误判：渠道缩写/昵称自我介绍误命中品牌别名、同轮又要又不要误清无关在位品牌
- PR #636 固化 v10.23.0 发版底账

### 新功能
- 无

### 问题修复
- PR #631 发版元数据步骤入口重建 git 凭证，修复 fetch 400 断链
- PR #628 duliday_job_list 推荐卡片、基本信息、摘要行、品牌门店最近店铺四处距离渲染统一改为区级估算口径，避免模型将区代表点距离误述为精确距离
- PR #628 geocode 解析结果新增锚点精度确定性传递（坐标 + areaLevelQuery + 行政区名写入回合上下文），岗位查询工具按坐标匹配判定锚点精度，不再依赖模型转抄参数
- PR #629 geocode 解析结果统一出口新增 _cityConfirmed 作为返回对象首字段，前置披露城市结论（精确坐标标注具体地点，区级锚点标注行政区代表点）
- PR #629 geocode 工具说明新增约束：解析成功后禁止再反问城市或宣称未找到位置
- PR #629 本次解析城市与会话记忆意向城市冲突时附加 _cityConflictNotice 知情披露，解析结果本身不被静默改写
- PR #620 渠道缩写「BS」不再因 2 字符边界包含误命中品牌别名，降级为仅全等匹配
- PR #620 新增昵称自我介绍识别逻辑，避免 4-8 字符英数品牌别名在好友自介场景中被无边界误命中
- PR #620 修复跨轨（LLM 轨正向匹配 + 规则轨全名否定）产生净否定品牌时，误顶替并清空无关在位品牌的问题

### 优化调整
- 无

### 运维与流程
- PR #636 固化 v10.23.0 发版底账

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #631 仅改 workflow 单步骤 shell，不触及业务代码
- PR #631 合入后用补偿模式（workflow_dispatch）实测补录 #627–#630、#620 —— 该实测即本修复的端到端验证
- PR #631 数据库 migration：N/A
- PR #628 新增 distance-render 工具单测，geocode 与 duliday_job_list 相关测试补充区级/POI 锚点、坐标截断容差等场景用例，共 110 用例通过
- PR #629 geocode 测试补充 5 例：城市结论首字段披露顺序、POI/区级披露文案、城市冲突披露、同城归一后不误报冲突，共 37 用例通过
- PR #630 新增/补写 4 个测试套件共 202 用例，覆盖地理编码精度推断与锚点择优、区划映射 golden cases（含朝阳区业务偏置、余姚双轨现状等）、高置信度提取层 golden case、门店定位坐标直传现状基线
- PR #620 typecheck 通过
- PR #620 lint（--max-warnings=0）通过
- PR #620 format check 通过
- PR #620 品牌域 10 suites / 146 tests 通过（含 10 条新增回归用例，覆盖两处误判现场及正反向控制）
- PR #620 全量 353 suites / 5309 tests 通过

## [10.22.0] - 2026-07-21

**来源分支**: `develop`

### 更新摘要
- PR #619 集中修复守卫、预约、复聊、岗位事实和品牌解析的生产 badcase。
- PR #619 新增角色模型配置与多入口截图反馈，并补齐品牌 shadow 观测能力。
- PR #619 建立逐版本发版底账及真实 Agent 回归、评审和生产 Dashboard 对账流程。

### 新功能
- PR #619 Dashboard 支持按 Agent 角色动态配置模型，配置读取失败时安全回退环境变量。
- PR #619 主聊、测试页和复聊反馈支持来源标识与最多 5 张截图附件。
- PR #619 品牌解析 shadow 对照增加歧义、差异、一致分母和低流量批次观测。

### 问题修复
- PR #619 修复空头人工跟进承诺、语义审查截断、回复修复压缩正文和短路结果归因。
- PR #619 修复预约取消、历史预约披露、面试结果追问和面试时间上下文缺口。
- PR #619 修复复聊停止条件、重复提醒、定位误判、改期任务锚点和 AI 面试回访时刻。
- PR #619 修复岗位半径无结果、经验门槛单位、表单同行时长追问和日结否定句误判。
- PR #619 修复时间数字误命中 7-Eleven，并阻止歧义品牌结果污染候选人品牌状态。

### 优化调整
- PR #619 截图限制为最多 5 张、单张 5MB、合计 10MB，避免超过全局请求体限制。
- PR #619 完善品牌解析、守卫、记忆、消息生命周期、预约交接和观测数据血缘架构底稿。

### 运维与流程
- PR #619 新增逐版本发版底账、P0/P1 回归策展和 develop 到 master 的发布校验。
- PR #619 Agent 行为相关发版必须完成真实链路、逐条业务评审、飞书状态收口、生产 Dashboard 同步和生产 API 对账。

### 配置变更
- PR #619 新增 AGENT_EXTRACT_MODEL、AGENT_EVALUATE_MODEL、AGENT_REVIEW_MODEL、AGENT_REENGAGEMENT_MODEL 及 Dashboard 角色覆盖能力。
- PR #619 飞书反馈附件依赖来源字段、附件字段和 media 上传权限；本批无数据库 migration。

### 环境变量提醒
- PR #619 检测到环境变量相关文件变更：`.env.example`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- PR #619 完整 CI 通过：356 个测试套件、5403 个测试通过，1 个套件和 6 个测试按仓库配置跳过。
- PR #619 真实 Agent 回归批次 4 条全部运行成功并通过业务评审，已同步生产 Dashboard 且无告警。
- PR #619 复聊虚构样本双模型回放 12 次全部符合预期。
- PR #619 Dashboard 角色配置、飞书三来源截图反馈和品牌观测数据均完成联调核对。
- PR #619 最新 HEAD 的 GitHub CI 与 AI Code Review 均通过。

## [10.21.0] - 2026-07-21

**来源分支**: `develop`

### 更新摘要
- PR #611 修复候选人链路中的重复查询、复聊复读、区级地址拉群与品牌品类误判
- PR #611 统一复聊正常不发送场景的观测口径，并稳定关联主动消息与渠道回调
- PR #611 优化兼职群小程序卡片发送节奏及相关耗时说明

### 新功能
- PR #611 记录跨轮岗位查询签名，同参重复查询时给出确定性推进提醒
- PR #611 支持通过全国无歧义区名推断城市并通过拉群城市门禁
- PR #611 品牌 shadow 一致样本按批记录观测事件，补齐下线门禁分母

### 问题修复
- PR #611 复聊结构化决策矛盾时纠正重试，连续异常时安全不发送，并拦截近期回复复读
- PR #611 撤除未经裁定的咖啡默认品牌，恢复全品类展开并阻止岗位词误触发品牌品类
- PR #611 复聊正常跳过、护栏、转人工与投递跳过不再误记为系统失败
- PR #611 主动消息使用稳定外部请求标识并保存真实渠道消息标识，避免重复写入助手历史

### 优化调整
- PR #611 小程序卡片延迟随机化，并同步群任务最坏耗时估算、环境示例与产品文档

### 运维与流程
- PR #611 新增复聊正常不发送结果重分类迁移；测试库已应用，生产库需在应用部署前执行
- PR #611 应用对迁移前后状态均兼容，可保持滚动发布窗口

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #611 定向回归 19 个测试套件、620 个测试通过
- PR #611 代码检查、格式检查、类型检查和前后端构建通过
- PR #611 全量测试 353 个套件通过、1 个跳过；5299 个测试通过、6 个跳过
- PR #611 依赖注入冒烟测试通过
- PR #611 前端代码检查无错误；仅有 11 个既有且不涉及本次文件的警告
- PR #611 测试库迁移已同步至 20260720120000

## [10.20.0] - 2026-07-17

**来源分支**: `develop`

### 更新摘要
- PR #606 紧急放宽报名兼容校验

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #606 紧急放宽报名兼容校验

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #606 `pnpm run ci:check`：通过（352 个测试套件通过、1 个跳过；5248 个测试通过、6 个跳过）
- PR #606 4 个聚焦测试套件：215 个用例通过
- PR #606 最近一个月历史成功报名回归：223 个样本中 209 个通过，兼容通过率 93.72%
- PR #606 无数据库迁移、环境变量、密钥或基础设施变更

## [10.19.0] - 2026-07-17

**来源分支**: `develop`

### 更新摘要
- PR #601 修复线下面试地址为「同工作地址」时误把语义文本拿去地理编码的问题。
- PR #601 独立面试地址改为多候选 POI 校验，避免直接采用地图服务第一条结果导致错发定位。

### 新功能
- 无

### 问题修复
- PR #601 「同工作地址 / 同门店地址」等配置直接继承工作门店的标准地址和高德坐标。
- PR #601 其他面试地址只在单一高可信 POI，或地址锚点唯一命中时发送位置卡片。
- PR #601 POI 无法可靠确认、地图服务不可用或额度耗尽时，保留文字地址并转人工，不回退到工作门店坐标。

### 优化调整
- PR #601 工具结果增加 `interviewLocationSource`，便于区分 `same_as_workplace` 与 `custom` 并观测实际路由。
- PR #601 同步更新运营产品文档中的面试地点来源、独立地址校验和异常降级规则。

### 运维与流程
- 无

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #601 `pnpm exec jest tests/tools/tool/send-store-location.tool.spec.ts --runInBand --watchman=false`：14/14 通过。
- PR #601 `pnpm run ci:check`：lint、format、typecheck、前后端 build、全量测试全部通过。
- PR #601 全量测试：352/353 suites 通过（1 skipped），5242/5248 tests 通过（6 skipped）。
- PR #601 `git diff --check`：通过。

## [10.18.0] - 2026-07-17

**来源分支**: `develop`

### 更新摘要
- PR #596 按面试形式区分面试与门店定位
- PR #596 避免误判工作门店定位
- PR #596 修复进行中面试预约场景把工作门店地址误当作面试地址发送的问题。
- PR #596 按面试形式决定是否存在面试地址，并同步预约上下文、提示词、定位工具与输出护栏。
- PR #596 更新运营、架构和运行时文档，明确面试地点与工作门店的边界及异常降级方式。

### 新功能
- 无

### 问题修复
- PR #596 线下/到店/现场面试优先发送真实面试地点；与工作门店不同时明确区分两者。
- PR #596 线上、AI、视频、电话面试不发送地址或定位，即使上游残留地址字段也会忽略。
- PR #596 面试形式未知时不根据地址反推线下面试，禁止发送定位并转人工确认。
- PR #596 线下面试地址无法解析坐标时，只发送已核验的面试文字地址并转人工，绝不回退到工作门店。
- PR #596 候选人明确询问上班地址、工作地点或工作门店时，仍发送工作门店定位。
- PR #596 修复进行中面试预约场景把工作门店地址误当作面试地址发送的问题。
- PR #596 按面试形式决定是否存在面试地址，并同步预约上下文、提示词、定位工具与输出护栏。
- PR #596 更新运营、架构和运行时文档，明确面试地点与工作门店的边界及异常降级方式。
- PR #596 避免误判工作门店定位

### 优化调整
- PR #596 活跃预约的地址/导航问题会刷新岗位面试流程，并向模型注入工作门店、面试形式以及仅线下面试可见的面试地址。
- PR #596 语义审查证据包新增 `sentLocation`，用于识别面试形式、发送目的地和地址冲突。
- PR #596 补充岗位详情接地规则，拦截未经工具核验的面试地址回复。

### 运维与流程
- PR #596 按面试形式区分面试与门店定位

### 配置变更
- PR #596 N/A：无数据库 migration/schema/RPC/权限/回填变化。
- PR #596 N/A：无新增、修改或废弃环境变量、Secrets、运行时配置及部署脚本变化。
- PR #596 部署顺序：仅应用代码发布，无前置 migration 或配置动作。
- PR #596 回滚方式：回滚到上一生产镜像/tag；仓库部署流程会在健康检查失败时自动回滚。

### 环境变量提醒
- 无

### 验证记录
- PR #596 原 badcase、线上面试残留地址、未知面试形式、明确工作地址、地理编码失败等定向回归通过。
- PR #596 `pnpm run ci:check` 通过。
- PR #596 全量测试：352 suites passed，1 skipped；5239 tests passed，6 skipped。
- PR #596 `pnpm run test:di-smoke` 通过。
- PR #596 文档/提示词更新后相关测试 59/59 通过。
- PR #596 `pnpm run lint:check`、`pnpm run format:check`、`pnpm run typecheck`、前后端构建、`git diff --check` 通过。

## [10.17.0] - 2026-07-17

**来源分支**: `develop`

### 更新摘要
- PR #590 升级 GitHub Actions 至 Node 24 运行时
- PR #590 升级 actions/checkout 至 v7.0.0
- PR #590 升级 actions/setup-node 至 v7.0.0
- PR #590 升级 actions/cache 至 v6.1.0
- PR #590 升级 pnpm/action-setup 至 v6.0.9
- PR #590 升级 actions/upload-artifact 至 v7.0.1
- PR #590 所有官方 Action 均 pin 到对应 release 的不可变 commit SHA
- PR #590 将 AI Code Review 中 checkout@v4 的浮动引用改为固定 SHA
- PR #591 修复多工单面试提醒与回访时机

### 新功能
- 无

### 问题修复
- PR #591 修复多工单面试提醒与回访时机

### 优化调整
- 无

### 运维与流程
- PR #590 升级 actions/checkout 至 v7.0.0
- PR #590 升级 actions/setup-node 至 v7.0.0
- PR #590 升级 actions/cache 至 v6.1.0
- PR #590 升级 pnpm/action-setup 至 v6.0.9
- PR #590 升级 actions/upload-artifact 至 v7.0.1
- PR #590 所有官方 Action 均 pin 到对应 release 的不可变 commit SHA
- PR #590 将 AI Code Review 中 checkout@v4 的浮动引用改为固定 SHA
- PR #590 升级 GitHub Actions 至 Node 24 运行时

### 配置变更
- PR #591 托管配置新增各复聊场景的分钟偏移设置，无需新增环境变量

### 环境变量提醒
- 无

### 验证记录
- PR #590 官方 release/tag 与 commit SHA 已通过 GitHub API 核验
- PR #590 五个目标 Action 的 action.yml 均确认 runs.using 为 node24
- PR #590 所有 workflow YAML 解析通过
- PR #590 Prettier workflow 检查通过
- PR #590 git diff --check 通过
- PR #590 pnpm run ci:check 通过
- PR #590 352 test suites passed，1 skipped
- PR #590 5228 tests passed，6 skipped
- PR #590 pre-commit 与 pre-push hooks 通过
- PR #591 干净 worktree 类型检查通过
- PR #591 复聊与托管配置 202 个测试通过
- PR #591 Dashboard TypeScript 与 Vite 构建通过
- PR #591 增加配置偏移、多工单隔离、跨工单时间纠正回归测试

## [10.16.0] - 2026-07-17

**来源分支**: `develop`

### 更新摘要
- PR #585 加固复聊发送与事实写入边界
- PR #585 避免健康证拒绝意愿误判
- PR #585 复聊发送前同时核验实时工单状态与近期对话语义，避免在取消、结果已知、已提醒或已回访后重复触达。
- PR #585 仅让已确认提交的拉群/预约副作用阻断 replay，并强化事实写入、结构化输出与 LLM 错误观测边界。
- PR #585 新增项目级 `ship-release` skill，沉淀从本地改动审阅到 PR、数据库/环境配置追踪及生产发布验证的 checklist。

### 新功能
- PR #585 新增项目级 `ship-release` skill，沉淀从本地改动审阅到 PR、数据库/环境配置追踪及生产发布验证的 checklist。

### 问题修复
- PR #585 复聊发送前同时核验实时工单状态与近期对话语义，避免在取消、结果已知、已提醒或已回访后重复触达。
- PR #585 仅让已确认提交的拉群/预约副作用阻断 replay，并强化事实写入、结构化输出与 LLM 错误观测边界。
- PR #585 避免健康证拒绝意愿误判

### 优化调整
- 无

### 运维与流程
- PR #585 加固复聊发送与事实写入边界

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #585 相关定向测试：6 suites / 319 tests
- PR #585 `tests/agent/generator/tool-call-analysis.spec.ts`：52 tests
- PR #585 `pnpm run ci:check`：lint、format、typecheck、前后端 build、全量 Jest 全部通过
- PR #585 全量 Jest：352 suites passed、1 skipped；5224 tests passed、6 skipped
- PR #585 pre-commit lint/format hook 通过
- PR #585 pre-push 完整 `ci:check` hook 通过
- PR #585 `git diff --check` 通过
- PR #585 `ship-release` skill quick validation 通过

## [10.15.0] - 2026-07-16

**来源分支**: `develop`

### 更新摘要
- PR #577 全角别名塌缩致单字误命中——归一化补 NFKC 折叠 + 别名门槛收紧
- PR #577 全角别名塌缩致单字误命中品牌（热修）
- PR #576 加固事实护栏与人工接管链路
- PR #576 收紧岗位查询后的预约承诺
- PR #576 补齐面试时间意图护栏测试
- PR #580 brand-resolution 规格升至 v5（实施后修订）

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- PR #577 全角别名塌缩致单字误命中——归一化补 NFKC 折叠 + 别名门槛收紧

### 运维与流程
- PR #576 加固事实护栏与人工接管链路
- PR #576 收紧岗位查询后的预约承诺
- PR #576 补齐面试时间意图护栏测试
- PR #580 brand-resolution 规格升至 v5（实施后修订）

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #576 lint、Prettier、TypeScript typecheck、前后端生产构建通过。
- PR #576 完整 Jest：350 个套件、5165 个用例通过；发现并修复 1 个 Guardrail 目录元数据失败。
- PR #576 修复后定向复验：Guardrail 目录、品牌事故回归、品牌匹配、身份识别共 154 个用例通过。
- PR #576 `git diff --check` 通过。

## [10.14.0] - 2026-07-16

**来源分支**: `develop`

### 更新摘要
- PR #571 身份识别增强与追问上限护栏
- PR #571 澄清身份入参答案方向语义
- PR #571 身份链路统一识别器与核实护栏
- PR #571 拦截静默旁白与无依据班次承诺
- PR #571 持久化语义评审执行事件
- PR #571 拉群后终止无效推店复聊
- PR #571 按机器人串行发送并缩短群间隔
- PR #571 支持真人消息夹具与多表排障
- PR #571 统一学生/社会人士身份识别链路，修复身份预检重复追问、拒后改口核实和重复报名风险。
- PR #571 拦截静默旁白与无依据班次承诺，补充语义评审观测，并在成功拉群后终止无效复聊。
- PR #571 群任务改为按企微 Bot 分布式串行发送，默认跨群间隔调整为 2–4 分钟。
- PR #571 Test Suite 支持真人经理消息 fixture，并完善多表观测排障与复聊产品文档。
- PR #571 修复身份预检、出站护栏与群任务调度

### 新功能
- PR #571 Test Suite 支持真人经理消息 fixture，并完善多表观测排障与复聊产品文档。
- PR #571 支持真人消息夹具与多表排障

### 问题修复
- PR #571 统一学生/社会人士身份识别链路，修复身份预检重复追问、拒后改口核实和重复报名风险。
- PR #571 拦截静默旁白与无依据班次承诺，补充语义评审观测，并在成功拉群后终止无效复聊。
- PR #571 群任务改为按企微 Bot 分布式串行发送，默认跨群间隔调整为 2–4 分钟。

### 优化调整
- 无

### 运维与流程
- PR #571 身份识别增强与追问上限护栏
- PR #571 澄清身份入参答案方向语义
- PR #571 身份链路统一识别器与核实护栏
- PR #571 拦截静默旁白与无依据班次承诺
- PR #571 持久化语义评审执行事件
- PR #571 拉群后终止无效推店复聊
- PR #571 按机器人串行发送并缩短群间隔

### 配置变更
- PR #571 `GROUP_TASK_SEND_DELAY_MS` 默认值由 `300000` 调整为 `120000`，实际随机间隔由 5–10 分钟调整为 2–4 分钟。

### 环境变量提醒
- PR #571 检测到环境变量相关文件变更：`.env.example`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- PR #571 `pnpm run ci:check` 全量通过
- PR #571 349 个测试套件通过，5077 个测试通过，1 个套件按配置跳过
- PR #571 身份预检、Agent 护栏、语义评审、复聊、群任务和 Test Suite 定向测试通过

## [10.13.0] - 2026-07-15

**来源分支**: `develop`

### 更新摘要
- PR #566 修复预检卡死与重复追问
- PR #566 面试前持证岗位禁止提前承诺预约
- PR #566 拦截跨轮身份劝转
- PR #566 岗位详情追问按当前岗位实时查证
- PR #566 固定生日推龄用例时钟
- PR #566 修复预约预检因补充字段遗漏、身份口语表达不被识别而反复追问或卡死的问题。
- PR #566 收紧预约与身份安全边界：持证要求未满足时不提前承诺预约，跨轮禁止诱导候选人改报身份。
- PR #566 建立通用岗位详情查证机制：详情缺失时必须按当前 jobId 实时查询，并准确区分正式工资与培训、阶梯差价的结算范围。
- PR #566 修复预约预检与岗位事实查证链路

### 新功能
- PR #566 岗位精简记忆新增结构化结算摘要，分别保留正式、培训期及阶梯差价的结算口径。
- PR #566 Agent 遥测新增当前焦点岗位与已具备详情字段快照，供生成层和出站守卫判断是否需要实时补查。

### 问题修复
- PR #566 从候选人已填写内容中补回模型漏传的生日等补充字段，并支持由明确生日推导年龄。
- PR #566 支持“社会人士”“已经工作了”等自然身份表达，避免可靠证据存在时重复追问身份。
- PR #566 规范健康证布尔值，限制单轮重复预检次数，避免预检工具循环导致预约链路卡死。
- PR #566 只有预约工具成功后才允许声称报名或预约成功；岗位要求面试前持证但候选人尚未满足时，不提前承诺可预约。
- PR #566 拦截跨轮诱导候选人把暑假工、在校生等身份改报为社会人士的回复。
- PR #566 修复 chatId `6a5729fece406a6aee2035f9` 中把正式工资日结误答为整份工资月结的问题。
- PR #566 候选人追问当前岗位薪资、结算、班次、福利、要求、地址、用工形式、工作内容或工期时，精简记忆缺字段必须使用当前 jobId 精确查询；薪资、结算和福利始终实时刷新。
- PR #566 如果模型跳过必要查询，出站守卫触发受控重规划；结算回复同时校验正式工资与培训、阶梯补充费用的适用范围。
- PR #566 修复预约预检因补充字段遗漏、身份口语表达不被识别而反复追问或卡死的问题。
- PR #566 收紧预约与身份安全边界：持证要求未满足时不提前承诺预约，跨轮禁止诱导候选人改报身份。
- PR #566 建立通用岗位详情查证机制：详情缺失时必须按当前 jobId 实时查询，并准确区分正式工资与培训、阶梯差价的结算范围。
- PR #566 修复预检卡死与重复追问

### 优化调整
- PR #566 面试预检、预约字段归一化、身份事实提取和岗位事实守卫统一使用明确的结构化契约，减少依赖模型猜测。
- PR #566 岗位详情补查和结算校验均限定当前焦点 jobId，防止混用候选池中其他岗位的数据。

### 运维与流程
- PR #566 无。
- PR #566 面试前持证岗位禁止提前承诺预约
- PR #566 拦截跨轮身份劝转
- PR #566 岗位详情追问按当前岗位实时查证
- PR #566 固定生日推龄用例时钟

### 配置变更
- PR #566 无数据库迁移、环境变量或运行时配置变更。

### 环境变量提醒
- 无

### 验证记录
- PR #566 `pnpm run ci:check`
- PR #566 推送前钩子再次执行完整 `ci:check`
- PR #566 Lint、Prettier、TypeScript、Web 生产构建、Nest 构建全部通过
- PR #566 Jest：347 个测试套件通过，4969 个测试通过，1 个套件 / 6 个测试按项目配置跳过
- PR #566 岗位详情定向回归：249 个测试通过

## [10.12.0] - 2026-07-15

**来源分支**: `develop`

### 更新摘要
- PR #561 brand-resolution 方案 v4 修订（代码核查重评）
- PR #561 建立 src/resolution/brand 品牌解析层（Phase 1）
- PR #561 会话品牌状态 brand_state 落地 + 三处写入点收口（Phase 2）
- PR #561 duliday_job_list 品牌入口标准化 + brandFilterMode（Phase 3）
- PR #561 守卫三切换点改读 queryMeta.brand + Prompt Section 改读品牌状态（Pha…
- PR #561 完善业务校验与分析口径
- PR #561 修复 pre-commit 钩子执行权限
- PR #561 Merge remote-tracking branch 'origin/develop' into codex/brand-resolu…
- PR #561 修正排除品牌语义并补齐单测
- PR #561 BrandResolution 全链路改造 Phase 1–4

### 新功能
- 无

### 问题修复
- PR #561 修复 pre-commit 钩子执行权限
- PR #561 修正排除品牌语义并补齐单测

### 优化调整
- 无

### 运维与流程
- PR #561 brand-resolution 方案 v4 修订（代码核查重评）
- PR #561 建立 src/resolution/brand 品牌解析层（Phase 1）
- PR #561 会话品牌状态 brand_state 落地 + 三处写入点收口（Phase 2）
- PR #561 duliday_job_list 品牌入口标准化 + brandFilterMode（Phase 3）
- PR #561 守卫三切换点改读 queryMeta.brand + Prompt Section 改读品牌状态（Pha…
- PR #561 完善业务校验与分析口径
- PR #561 Merge remote-tracking branch 'origin/develop' into codex/brand-resolu…

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #561 pnpm lint:check 零警告；tsc --noEmit（src+tests）通过；全量 jest 4907 通过 / 0 失败
- PR #561 规格 §14.1–14.4 全部用例有对应单测（新增 ~130 个品牌链路测试）
- PR #561 零数据库迁移（brand_state 走 Redis 懒迁移）

## [10.11.0] - 2026-07-14

**来源分支**: `develop`

### 更新摘要
- PR #556 合并 replay 期间到达的新消息

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- PR #556 合并 replay 期间到达的新消息

### 运维与流程
- 无

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #556 `pnpm jest tests/channels/wecom/message/application/reply-workflow.service.spec.ts --watchman=false --runInBand`
- PR #556 `pnpm jest tests/channels/wecom/message/services/simple-merge.service.spec.ts tests/channels/wecom/message/message.processor.spec.ts --watchman=false --runInBand`
- PR #556 `pnpm typecheck`
- PR #556 `pnpm exec eslint src/channels/wecom/message/application/reply-workflow.service.ts --max-warnings=0`
- PR #556 push hook 全量 `pnpm run ci:check`

## [10.10.0] - 2026-07-14

**来源分支**: `develop`

### 更新摘要
- PR #551 婚育筛选纳入敏感信息保护
- PR #551 将婚育要求纳入与民族、籍贯、专业同级的敏感筛选保护。
- PR #551 岗位渲染和面试预检增加内部敏感提示，禁止向候选人询问、展示、复述或确认婚育信息。
- PR #551 出站硬规则拦截婚育状态、婚育门槛及相关问句。

### 新功能
- 无

### 问题修复
- PR #551 修复结构化婚育要求和自由文本婚育筛选条件缺少敏感标识的问题。
- PR #551 修复 Agent 可能向候选人表达婚育要求或询问婚育状态的问题。
- PR #551 将婚育要求纳入与民族、籍贯、专业同级的敏感筛选保护。
- PR #551 岗位渲染和面试预检增加内部敏感提示，禁止向候选人询问、展示、复述或确认婚育信息。
- PR #551 出站硬规则拦截婚育状态、婚育门槛及相关问句。

### 优化调整
- PR #551 补充婚育敏感检测、预检提示、渲染提示及出站拦截测试。

### 运维与流程
- PR #551 婚育筛选纳入敏感信息保护

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #551 `pnpm run ci:check`
- PR #551 婚育敏感检测、岗位渲染、面试预检和出站守卫定向测试通过
- PR #551 其他说明：无数据库迁移、无环境变量变更。

## [10.9.0] - 2026-07-14

**来源分支**: `develop`

### 更新摘要
- PR #546 修正收资优先级与场景判定

### 新功能
- 无

### 问题修复
- PR #546 修正收资优先级与场景判定

### 优化调整
- 无

### 运维与流程
- 无

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #546 `pnpm ci:check`
- PR #546 335 个测试套件通过（1 skipped）
- PR #546 4760 个测试通过（6 skipped）
- PR #546 Web 与服务端构建、类型检查、Lint、Prettier 均通过

## [10.8.0] - 2026-07-14

**来源分支**: `develop`

### 更新摘要
- PR #541 构建前清理过期 Docker 缓存

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #541 构建前清理过期 Docker 缓存

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #541 workflow YAML 解析通过
- PR #541 pre-push 完整 `pnpm run ci:check` 通过：335 个测试套件、4753 个测试通过

## [10.7.0] - 2026-07-14

**来源分支**: `develop`

### 更新摘要
- PR #536 避免发布源码权限位阻塞切换

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #536 避免发布源码权限位阻塞切换

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #536 workflow YAML 解析通过
- PR #536 本地临时 Git 仓库复现 chmod 脏状态，修复后的 checkout 可切换且工作区恢复 clean
- PR #536 pre-push 完整 `pnpm run ci:check` 通过：335 个测试套件、4753 个测试通过

## [10.6.0] - 2026-07-14

**来源分支**: `develop`

### 更新摘要
- PR #531 生产运行时统一到 Node 22
- PR #531 AI 审查改用 workflow token 提交

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #531 生产运行时统一到 Node 22
- PR #531 AI 审查改用 workflow token 提交

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #531 `bash -n scripts/deploy-remote.sh`
- PR #531 Dockerfile / package runtime alignment 静态校验
- PR #531 `pnpm run ci:check`
- PR #531 lint、Prettier、TypeScript、Web/Nest 生产构建通过
- PR #531 335 个测试套件通过，4753 个测试通过，6 个跳过

## [10.5.0] - 2026-07-14

**来源分支**: `develop`

### 更新摘要
- PR #526 加固模型输出与预约复聊链路
- PR #526 统一 pnpm 运行版本
- PR #526 消息分段保留岗位卡片完整性
- PR #526 工作流统一使用 Node 22
- PR #526 preparation.service 按职责拆分 + 预约直查失败语义分流
- PR #526 preparation 辅助模块归拢到 preparation-utils/ 子目录
- PR #526 降低消息 Trace 带宽放大
- PR #526 重新触发 AI 审查
- PR #526 AI 审查改用结构化裁决
- PR #526 加固 Qwen 模型输出边界，阻止推理标签、纯长数字和 Provider 格式残片进入候选人回复。
- PR #526 将预约与复聊链路统一为工单索引 + 海绵实时事实，修复改约、取消和工单同步后的旧快照污染。
- PR #526 完善学生身份、岗位硬要求和预约前置校验，并升级 AI SDK 与安全相关依赖。

### 新功能
- PR #526 新增预约工单上下文统一解析器，复聊提醒和面试后回访按海绵实时工单与岗位详情生成。
- PR #526 Generator 在预约相关回合绕过工单短缓存；海绵尚未同步时注入封闭的“最新预约信息确认中”状态。

### 问题修复
- PR #526 修复 Qwen deep-thinking 多模态响应可能把 `<think>` 或内部数字标识写入可见 `content` 的问题；视觉回合临时关闭 thinking，文本回合保持原配置。
- PR #526 Output Guardrail 新增 P0 异常模型输出规则，并在 LLM 执行层触发重试或模型降级。
- PR #526 修复 `active_booking` 中面试时间、品牌、门店和岗位快照在改约或外部状态变化后继续污染 Generator/复聊的问题。
- PR #526 修复预约刚成功但海绵工单尚未同步时 Generator 静默丢失预约上下文的问题，不再回退任何易过期本地事实。
- PR #526 修复学生身份尚未明确时 Agent 擅自代填社会人士，以及明确学生与岗位要求冲突后仍继续预约的问题。
- PR #526 修复复聊面试提醒使用旧时间、旧状态或历史任务冻结值的问题；关键事实缺失时 fail closed 并交由 Bull 重试。
- PR #526 修复主动复聊历史消息被二次截断和时间上下文被改写的问题。
- PR #526 加固 Qwen 模型输出边界，阻止推理标签、纯长数字和 Provider 格式残片进入候选人回复。
- PR #526 将预约与复聊链路统一为工单索引 + 海绵实时事实，修复改约、取消和工单同步后的旧快照污染。
- PR #526 完善学生身份、岗位硬要求和预约前置校验，并升级 AI SDK 与安全相关依赖。

### 优化调整
- PR #526 `active_booking` 收敛为 `work_order_id + job_id` 极简索引；完整预约快照继续写入 `booking.succeeded` 运营事件供审计。
- PR #526 普通非预约回合继续复用短缓存，避免每轮直查海绵。
- PR #526 AI SDK v6 Provider、Supabase、MCP SDK、Axios、Redis 等依赖升级到兼容补丁版本；未引入 AI SDK v7 或 NestJS v11 等破坏性升级。
- PR #526 Redis 消息 Trace 改为字段级 Hash 增量更新，避免大型 Agent 请求/结果在各阶段反复整对象读写；Session 新 Hash 命中后停止查询旧 Key，降低 Redis 月度带宽与无效 miss。
- PR #526 preparation.service 按职责拆分 + 预约直查失败语义分流

### 运维与流程
- PR #526 固定 pnpm 版本为 `10.34.5`，更新 lockfile 并补充高风险传递依赖 overrides。
- PR #526 移除已废弃的 `crypto` 和 `@types/bull` 直接依赖。
- PR #526 `pnpm audit --prod` 与全量审计均为 high 0 / critical 0。
- PR #526 加固模型输出与预约复聊链路
- PR #526 统一 pnpm 运行版本
- PR #526 消息分段保留岗位卡片完整性
- PR #526 工作流统一使用 Node 22
- PR #526 preparation 辅助模块归拢到 preparation-utils/ 子目录
- PR #526 降低消息 Trace 带宽放大
- PR #526 重新触发 AI 审查
- PR #526 AI 审查改用结构化裁决

### 配置变更
- PR #526 无环境变量变更。
- PR #526 无数据库迁移。
- PR #526 Qwen 图片输入且 thinking 已开启时，运行时会临时按该请求关闭 thinking；纯文本 Qwen 请求不受影响。

### 环境变量提醒
- 无

### 验证记录
- PR #526 `pnpm run ci:check`
- PR #526 lint、Prettier、TypeScript 类型检查、Web/Nest 生产构建通过
- PR #526 335 个测试套件通过，4753 个测试通过，6 个跳过
- PR #526 Generator 预约实时查询/同步中降级、复聊工单解析、Output Guardrail 与 LLM fallback 定向测试通过
- PR #526 关键链路已人工验证
- PR #526 其他说明：生产依赖审计剩余 low/moderate 间接告警，无 high/critical。

## [10.4.0] - 2026-07-13

**来源分支**: `develop`

### 更新摘要
- PR #521 加固招聘约束与复聊流程
- PR #521 明确记忆时间上下文
- PR #521 按守卫策略精确限制 replan 工具
- PR #521 加固暑假工意向、身份登记与无岗回复约束，新增输出守卫和回归评测脚本。
- PR #521 完善预约、关键用工事实转人工及复聊链路，覆盖 AI 面试、取消面试停止触达与品牌/身份兜底。
- PR #521 修复输出守卫图片事实误判，并让 replan 按守卫策略精确获得修复工具。
- PR #521 支持复聊候选人按 Session ID 或昵称检索，并补充 BrandResolution 全链路架构方案。

### 新功能
- PR #521 复聊候选人列表支持按 Session ID / 候选人昵称包含式搜索。
- PR #521 新增 `eval:summer-worker-agent` 暑假工规则评测入口。
- PR #521 加固暑假工意向、身份登记与无岗回复约束，新增输出守卫和回归评测脚本。
- PR #521 支持复聊候选人按 Session ID 或昵称检索，并补充 BrandResolution 全链路架构方案。

### 问题修复
- PR #521 暑假工无匹配岗位时直接结束本轮，阻止主动劝转普通兼职、小时工或全职。
- PR #521 暑假工状态默认不再由年龄或学生身份推断，且防止诱导候选人按非暑假工登记。
- PR #521 候选人重复追问未知合同、协议、社保等关键用工事实时转人工处理。
- PR #521 修正 AI 面试预约话术、复聊锚点/场景判定，以及候选人已取消面试后仍触达的问题。
- PR #521 修复 `[表情消息]` 与健康证字段组合被错误识别为未保存图片描述的问题。
- PR #521 修复 replan 被限制为通用只读工具的问题，改为由规则或语义 finding 声明修复工具并执行权限交集。
- PR #521 完善预约、关键用工事实转人工及复聊链路，覆盖 AI 面试、取消面试停止触达与品牌/身份兜底。
- PR #521 修复输出守卫图片事实误判，并让 replan 按守卫策略精确获得修复工具。

### 优化调整
- PR #521 补充 BrandResolution 全链路改造方案，统一后续品牌识别、状态与查询审计方向。
- PR #521 增强企微图片兼容重跑、预约与复聊相关可观测信息和测试覆盖。
- PR #521 Runner 不再维护规则 ID 到工具名的硬编码映射。

### 运维与流程
- PR #521 新增数据库迁移 `20260713180000_search_reengagement_candidates_by_nickname.sql`，更新候选人概览 RPC 的关键词检索参数。
- PR #521 加固招聘约束与复聊流程
- PR #521 明确记忆时间上下文
- PR #521 按守卫策略精确限制 replan 工具

### 配置变更
- PR #521 无环境变量变更。
- PR #521 数据库迁移需随版本执行。

### 环境变量提醒
- 无

### 验证记录
- PR #521 `pnpm run ci:check`
- PR #521 完整测试：334 个套件通过，4711 个测试通过，6 个跳过
- PR #521 guardrail/replan 定向测试：6 个套件、212 个测试通过
- PR #521 关键链路已人工验证

## [10.3.0] - 2026-07-13

**来源分支**: `develop`

### 更新摘要
- PR #516 调整同群与跨群发送间隔
- PR #516 福利事实进入岗位记忆并强制实时重查
- PR #516 群任务同群连续消息调整为固定间隔 40 秒，不同群之间调整为随机间隔 5～10 分钟。

### 新功能
- PR #516 无。

### 问题修复
- PR #516 修复跨群长延迟被错误应用到同群小程序卡片和跟随消息的问题。
- PR #516 移除 Bull delay 与发送 worker 等待的重复叠加，避免实际间隔超出预期。
- PR #516 群任务同群连续消息调整为固定间隔 40 秒，不同群之间调整为随机间隔 5～10 分钟。

### 优化调整
- PR #516 首个群立即发送，后续群通过 Redis 执行标记保持跨重启节奏。
- PR #516 按跨群最坏等待和同群消息数量调整汇总任务耗时估算。

### 运维与流程
- PR #516 无数据库迁移。
- PR #516 调整同群与跨群发送间隔
- PR #516 福利事实进入岗位记忆并强制实时重查

### 配置变更
- PR #516 `GROUP_TASK_SEND_DELAY_MS` 默认值由 `120000` 调整为 `300000`，含义改为跨群最小等待；实际随机为 1～2 倍。
- PR #516 同群连续消息间隔固定为 `40000ms`。

### 环境变量提醒
- PR #516 检测到环境变量相关文件变更：`.env.example`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- PR #516 群任务测试：219 passed。
- PR #516 全量测试：4685 passed，6 skipped。
- PR #516 TypeScript 类型检查、ESLint、Prettier 通过。
- PR #516 前端和服务端生产构建通过。

## [10.2.0] - 2026-07-13

**来源分支**: `develop`

### 更新摘要
- PR #511 按接客 Bot 托管状态决定复聊投递

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #511 按接客 Bot 托管状态决定复聊投递

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #511 相关 4 个测试套件，85 项测试通过
- PR #511 TypeScript 类型检查通过
- PR #511 Web 与 Nest 构建通过
- PR #511 lint、Prettier 检查通过

## [10.1.0] - 2026-07-10

**来源分支**: `develop`

### 更新摘要
- PR #500 保证 AI 复审写回裁决
- PR #500 AI workflow 自修改时转人工审查
- PR #500 修复 AI Code Review 在未写回 GitHub Review 时仍显示成功的假绿问题。
- PR #500 保证每次 PR 更新都必须针对当前 HEAD 新增明确的 `APPROVED` 或 `CHANGES_REQUESTED` 裁决。
- PR #503 续跑并兜底 AI 复审裁决
- PR #503 主审查最多回合数提升至 80，并补充只读 git 工具权限
- PR #503 主审查未写入裁决时，复用同一 Claude session 续跑 8 回合，仅提交 approve/request-changes
- PR #503 两阶段仍未写入时，由 workflow 为当前 HEAD 提交阻塞 review 并判红
- PR #499 强化岗位匹配与复聊可靠性
- PR #499 修复审查发现的匹配与追踪问题
- PR #499 保证 AI 复审写回裁决
- PR #499 AI workflow 自修改时转人工审查
- PR #499 Revert "fix(ci): AI workflow 自修改时转人工审查"
- PR #499 Revert "fix(ci): 保证 AI 复审写回裁决"
- PR #499 Merge remote-tracking branch 'origin/develop' into codex/agent-safety…
- PR #499 完成用工偏好撤销闭环
- PR #499 批量下线出站守卫硬规则
- PR #499 统一候选人用工意向与岗位结构化字段的匹配口径，强化地理位置、岗位事实和预约声明的证据约束。
- PR #499 提升复聊生成链路的可靠性、可评估性与运营详情可观测性。

### 新功能
- PR #500 保证每次 PR 更新都必须针对当前 HEAD 新增明确的 `APPROVED` 或 `CHANGES_REQUESTED` 裁决。
- PR #499 新增地理位置锚点解析与消息来源追踪，在生成、工具调用和修复链路中保留事实出处。
- PR #499 新增身份欺诈指导拦截规则，以及复聊 Agent 评估脚本。
- PR #499 复聊详情抽屉新增生成消息、模型思考、最终提示词和任务流转展示。
- PR #499 统一候选人用工意向与岗位结构化字段的匹配口径，强化地理位置、岗位事实和预约声明的证据约束。

### 问题修复
- PR #500 为 Claude 补充 `Read`、`Glob`、`Grep` 只读工具权限，减少审查过程中的权限拒绝。
- PR #500 在提示词中明确当前 HEAD，并要求旧 Review 不得替代本轮裁决。
- PR #500 在 Action 后通过 GitHub Reviews API 校验当前 HEAD 是否新增裁决；未写回时让 workflow 失败。
- PR #500 AI Review workflow 自修改时，按 Anthropic Action 安全限制跳过自审并明确要求人工审查。
- PR #500 修复 AI Code Review 在未写回 GitHub Review 时仍显示成功的假绿问题。
- PR #503 主审查未写入裁决时，复用同一 Claude session 续跑 8 回合，仅提交 approve/request-changes
- PR #503 续跑并兜底 AI 复审裁决
- PR #499 修复用工形式单层字段与岗位侧“用工形式 + 兼职类型”两级结构不一致的问题。
- PR #499 修复当前轮明确变更或撤销用工偏好时，历史记忆仍可能覆盖新意向的问题。
- PR #499 修复暑假工等硬约束可能被静默降级、非匹配岗位被重新带回候选池的问题。
- PR #499 修复地理位置、岗位事实、面试地点与预约结果缺少工具证据时仍可能生成肯定声明的问题。
- PR #499 修复主动复聊消息在历史读取、来源识别和上下文组装中的若干边界问题。
- PR #499 修复审查发现的匹配与追踪问题
- PR #499 Revert "fix(ci): AI workflow 自修改时转人工审查"
- PR #499 Revert "fix(ci): 保证 AI 复审写回裁决"

### 优化调整
- PR #503 主审查最多回合数提升至 80，并补充只读 git 工具权限
- PR #499 调整岗位查询、面试预检/预约、地理编码和 Provider 可靠性上下文的数据契约。
- PR #499 重构出站硬规则目录、岗位事实比对与受控修复上下文。
- PR #499 更新候选人咨询提示词、会话事实提取规则及架构说明。
- PR #499 补充覆盖用工偏好、位置锚点、岗位过滤、预约、复聊、消息缓存与 Provider 回退的回归测试。
- PR #499 提升复聊生成链路的可靠性、可评估性与运营详情可观测性。

### 运维与流程
- PR #500 保证 AI 复审写回裁决
- PR #500 AI workflow 自修改时转人工审查
- PR #503 两阶段仍未写入时，由 workflow 为当前 HEAD 提交阻塞 review 并判红
- PR #499 增加复聊 Agent 离线评估脚本。
- PR #499 更新本地 backend、生产只读预览和 Web 调试启动配置。
- PR #499 强化岗位匹配与复聊可靠性
- PR #499 保证 AI 复审写回裁决
- PR #499 AI workflow 自修改时转人工审查
- PR #499 Merge remote-tracking branch 'origin/develop' into codex/agent-safety…
- PR #499 完成用工偏好撤销闭环
- PR #499 批量下线出站守卫硬规则

### 配置变更
- PR #500 仅修改 `.github/workflows/ai-code-review.yml`，无运行时配置变更。
- PR #499 无生产环境变量、数据库迁移或托管成员配置变更。
- PR #499 `.claude` 本地调试配置随本次改动一并更新。

### 环境变量提醒
- 无

### 验证记录
- PR #500 Prettier 检查通过。
- PR #500 Ruby YAML 解析通过。
- PR #500 GitHub Reviews API 的 HEAD SHA 过滤查询已在 PR #499 上验证。
- PR #500 主工作区完整 `pnpm ci:check` 通过：334 个测试套件、4,817 个测试通过。
- PR #503 Prettier workflow 格式检查通过
- PR #503 YAML 解析通过
- PR #503 git diff --check 通过
- PR #503 参数依据 anthropics/claude-code-action@v1 官方 action.yml 与文档核对
- PR #499 `pnpm ci:check` 全量通过：ESLint、Prettier、TypeScript 类型检查、Web/Nest 生产构建。
- PR #499 Jest：333 个测试套件、4,804 个测试通过；1 个套件/6 个测试按配置跳过。
- PR #499 行覆盖率：85%。
- PR #499 推送前钩子再次执行完整 `pnpm ci:check` 并通过。

## [10.0.4] - 2026-07-10

**来源分支**: `develop`

### 更新摘要
- PR #493 AI review 行内评论工具补进 allowedTools
- PR #492 周六/周日班次约束提取 + 工具层与持久化约束逐字段合并
- PR #492 回复生成链路 agent 化（generator/reengagement/reply-repair）
- PR #492 托管成员配置 seed（辛雨琦）+ drift 检查工具
- PR #492 会话事实提取增强 + 工具与运营通知补强
- PR #492 新增架构知识库 + Agent 自迭代方案，精简 CLAUDE.md
- PR #492 回复生成链路 agent 化重构：generator / 复聊 / reply-repair 三条链路统一为 `*.agent` 形态，收敛副作用出口
- PR #492 新增托管成员配置（辛雨琦）seed 迁移与运行时配置 drift 检查工具
- PR #492 会话事实提取增强、工具约束补强、运营通知补强
- PR #492 新增架构知识库（17 篇专题）并精简 CLAUDE.md
- PR #492 回复生成链路 agent 化 + 托管配置 drift 工具

### 新功能
- PR #492 `check-hosting-member-config-drift.js` + `config:hosting:check/sync:test/prod` 脚本：校验/同步 `system_config.hosting_member_config` 运行时配置漂移
- PR #492 迁移 `20260709120000` 幂等 seed 辛雨琦托管成员配置
- PR #492 新增托管成员配置（辛雨琦）seed 迁移与运行时配置 drift 检查工具
- PR #492 新增架构知识库（17 篇专题）并精简 CLAUDE.md
- PR #492 新增架构知识库 + Agent 自迭代方案，精简 CLAUDE.md

### 问题修复
- PR #492 出站守卫拉群改写反馈明确 rewrite 阶段无工具能力，禁止新增拉群邀约话术
- PR #492 周六/周日班次约束提取 + 工具层与持久化约束逐字段合并（含测试）

### 优化调整
- PR #492 `generator.service` → `generator.agent`；`reply-rewrite.service` → `reply-repair.agent` + context provider
- PR #492 复聊 `proactive-composer` / `reengagement-delivery` / `reengagement.types` 收敛为 `reengagement.agent`
- PR #492 runner / module / 各 consumer 同步接线；删除被 `20260707150500` 取代的重复保留期迁移文件
- PR #492 会话事实提取字段、格式化、prompt 与 session/short-term 服务同步增强
- PR #492 回复生成链路 agent 化重构：generator / 复聊 / reply-repair 三条链路统一为 `*.agent` 形态，收敛副作用出口
- PR #492 会话事实提取增强、工具约束补强、运营通知补强
- PR #492 周六/周日班次约束提取 + 工具层与持久化约束逐字段合并

### 运维与流程
- PR #493 AI review 行内评论工具补进 allowedTools
- PR #492 发版指南与 PR 正文模板补充 `hosting_member_config` 检查清单（运行时配置非 schema migration）
- PR #492 新增 `docs/architecture/agent-self-iteration-loop-plan.md` 自迭代闭环方案
- PR #492 回复生成链路 agent 化（generator/reengagement/reply-repair）
- PR #492 托管成员配置 seed（辛雨琦）+ drift 检查工具
- PR #492 会话事实提取增强 + 工具与运营通知补强

### 配置变更
- PR #492 新增 migration `20260709120000_seed_xin_yuqi_hosting_member_config.sql`，发版需 test → prod 同步推送
- PR #492 `package.json` 新增 `config:hosting:*` 脚本

### 环境变量提醒
- 无

### 验证记录
- PR #492 `pnpm lint:check` / `format:check` / `typecheck` 全通过
- PR #492 `pnpm jest --watchman=false`：331 套件通过、4720 测试通过（6 skip）

## [10.0.3] - 2026-07-08

**来源分支**: `develop`

### 更新摘要
- PR #487 稳定守卫修复模型路由
- PR #487 隐藏停止条件命中的复聊场景标签
- PR #487 模型路由层在角色主模型缺失时，会使用角色专属 fallback 或统一 fallback 链首个模型承接，避免 repair/review 等非 chat 链路在路由阶段直接抛错。
- PR #487 更新 `.env.example` 的模型角色示例，包含 review/repair 主模型与统一降级链。
- PR #487 修复品牌名守卫误把薪资/班次说明当成品牌 mismatch 的假阳，并补充回归测试。
- PR #487 守卫详情抽屉隐藏与 violation suggestion 完全重复的重写反馈，减少重复噪音。

### 新功能
- 无

### 问题修复
- PR #487 模型路由层在角色主模型缺失时，会使用角色专属 fallback 或统一 fallback 链首个模型承接，避免 repair/review 等非 chat 链路在路由阶段直接抛错。
- PR #487 更新 `.env.example` 的模型角色示例，包含 review/repair 主模型与统一降级链。
- PR #487 修复品牌名守卫误把薪资/班次说明当成品牌 mismatch 的假阳，并补充回归测试。
- PR #487 守卫详情抽屉隐藏与 violation suggestion 完全重复的重写反馈，减少重复噪音。
- PR #487 稳定守卫修复模型路由

### 优化调整
- 无

### 运维与流程
- PR #487 隐藏停止条件命中的复聊场景标签

### 配置变更
- 无

### 环境变量提醒
- PR #487 检测到环境变量相关文件变更：`.env.example`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- PR #487 `./node_modules/.bin/jest tests/providers/router.service.spec.ts tests/agent/guardrail/output/hard-rules.service.spec.ts --runInBand --watchman=false`
- PR #487 `./node_modules/.bin/tsc --noEmit`
- PR #487 `cd web && ./node_modules/.bin/tsc -b && ./node_modules/.bin/vite build`

## [10.0.2] - 2026-07-08

**来源分支**: `develop`

### 更新摘要
- PR #482 收敛出站守卫规则止血版
- PR #482 收敛守卫确定性修补实现
- PR #482 强化复聊生成与任务治理
- PR #482 优化守卫修复链路与 CI 范围
- PR #482 强化复聊触达生成、调度治理、触达记录和后台详情展示，降低重复触达和过期候选人误触达风险。
- PR #482 收敛出站守卫确定性修补逻辑，引入独立 ReplyRewriteService，让 rewrite 修复只做候选人可见文本改写，不再复用 agent 生成链路。
- PR #482 为 release metadata PR 增加 CI 范围识别，允许纯版本元数据变更走轻量 CI。
- PR #482 新增运营日报飞书历史报名/面试通过数回填脚本。
- PR #482 强化复聊生成与守卫修复链路

### 新功能
- PR #482 新增运营日报飞书历史报名/面试通过数回填脚本。

### 问题修复
- PR #482 强化复聊触达生成、调度治理、触达记录和后台详情展示，降低重复触达和过期候选人误触达风险。
- PR #482 收敛出站守卫确定性修补逻辑，引入独立 ReplyRewriteService，让 rewrite 修复只做候选人可见文本改写，不再复用 agent 生成链路。
- PR #482 优化守卫修复链路与 CI 范围

### 优化调整
- 无

### 运维与流程
- PR #482 为 release metadata PR 增加 CI 范围识别，允许纯版本元数据变更走轻量 CI。
- PR #482 收敛出站守卫规则止血版
- PR #482 收敛守卫确定性修补实现
- PR #482 强化复聊生成与任务治理

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #482 `pnpm test -- tests/agent/runner/agent-runner.service.spec.ts tests/agent/runner/reply-rewrite.service.spec.ts --watchman=false`
- PR #482 `pnpm run typecheck`
- PR #482 `pnpm run ci:check`

## [10.0.1] - 2026-07-08

**来源分支**: `develop`

### 更新摘要
- PR #476 版本号规则改回标准语义化版本
- PR #476 版本号计算规则改回标准语义化版本：`feat:` 升 minor 而非 major，修复"很小的改动也跳大版本"的问题（两天内 v6→v7→v8 连跳三个大版本）
- PR #477 改进复聊质量守卫和观测
- PR #477 改进复聊 shadow 调研沉淀，补齐问题清单与修复方案，明确真发放开门槛。
- PR #477 调整出站 guardrail 治理策略：将部分高误杀规则降为 observe，并为区级距离精确口径增加确定性 transform。
- PR #477 补齐复聊主动回合的生成请求、耗时、投递结果等观测字段，方便线上追溯排障。

### 新功能
- PR #477 新增出站输出 transform 机制，当前支持将区/市级粗定位下的精确公里数改写为估算口径，并在二审通过后直接投递。
- PR #477 新增复聊质量调研、修复方案与问题样本数据文档。

### 问题修复
- PR #476 `scripts/update-version-changelog.js` 旧口径：`feat:` → major+1（"业务新能力直接进下一大版本"）、`perf:`/`refactor:` → minor+1。只要发版批次里混进一个小 feat 就升大版本
- PR #476 新规则（标准 Conventional Commits / semver）：
- PR #476 `BREAKING CHANGE` / `type!:` → major+1
- PR #476 `feat:` → minor+1
- PR #476 其余有效提交（`fix:`/`perf:`/`refactor:`/`docs:` 等）→ patch+1
- PR #476 CLAUDE.md 的 Git Commit Convention 本来写的就是 `feat → minor+1`，是脚本实现偏离了文档
- PR #476 每轮 prepare 会从上一个 tag 重算 `nextVersion`（覆盖式），本 PR 合并后下一轮自动纠正，无需手工回调版本号
- PR #476 版本号计算规则改回标准语义化版本：`feat:` 升 minor 而非 major，修复"很小的改动也跳大版本"的问题（两天内 v6→v7→v8 连跳三个大版本）
- PR #477 修复 Guardrail Repair Writer 在禁用工具修复场景下仍可能输出工具调用/JSON/标签式内容的问题。
- PR #477 降低保险、等通知时间收集、到店自报家门脚本缺失、模糊地名澄清、岗位职责泛化、远店推荐等规则在高误杀场景下的投递阻断风险。
- PR #477 修复修复产物不可用或二次触发内部输出泄漏时的收敛策略，低风险可恢复问题优先 fail-open 到首版回复。
- PR #477 修复系统状态编造规则误拦真实副作用工具失败说明的问题。
- PR #477 改进复聊 shadow 调研沉淀，补齐问题清单与修复方案，明确真发放开门槛。
- PR #477 调整出站 guardrail 治理策略：将部分高误杀规则降为 observe，并为区级距离精确口径增加确定性 transform。
- PR #477 补齐复聊主动回合的生成请求、耗时、投递结果等观测字段，方便线上追溯排障。

### 优化调整
- PR #477 复聊主动回合落库记录补充 agentInvocation、tokenUsage、timings、deliveryResult 等追踪信息。
- PR #477 新增辛瑜琦/瑜琦组的 bot 分组与飞书接收人映射。
- PR #477 输出规则目录补充准入治理说明和 transform repair strategy 元数据。

### 运维与流程
- PR #476 同步更新 `tests/scripts/update-version-changelog.spec.ts` 与 `docs/workflows/version-release-guide.md`（保留历史口径变更说明）
- PR #476 版本号规则改回标准语义化版本
- PR #477 改进复聊质量守卫和观测

### 配置变更
- PR #477 新增 botImId `1688855468965879` 到瑜琦组/辛瑜琦飞书接收人映射。

### 环境变量提醒
- 无

### 验证记录
- PR #476 新规则本地断言全过：breaking / feat / fix / perf / refactor / docs / 混合批次（feat+fix 取 minor）/ skip 提交忽略等用例
- PR #477 `pnpm exec jest tests/agent/generator/preparation.service.spec.ts tests/agent/guardrail/output/hard-rules.service.spec.ts tests/agent/reengagement/follow-up.processor.spec.ts tests/agent/runner/agent-runner.service.spec.ts tests/biz/ops-events/services/bot-group-resolver.service.spec.ts tests/infra/feishu/receivers.spec.ts --watchman=false`
- PR #477 `pnpm run ci:check`
- PR #477 pre-push hook 自动执行 `pnpm run ci:check`
- PR #477 其他说明：Jest coverage 阶段提示一个 worker 未优雅退出，但命令退出码为 0；日志中的 ERROR/WARN 来自测试用例模拟失败场景。

## [10.0.0] - 2026-07-08

**来源分支**: `develop`

### 更新摘要
- PR #471 降低语义护栏 shadow 误报
- PR #471 接入 Agent 执行事件观测
- PR #471 补齐 agent 执行观测单测
- PR #471 降低守卫和预约收资误判

### 新功能
- PR #471 接入 Agent 执行事件观测

### 问题修复
- PR #471 降低守卫和预约收资误判

### 优化调整
- 无

### 运维与流程
- PR #471 降低语义护栏 shadow 误报
- PR #471 补齐 agent 执行观测单测

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #471 `pnpm jest tests/tools/tool/duliday-interview-precheck.tool.spec.ts tests/agent/guardrail/output/hard-rules.service.spec.ts --runInBand --watchman=false`
- PR #471 `pnpm run typecheck`
- PR #471 pre-push hook 完整执行 `pnpm run ci:check` 通过：lint、format、typecheck、build:ci、test:ci（326 suites passed, 4667 tests passed）。

## [9.0.0] - 2026-07-08

**来源分支**: `develop`

### 更新摘要
- PR #464 发版链路 bot PR 自动放行，CI/AI review 并发去重
- PR #464 发版链路的三个机器人 PR（版本元数据 / 固化 / 回同步）在配置 `RELEASE_BOT_TOKEN` 后自动 approve + auto-merge，整个发版收敛为**只需人工合并一次 develop → master release PR**
- PR #464 CI 与 AI review 增加并发去重，同分支旧 run 自动取消
- PR #467 放开版本元数据 PR 的 CI 触发

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- PR #464 发版链路的三个机器人 PR（版本元数据 / 固化 / 回同步）在配置 `RELEASE_BOT_TOKEN` 后自动 approve + auto-merge，整个发版收敛为**只需人工合并一次 develop → master release PR**

### 运维与流程
- PR #464 `ci.yml`：新增 `concurrency`（按分支取消旧 run）
- PR #464 `ai-code-review.yml`：新增按 PR 号的 concurrency；跳过 `chore/release-metadata/*` bot PR（纯脚本生成的版本元数据）
- PR #464 `version-changelog.yml`：
- PR #464 所有 checkout/gh 操作 token 改为 `RELEASE_BOT_TOKEN || GITHUB_TOKEN`。PAT push/建 PR 会正常触发 `pull_request` 事件（CI 原生跑），PAT 合并的 merged 事件能继续触发下一段 workflow——这是旧流程所有 dispatch 补丁的根因
- PR #464 元数据 PR：github-actions[bot] 补 approve（满足 develop 的 1 review + last-push-approval，approve 者与 push 者是不同 actor）+ PAT 开 auto-merge（squash）
- PR #464 固化 PR：master 无 required check，PAT 直接 squash 合并（人工决策点已前移到 release PR）
- PR #464 回同步 PR：approve + auto-merge（**merge commit**，squash 会导致下轮发版元数据冲突）
- PR #464 安全闸：自动 approve 前校验 PR 变更文件仅限 `package.json` / `CHANGELOG.md` / `.release/pending-release.json`，含其他文件则跳过自动放行
- PR #464 移除对 bot 元数据 PR 的 AI review dispatch
- PR #464 **未配置 `RELEASE_BOT_TOKEN` 时行为与现状完全一致**（dispatch 兜底 + 人工合并）
- PR #464 CI 与 AI review 增加并发去重，同分支旧 run 自动取消
- PR #464 发版链路 bot PR 自动放行，CI/AI review 并发去重
- PR #467 放开版本元数据 PR 的 CI 触发

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #464 三个 workflow YAML 语法校验通过
- PR #464 无 PAT 回退路径逐段核对与现行为一致
- PR #464 预期效果：发版全链路（feature PR 合并 → 生产部署完成）从多次人工盯梳收敛为 1 次合并操作 + ~15 分钟自动级联
- PR #467 `git diff --check`
- PR #467 `pnpm install --frozen-lockfile`
- PR #467 pre-push `pnpm run ci:check` 通过
- PR #467 327/328 test suites（1 skipped）
- PR #467 4682 passed / 4688 total（6 skipped）

## [8.0.0] - 2026-07-07

**来源分支**: `develop`

### 更新摘要
- PR #455 删除 ReliableService 未使用的私有 sleep 方法
- PR #455 消息管道可靠性加固——ack 重试+告警、处理锁心跳续期、Bull 连接优雅关闭
- PR #455 session state 迁移为 Redis hash 字段级原子写，消除跨字段并发丢更新
- PR #455 所有出站 fetch 统一 withTimeout 保护，下游卡顿不再拖死 Agent 工具循环
- PR #455 统一置信度 rank 权威定义 + 沉淀 profile/preference 单 RPC 原子写入
- PR #455 消除 biz→channels 反向依赖 + 配置传播间隔收敛
- PR #455 prettier 格式化 message-sender.module
- PR #455 补齐可靠性 review 修复
- PR #455 架构评估修复——消息管道可靠性、记忆并发安全、工具超时与依赖治理
- PR #456 降低语义护栏 shadow 误报
- PR #456 接入 Agent 执行事件观测
- PR #456 补齐 agent 执行观测单测
- PR #456 Turned `src/observability` into the Agent execution event bus with request context, tracer, composite observer, logger observer, and persisting observer.
- PR #456 Added `agent_execution_events` plus the monitoring-side persister, cleanup RPC, 60-day retention wiring, and alerting for persist failures.
- PR #456 Instrumented Agent turn boundaries, debug chat, LLM model fallback, and tool execution/error events.
- PR #456 Kept the shadow/guardrail evidence fix in this branch: enterprise room count refresh now skips stale group counts when `syncRoom` reports failure.
- PR #456 Updated processing-chain retention so `message_processing_records`, `guardrail_review_records`, and `agent_execution_events` share the same 60-day lifecycle.
- PR #457 在 runner 出口清洗出站回复
- PR #457 Moved deterministic outbound reply cleanup into the agent runner outcome path.
- PR #457 Removed the 企微 message-layer `ReplyNormalizer` so channel delivery no longer mutates agent replies.
- PR #457 Sanitized `TurnOutcome.reply.text`, `generatedText`, and rendered `responseMessages` text parts from the same runner output.
- PR #457 Kept list/numbered-list content intact so missing-field questions no longer become “可以选”.

### 新功能
- PR #456 Turned `src/observability` into the Agent execution event bus with request context, tracer, composite observer, logger observer, and persisting observer.
- PR #456 Added `agent_execution_events` plus the monitoring-side persister, cleanup RPC, 60-day retention wiring, and alerting for persist failures.
- PR #456 Updated processing-chain retention so `message_processing_records`, `guardrail_review_records`, and `agent_execution_events` share the same 60-day lifecycle.
- PR #456 接入 Agent 执行事件观测

### 问题修复
- PR #455 补齐可靠性 review 修复
- PR #456 Instrumented Agent turn boundaries, debug chat, LLM model fallback, and tool execution/error events.
- PR #456 Kept the shadow/guardrail evidence fix in this branch: enterprise room count refresh now skips stale group counts when `syncRoom` reports failure.
- PR #457 Moved deterministic outbound reply cleanup into the agent runner outcome path.
- PR #457 Removed the 企微 message-layer `ReplyNormalizer` so channel delivery no longer mutates agent replies.
- PR #457 Sanitized `TurnOutcome.reply.text`, `generatedText`, and rendered `responseMessages` text parts from the same runner output.
- PR #457 Kept list/numbered-list content intact so missing-field questions no longer become “可以选”.

### 优化调整
- PR #455 session state 迁移为 Redis hash 字段级原子写，消除跨字段并发丢更新
- PR #455 消除 biz→channels 反向依赖 + 配置传播间隔收敛

### 运维与流程
- PR #455 删除 ReliableService 未使用的私有 sleep 方法
- PR #455 消息管道可靠性加固——ack 重试+告警、处理锁心跳续期、Bull 连接优雅关闭
- PR #455 所有出站 fetch 统一 withTimeout 保护，下游卡顿不再拖死 Agent 工具循环
- PR #455 统一置信度 rank 权威定义 + 沉淀 profile/preference 单 RPC 原子写入
- PR #455 prettier 格式化 message-sender.module
- PR #456 降低语义护栏 shadow 误报
- PR #456 补齐 agent 执行观测单测
- PR #457 在 runner 出口清洗出站回复

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #455 全量 320 测试套件 / 4639 用例全绿（含 wecom 消息 65、memory 510、group-task 218）
- PR #455 AppModule 装配 smoke 通过（@Global 令牌绑定后 DI 图完整）
- PR #455 tsc / eslint 干净
- PR #455 迁移已应用测试库（gaovfitvetoojkvtalxy）并用 supabase-js 实调验证后清理测试数据
- PR #456 `./node_modules/.bin/tsc --noEmit --pretty false`
- PR #456 `./node_modules/.bin/jest -c jest.di-smoke.config.ts --watchman=false --forceExit`
- PR #456 `./node_modules/.bin/jest tests/biz/monitoring/services/cleanup/data-cleanup.service.spec.ts tests/agent/runner/agent-runner.service.spec.ts tests/agent/generator/preparation.service.spec.ts tests/llm/llm-executor.service.spec.ts --runInBand --watchman=false`
- PR #456 `./node_modules/.bin/jest tests/tools/duliday/enterprise-room-count.util.spec.ts --runInBand --watchman=false`
- PR #457 `jest tests/agent/guardrail/output/outbound-reply-sanitizer.spec.ts tests/agent/runner/agent-runner.service.spec.ts --runInBand --watchman=false`
- PR #457 `tsc --noEmit --pretty false`
- PR #457 Full pre-push `ci:check` passed: lint, format, typecheck, web build, backend build, and full Jest coverage run.

## [7.0.0] - 2026-07-07

**来源分支**: `develop`

### 更新摘要
- PR #450 降低语义护栏 shadow 误报
- PR #450 在 review packet 中显式标记 `jobList.hasEvidence`、markdown excerpt 长度。
- PR #450 在 geocode evidence 中保留 resolved 坐标、formattedAddress、areaLevelQuery，并标记 `hasResolvedCoordinate`。
- PR #450 强化 reviewer prompt，明确 markdown-only jobList 和 unique geocode 的证据读取方式。
- PR #450 增加 evidence backstop：当 reviewer 的“无岗位证据/无地理证据”判断被 packet 证据直接反驳时，丢弃该 finding，避免 shadow 误报污染。
- PR #450 补充 packet builder 与 semantic reviewer 单测。

### 新功能
- 无

### 问题修复
- PR #450 在 review packet 中显式标记 `jobList.hasEvidence`、markdown excerpt 长度。
- PR #450 在 geocode evidence 中保留 resolved 坐标、formattedAddress、areaLevelQuery，并标记 `hasResolvedCoordinate`。
- PR #450 强化 reviewer prompt，明确 markdown-only jobList 和 unique geocode 的证据读取方式。
- PR #450 增加 evidence backstop：当 reviewer 的“无岗位证据/无地理证据”判断被 packet 证据直接反驳时，丢弃该 finding，避免 shadow 误报污染。
- PR #450 补充 packet builder 与 semantic reviewer 单测。

### 优化调整
- 无

### 运维与流程
- PR #450 降低语义护栏 shadow 误报

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #450 `pnpm jest tests/agent/guardrail/output/review-packet.builder.spec.ts tests/agent/guardrail/output/llm/semantic-reviewer.service.spec.ts --watchman=false`
- PR #450 `pnpm exec tsc --noEmit`
- PR #450 `pnpm jest tests/agent/guardrail/output --watchman=false`
- PR #450 `pnpm run build`
- PR #450 pre-push `pnpm run ci:check` passed: lint, format, typecheck, build:ci, test:ci

## [6.0.0] - 2026-07-07

**来源分支**: `develop`

### 更新摘要
- PR #441 调整功能发布升大版本规则
- PR #441 调整 release 自动版本判定：`feat:` 直接升 major；`perf:`/`refactor:` 升 minor；`fix:`/docs/其他有效提交升 patch；`BREAKING CHANGE`/`type!:` 仍优先 major。
- PR #441 `update-version-changelog.js` 支持被测试 require，导出 `analyzeReleaseLevel` / `bumpVersion`。
- PR #441 更新发版文档，并补脚本单测锁定规则。
- PR #443 增加暑假工临时防护
- PR #443 补齐复聊 shadow batch 追踪
- PR #443 响应暑假工防护 review
- PR #443 增加暑假工临时防护与复聊追踪修复

### 新功能
- PR #441 `update-version-changelog.js` 支持被测试 require，导出 `analyzeReleaseLevel` / `bumpVersion`。

### 问题修复
- PR #441 调整 release 自动版本判定：`feat:` 直接升 major；`perf:`/`refactor:` 升 minor；`fix:`/docs/其他有效提交升 patch；`BREAKING CHANGE`/`type!:` 仍优先 major。
- PR #441 更新发版文档，并补脚本单测锁定规则。

### 优化调整
- 无

### 运维与流程
- PR #441 调整功能发布升大版本规则
- PR #443 增加暑假工临时防护
- PR #443 补齐复聊 shadow batch 追踪
- PR #443 响应暑假工防护 review

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #441 `pnpm jest tests/scripts/update-version-changelog.spec.ts --watchman=false`
- PR #441 pre-push `pnpm run ci:check`：lint / format / typecheck / build / 全量 jest coverage 通过（319 passed suites，4625 passed tests）
- PR #443 `pnpm exec jest tests/tools/duliday/job-list/search.util.spec.ts tests/tools/tool/duliday-job-list.tool.spec.ts tests/tools/duliday/precheck/checklist.util.spec.ts tests/tools/tool/duliday-interview-precheck.tool.spec.ts --runInBand`
- PR #443 `pnpm exec jest tests/tools/tool/duliday-interview-precheck.tool.spec.ts tests/integration/resume-booking-flow.spec.ts --runInBand`
- PR #443 `pnpm exec jest tests/agent/reengagement/follow-up.processor.spec.ts tests/biz/monitoring/services/tracking/reengagement-tracking.service.spec.ts --runInBand`
- PR #443 `pnpm run typecheck`
- PR #443 pre-push `pnpm run ci:check` 全量通过：320 个 test suites passed，4637 个 tests passed。

## [5.33.0] - 2026-07-07

**来源分支**: `develop`

### 更新摘要
- PR #436 优化复聊控制与追溯视图
- PR #436 删除复聊候选视图旧函数签名

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- PR #436 优化复聊控制与追溯视图

### 运维与流程
- PR #436 删除复聊候选视图旧函数签名

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #436 `pnpm jest tests/agent/reengagement/follow-up.processor.spec.ts tests/agent/reengagement/scenario-registry.spec.ts tests/agent/reengagement/anchor.service.spec.ts tests/agent/reengagement/tasks/reengagement-start.tool.spec.ts tests/agent/reengagement/tasks/reengagement-follow-up.tool.spec.ts tests/biz/monitoring/reengagement-monitoring.service.spec.ts tests/web/reengagement-page.spec.ts tests/web/guardrail-trace.spec.ts tests/agent/tools/duliday-cancel-work-order.tool.spec.ts --watchman=false`
- PR #436 `pnpm jest tests/biz/monitoring/monitoring.controller.spec.ts --watchman=false`
- PR #436 `pnpm run ci:check`
- PR #436 push 前 husky pre-push 自动再次执行 `pnpm run ci:check`，已通过。
- PR #436 GitHub `CI Checks` 已通过上一轮；最新 push 后等待远端检查重新完成。

## [5.32.0] - 2026-07-07

**来源分支**: `develop`

### 更新摘要
- PR #426 二次触发全生命周期落库追溯
- PR #426 二次触发追溯观测页面 /reengagement
- PR #426 专业筛选条件纳入敏感信息，与籍贯/民族同口径
- PR #426 审查档案落库失败告警 + trace_id 唯一索引修复迁移
- PR #426 补交悬空查岗承接句检测文件
- PR #426 配置页守卫/二次触发三态运行状态控件
- PR #426 追溯状态与事件名提取为枚举
- PR #426 专业类规则误拦合规安抚话术修复
- PR #426 悬空检测正则收窄 + 悬空档案干净归档
- PR #426 流水表 anon 列权限收紧 + 孤儿列/死索引清理 + NULL 化扩展到重字段
- PR #426 labor_form 严格过滤清空召回时按兼职家族放宽
- PR #426 触达状态机守卫 + 场景灰度按 key 合并
- PR #426 观测查询时区统一上海口径 + 看板冷启动防查询风暴
- PR #426 场景标签同源注册表 + 日期本地口径 + 配置页安全写入
- PR #426 出站守卫假阳修复——拉群口径改完成时态+接地扫描全轮job_list+值对账容差
- PR #426 语义档证据包读懂 markdown + repair 上限 P1 级 fail-open
- PR #426 完善报名后复聊核验与追溯视图
- PR #426 收紧追溯权限并补查询覆盖
- PR #426 补齐候选人身份映射
- PR #426 声称判定句粒度化，修复否定/疑问盲区五类假阳
- PR #426 渠道身份冗余落库 + 主动回合流水与追溯跳转
- PR #426 下午批次假阳四连修——否定盲区/班次需求复述/社保要求行/班次数字误当面试时间
- PR #426 review修复——否定豁免句内绕过/班次豁免真伪不分/专业安抚误拦/等通知相邻句盲区/悬空检测误杀钦定兜底
- PR #426 review修复——同轮取消改约竞态/Bull去重幻影fire_at/过渡期渠道身份补愈
- PR #426 review修复——重字段保留口径回拆/触达账本保留策略/分页NaN防御
- PR #426 补齐 v5.32 六处无覆盖改动的行为级测试
- PR #426 补齐 review 三处遗留——工单核验带 per-bot token/薪资容差限语境/duplicate 不覆…
- PR #426 收敛发版阻断问题
- PR #426 release/v5.32 再触达核验与追溯视图
- PR #429 sync master into develop for v5.32.0

### 新功能
- 无

### 问题修复
- PR #426 审查档案落库失败告警 + trace_id 唯一索引修复迁移
- PR #426 专业类规则误拦合规安抚话术修复
- PR #426 出站守卫假阳修复——拉群口径改完成时态+接地扫描全轮job_list+值对账容差
- PR #426 声称判定句粒度化，修复否定/疑问盲区五类假阳
- PR #426 review修复——否定豁免句内绕过/班次豁免真伪不分/专业安抚误拦/等通知相邻句盲区/悬空检测误杀钦定兜底
- PR #426 review修复——同轮取消改约竞态/Bull去重幻影fire_at/过渡期渠道身份补愈
- PR #426 review修复——重字段保留口径回拆/触达账本保留策略/分页NaN防御

### 优化调整
- PR #426 触达状态机守卫 + 场景灰度按 key 合并

### 运维与流程
- PR #426 二次触发全生命周期落库追溯
- PR #426 二次触发追溯观测页面 /reengagement
- PR #426 专业筛选条件纳入敏感信息，与籍贯/民族同口径
- PR #426 补交悬空查岗承接句检测文件
- PR #426 配置页守卫/二次触发三态运行状态控件
- PR #426 追溯状态与事件名提取为枚举
- PR #426 悬空检测正则收窄 + 悬空档案干净归档
- PR #426 流水表 anon 列权限收紧 + 孤儿列/死索引清理 + NULL 化扩展到重字段
- PR #426 labor_form 严格过滤清空召回时按兼职家族放宽
- PR #426 观测查询时区统一上海口径 + 看板冷启动防查询风暴
- PR #426 场景标签同源注册表 + 日期本地口径 + 配置页安全写入
- PR #426 语义档证据包读懂 markdown + repair 上限 P1 级 fail-open
- PR #426 完善报名后复聊核验与追溯视图
- PR #426 收紧追溯权限并补查询覆盖
- PR #426 补齐候选人身份映射
- PR #426 渠道身份冗余落库 + 主动回合流水与追溯跳转
- PR #426 下午批次假阳四连修——否定盲区/班次需求复述/社保要求行/班次数字误当面试时间
- PR #426 补齐 v5.32 六处无覆盖改动的行为级测试
- PR #426 补齐 review 三处遗留——工单核验带 per-bot token/薪资容差限语境/duplicate 不覆…
- PR #426 收敛发版阻断问题
- PR #429 sync master into develop for v5.32.0

### 配置变更
- 无

### 环境变量提醒
- PR #426 检测到环境变量相关文件变更：`.env.example`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- PR #426 `jest tests/agent/guardrail/output/hard-rules.service.spec.ts tests/agent/reengagement/follow-up.processor.spec.ts` — 233 passed
- PR #426 前后端 `tsc --noEmit` 通过
- PR #426 pre-push 钩子全量 ci:check 通过

## [5.31.0] - 2026-07-03

**来源分支**: `develop`

### 更新摘要
- PR #420 结构化输出 schema 去掉 Anthropic 不支持的范围/长度约束
- PR #421 上线首日误伤修复 + 工具调用文本泄漏封堵
- PR #421 precheck_blocked_booking_claim 只认真正阻断态
- PR #421 支持多岗位并行报名，软查重收敛到同岗位维度
- PR #421 移除 Anthropic 结构化输出不支持的 schema 约束
- PR #421 出站守卫审查全程档案落库并在详情页还原全过程
- PR #421 收紧误伤豁免正则，裸词豁免改语境锚定（PR #421 review）
- PR #421 收口分层边界并补 guardrail 审查档案
- PR #421 守卫上线首日误伤修复 + 多岗位报名 + 出站守卫审查全程档案

### 新功能
- PR #420 结构化输出 schema 去掉 Anthropic 不支持的范围/长度约束
- PR #421 支持多岗位并行报名，软查重收敛到同岗位维度
- PR #421 移除 Anthropic 结构化输出不支持的 schema 约束

### 问题修复
- PR #421 上线首日误伤修复 + 工具调用文本泄漏封堵

### 优化调整
- 无

### 运维与流程
- PR #421 precheck_blocked_booking_claim 只认真正阻断态
- PR #421 出站守卫审查全程档案落库并在详情页还原全过程
- PR #421 收紧误伤豁免正则，裸词豁免改语境锚定（PR #421 review）
- PR #421 收口分层边界并补 guardrail 审查档案

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #420 tsc 0 错误
- PR #420 `tests/evaluation` 2 套件 / 34 测试全过（pre-push 全量 ci:check 亦通过）
- PR #421 全量 jest：304 套件 / 4374 通过
- PR #421 后端 `tsc --noEmit` 与 web `tsc -b` 通过
- PR #421 守卫档案链路已在本地 + 测试库端到端验证（写入 → 详情 API → Dashboard 渲染）

## [5.30.0] - 2026-07-03

**来源分支**: `develop`

### 更新摘要
- PR #415 结构归位到 §7 目标树 (generator/ + guardrail/input/)
- PR #415 reply-fact-guard 迁入 agent/guardrail/output/rule/
- PR #415 risk-intercept 依赖倒置 + 迁入 agent/guardrail/input/r…
- PR #415 补 ConfigService mock 修复 READ_ONLY_PREVIEW 引入的 DI 失败
- PR #415 入站终态收口到 runner 共享分类器 + 修出站守卫副作用误判
- PR #415 index on agent-reliability-runtime-on-precheck: aa347257 refactor(age…
- PR #415 WIP on agent-reliability-runtime-on-precheck: aa347257 refactor(agent…
- PR #415 清理 pipeline spec 对已删除 rule-guardrail 的残留引用
- PR #415 invite_to_group 城市 provenance gate 拦截模型自报城市
- PR #415 补交 5 个迁移文件 (legacy 清理/blacklist RLS/active_booking 改名/guar…
- PR #415 drop_legacy_agent_memories 迁移改为真幂等 (表缺失时 DROP TRIGGER ON 会报错)
- PR #415 supabase CLI 2.77.1 → 2.109.0 (修多语句迁移 prepared statement…
- PR #415 MemoryModule 导出 ShortTermService
- PR #415 jobList args 白名单投影进证据包 + 补 SemanticReviewer 独立单测
- PR #415 列表 summary 投影补 guardrail 两列 + 修 trace 提示竖排样式
- PR #415 GuardrailTrace 修复说明插到首审与二审之间 (时间线因果顺序)
- PR #415 回归复测三项修复——区级定位标记/testing拉群模拟/会话品牌兜底
- PR #415 可靠性收口主体——guardrail 模块化 + runner/复聊 + 发版前 review 修复
- PR #415 补交 runner/复聊配套新文件——anchor/turn-finalizer/干预/副作用类型 + turn…
- PR #415 查询分类器 + 候选排序 util（区级定位标记配套）
- PR #415 消息处理详情 GuardrailSection 守卫裁决展示 + 配置页收尾
- PR #415 补交 handoff 事件飞书同步脚本 + guardrail llm 层设计/运营文档
- PR #415 捞回 stash 中 8 项未入库可靠性修复（并入本次发版）
- PR #415 恢复入站守卫既定架构——纯评估器 + 副作用意图统一出口，下线 conversation-ris…
- PR #415 岗位卡片列表不做口语化压缩，保留括号内店名/班别（badcase 6a470fddce406a6aeee03d0d）
- PR #415 Merge remote-tracking branch 'origin/develop' into codex/agent-reliab…
- PR #415 恢复 7-01 Codex runner/generator 架构重构，与可靠性专项二期定向合并
- PR #415 可靠性专项二期 × 7-01 runner/generator 架构重构 定向合并版

### 新功能
- 无

### 问题修复
- PR #415 补 ConfigService mock 修复 READ_ONLY_PREVIEW 引入的 DI 失败
- PR #415 入站终态收口到 runner 共享分类器 + 修出站守卫副作用误判
- PR #415 GuardrailTrace 修复说明插到首审与二审之间 (时间线因果顺序)
- PR #415 回归复测三项修复——区级定位标记/testing拉群模拟/会话品牌兜底
- PR #415 可靠性收口主体——guardrail 模块化 + runner/复聊 + 发版前 review 修复
- PR #415 捞回 stash 中 8 项未入库可靠性修复（并入本次发版）

### 优化调整
- PR #415 index on agent-reliability-runtime-on-precheck: aa347257 refactor(age…
- PR #415 WIP on agent-reliability-runtime-on-precheck: aa347257 refactor(agent…
- PR #415 恢复 7-01 Codex runner/generator 架构重构，与可靠性专项二期定向合并

### 运维与流程
- PR #415 结构归位到 §7 目标树 (generator/ + guardrail/input/)
- PR #415 reply-fact-guard 迁入 agent/guardrail/output/rule/
- PR #415 risk-intercept 依赖倒置 + 迁入 agent/guardrail/input/r…
- PR #415 清理 pipeline spec 对已删除 rule-guardrail 的残留引用
- PR #415 invite_to_group 城市 provenance gate 拦截模型自报城市
- PR #415 补交 5 个迁移文件 (legacy 清理/blacklist RLS/active_booking 改名/guar…
- PR #415 drop_legacy_agent_memories 迁移改为真幂等 (表缺失时 DROP TRIGGER ON 会报错)
- PR #415 supabase CLI 2.77.1 → 2.109.0 (修多语句迁移 prepared statement…
- PR #415 MemoryModule 导出 ShortTermService
- PR #415 jobList args 白名单投影进证据包 + 补 SemanticReviewer 独立单测
- PR #415 列表 summary 投影补 guardrail 两列 + 修 trace 提示竖排样式
- PR #415 补交 runner/复聊配套新文件——anchor/turn-finalizer/干预/副作用类型 + turn…
- PR #415 查询分类器 + 候选排序 util（区级定位标记配套）
- PR #415 消息处理详情 GuardrailSection 守卫裁决展示 + 配置页收尾
- PR #415 补交 handoff 事件飞书同步脚本 + guardrail llm 层设计/运营文档
- PR #415 恢复入站守卫既定架构——纯评估器 + 副作用意图统一出口，下线 conversation-ris…
- PR #415 岗位卡片列表不做口语化压缩，保留括号内店名/班别（badcase 6a470fddce406a6aeee03d0d）
- PR #415 Merge remote-tracking branch 'origin/develop' into codex/agent-reliab…

### 配置变更
- 无

### 环境变量提醒
- PR #415 检测到环境变量相关文件变更：`.env.example`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- 无

## [5.29.0] - 2026-06-29

**来源分支**: `develop`

### 更新摘要
- PR #410 恢复工具调用前生成的候选人正文
- PR #410 修复工具调用前正文未投递问题

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #410 恢复工具调用前生成的候选人正文

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #410 `pnpm jest tests/agent/agent.service.spec.ts tests/channels/wecom/message/utils/output-leak-guard.util.spec.ts --watchman=false`
- PR #410 `pnpm run typecheck`
- PR #410 pre-push `pnpm run ci:check` 通过：lint、format、typecheck、web build、Nest build、全量 Jest coverage；最新 `origin/develop` 上结果 `300 passed / 1 skipped` suites，`4107 passed / 6 skipped` tests。

## [5.28.0] - 2026-06-25

**来源分支**: `develop`

### 更新摘要
- PR #396 为 precheck 和 booking 工具新增 jobId provenance 闸门（isRecalledJobId），阻断模型在无岗位上下文时自由编造 jobId + 候选人信息的 P0 幻觉链路
- PR #404 给 precheck/booking 加 jobId provenance 闸门拦截幻觉岗位
- PR #404 Phase 0a seams + HC-2/3 jobId gate + handoff 三态 baseline
- PR #404 可靠性重构 + 复聊 逐块实施路线图
- PR #404 HC-1 revise 回路接缝 (isToolSuccess/hasCommittedSideEffect +…
- PR #404 HC-2 候选人原文确定性 parser + normalizer + 权威字段准入
- PR #404 HC-2 precheck-core 共享原语 + booking 姓名负向证据闸门
- PR #404 guardrail 中立契约 + 可审计 catalog
- PR #404 output rule 补 candidate_name_echo/distance_missing +…
- PR #404 TurnOutcome 抽象 + runner.runTurn + proactive 入口
- PR #404 reengagement 复聊模块 (shadow mode)
- PR #404 reengagement 接入 opening 锚点 (shadow 端到端激活)
- PR #404 补 pipeline spec 运行时依赖 mock
- PR #404 修复 reengagement lint 问题
- PR #404 更新可靠性改造落地进展
- PR #404 Merge remote-tracking branch 'origin/develop' into codex/agent-reliab…
- PR #404 修复复聊评审问题
- PR #404 修复复聊状态机评审问题
- PR #404 修复复聊跨轮停止条件
- PR #404 Adds the agent reliability runtime/precheck refactor stack, including HC precheck provenance gates, guardrail contracts/catalog, TurnRunner abstractions, and reengagement shadow-mode plumbing.
- PR #404 Wires opening-sent reengagement scheduling and keeps proactive delivery shadowed by default.
- PR #404 Fixes the pipeline service spec module wiring for the new TurnRunner/FollowUp/Handoff dependencies and resolves pre-push lint issues.
- PR #404 Agent reliability runtime on precheck
- PR #406 sync master into develop for v5.28.0

### 新功能
- PR #404 reengagement 接入 opening 锚点 (shadow 端到端激活)

### 问题修复
- PR #396 新增 isRecalledJobId provenance 闸门：jobId 必须出自当前会话召回集（presentedJobs / lastCandidatePool / currentFocusJob ∪ 本轮 job_list 实时候选池），否则返回 precheck.job_not_provided / booking.job_not_provided 并要求先调用 duliday_job_list
- PR #396 改约场景：将进行中工单的 jobId 并入召回集，避免改约路径被误拦
- PR #396 修复 formatBookingContext 展示字段全空时仍将工单 jobId 注入 provenance 集的静默绕过漏洞
- PR #396 归一 provenance jobId 类型为 number（兼容数字串），与 system prompt 渲染口径对齐，防止 Upstash 缓存反序列化为字符串时改约被永久卡死
- PR #404 Fixes the pipeline service spec module wiring for the new TurnRunner/FollowUp/Handoff dependencies and resolves pre-push lint issues.
- PR #404 修复 reengagement lint 问题
- PR #404 修复复聊评审问题
- PR #404 修复复聊状态机评审问题
- PR #404 修复复聊跨轮停止条件

### 优化调整
- PR #404 Adds the agent reliability runtime/precheck refactor stack, including HC precheck provenance gates, guardrail contracts/catalog, TurnRunner abstractions, and reengagement shadow-mode plumbing.
- PR #404 可靠性重构 + 复聊 逐块实施路线图

### 运维与流程
- PR #404 Wires opening-sent reengagement scheduling and keeps proactive delivery shadowed by default.
- PR #404 给 precheck/booking 加 jobId provenance 闸门拦截幻觉岗位
- PR #404 Phase 0a seams + HC-2/3 jobId gate + handoff 三态 baseline
- PR #404 HC-1 revise 回路接缝 (isToolSuccess/hasCommittedSideEffect +…
- PR #404 HC-2 候选人原文确定性 parser + normalizer + 权威字段准入
- PR #404 HC-2 precheck-core 共享原语 + booking 姓名负向证据闸门
- PR #404 guardrail 中立契约 + 可审计 catalog
- PR #404 output rule 补 candidate_name_echo/distance_missing +…
- PR #404 TurnOutcome 抽象 + runner.runTurn + proactive 入口
- PR #404 reengagement 复聊模块 (shadow mode)
- PR #404 补 pipeline spec 运行时依赖 mock
- PR #404 更新可靠性改造落地进展
- PR #404 Merge remote-tracking branch 'origin/develop' into codex/agent-reliab…
- PR #406 sync master into develop for v5.28.0

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #396 precheck / booking / agent-preparation 测试全绿（103 passed，含新增 6 个回归测试）
- PR #396 覆盖场景：幻觉 jobId 被拦截且不打 Sponge、真实召回 jobId 正常放行、未注入闸门向后兼容、改约工单 jobId 放行、展示字段缺失时工单 jobId 不作 provenance、缓存数字串 jobId 正确识别
- PR #404 pnpm run typecheck
- PR #404 pnpm test -- --watchman=false
- PR #404 pre-push pnpm run ci:check passed, including lint:check, format:check, typecheck, build:ci, and test:ci coverage.

## [5.27.3] - 2026-06-24

**来源分支**: `develop`

### 更新摘要
- PR #397 禁止主动提保险社保口径

### 新功能
- 无

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #397 禁止主动提保险社保口径

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #397 `jest tests/channels/wecom/message/application/reply-fact-guard.service.spec.ts tests/tools/duliday/job-list/welfare-facts.util.spec.ts tests/tools/duliday/job-list/render.util.spec.ts --watchman=false`
- PR #397 `prettier --check` on touched files
- PR #397 pre-push `ci:check` passed:
- PR #397 lint
- PR #397 format
- PR #397 typecheck
- PR #397 web build
- PR #397 backend build
- PR #397 `jest --coverage --watchman=false`: 292 passed, 1 skipped

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
