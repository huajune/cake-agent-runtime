# Changelog

所有重要的项目更改都将记录在此文件中。

本项目遵循 语义化版本 规范。
版本号由 GitHub Actions 自动维护，发布说明统一使用中文记录。
变更记录按 PR 驱动整理：自动清理 PR/commit 前缀与常见英文工程表述，尽量产出可直接用于发布通知的中文摘要。

---

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
