# TODO: Recruitment Case 跟进窗口与阶段回切治理

## 问题背景

当前 `RecruitmentCaseRecord` 只承载 `onboard_followup` 这一类 case，但它的“是否还在跟进期”与“是否回到新一轮岗位咨询”是两套不同的判断机制：

- case 状态定义在 [src/biz/recruitment-case/types/recruitment-case.types.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/biz/recruitment-case/types/recruitment-case.types.ts:1)
  - `active`
  - `handoff`
  - `closed`
  - `expired`
- 实际读取 active case 时，当前生效逻辑是：
  - 先查 `status = active`
  - 再在代码里判断 `followup_window_ends_at < now` 是否过期
  - 过期则直接返回 `null`

见 [src/biz/recruitment-case/services/recruitment-case.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/biz/recruitment-case/services/recruitment-case.service.ts:55)。

也就是说，当前是：

- `handoff / closed` 走真实状态机
- `expired` 只存在于类型里，但没有真正回写数据库
- 跟进窗口是否有效，主要靠代码时间判断，不是纯状态判断

## 当前实现

### 1. case 创建

约面成功后会关闭同 chat 下旧的 `active/handoff` case，再创建一个新的 `active onboard_followup` case。

见：

- [src/tools/duliday-interview-booking.tool.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/tools/duliday-interview-booking.tool.ts:354)
- [src/biz/recruitment-case/services/recruitment-case.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/biz/recruitment-case/services/recruitment-case.service.ts:16)
- [src/biz/recruitment-case/repositories/recruitment-case.repository.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/biz/recruitment-case/repositories/recruitment-case.repository.ts:52)

### 2. 跟进窗口

`followup_window_ends_at` 默认按 `interview_time + RECRUITMENT_FOLLOWUP_WINDOW_DAYS` 计算，默认 7 天。

见 [src/biz/recruitment-case/services/recruitment-case.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/biz/recruitment-case/services/recruitment-case.service.ts:90)。

### 3. handoff / close

- Agent 调用 `request_handoff` 后，会暂停托管并把 case 改成 `handoff`
- 恢复托管时，会把最近的 `handoff` case 改成 `closed`

见：

- [src/tools/request-handoff.tool.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/tools/request-handoff.tool.ts:63)
- [src/biz/intervention/intervention.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/biz/intervention/intervention.service.ts:91)
- [src/biz/user/user.controller.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/biz/user/user.controller.ts:32)

### 4. 新一轮岗位咨询判断

当前并不是通过 case 状态“回切”为 `job_consultation`，而是运行时通过消息内容启发式判断：

- 如果当前存在有效 case，默认优先进入 `onboard_followup`
- 如果用户消息命中“还有其他岗位吗 / 换岗位 / 重新找工作 / 再推荐岗位”等模式，则回退到 `proceduralStage`

见 [src/biz/recruitment-case/services/recruitment-stage-resolver.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/biz/recruitment-case/services/recruitment-stage-resolver.service.ts:36)。

## 当前风险

1. `expired` 只是逻辑概念，不是持久化状态
   - 数据库里可能仍然是 `active`
   - 排障和 BI 很容易误判

2. 跟进窗口不是滚动的
   - `last_relevant_at` 目前只在创建 case 和 handoff 时更新
   - 当前不会因为后续正常跟进消息自动续期

3. “回到新一轮岗位咨询”没有持久化落点
   - 只是在当前轮 Agent 入口通过 regex 做阶段覆盖
   - 没有明确的 case 关闭/作废/切换记录

4. 启发式规则较脆弱
   - `NEW_JOB_CONSULT_PATTERNS` 覆盖有限
   - 模糊表达很容易被错误归到 `onboard_followup`

## TODO 目标

### A. 明确 case 生命周期语义

- 明确 `active / handoff / closed / expired` 各自定义
- 增加真正的 `expireCase` / `expireOverdueCases` 流程
- 让过期从“代码判空”升级为“状态落库 + 代码读取”

### B. 明确跟进窗口模型

二选一，至少要统一：

- 固定窗口：从 `interview_time` 起固定 N 天，不滚动
- 滚动窗口：根据 `last_relevant_at` 持续续期

如果继续保留 `last_relevant_at` 字段，建议把它真正纳入有效期判断，而不是只在 handoff 时更新。

### C. 明确“重新开启岗位咨询”的收口动作

当用户明确表达重新找岗/换岗/看其他岗位时，应该评估是否需要：

- 关闭当前 `onboard_followup` case
- 或将其标记为 `closed / expired / superseded`
- 或新建新的咨询轮次标记

至少要保证：

- 运行时阶段回切有明确业务事件
- 后台能追到“候选人为什么退出原 followup case”

### D. 收敛阶段判断口径

把以下两套逻辑统一：

- `RecruitmentCaseService.getActiveOnboardFollowupCase()` 的有效性判断
- `RecruitmentStageResolverService` 的阶段覆盖判断

避免出现：

- case 还在，但业务上其实已经开始新一轮咨询
- case 已经过期，但数据库仍显示 active

## 建议改造顺序

1. 先补“过期状态落库”
2. 再决定跟进窗口是固定还是滚动
3. 最后补“新一轮岗位咨询”的持久化业务动作

## 状态

- [ ] 明确 `expired` 是否应成为真实持久化状态
- [ ] 明确跟进窗口是否需要按 `last_relevant_at` 滚动
- [ ] 明确“重新找岗”是否需要关闭当前 followup case
- [ ] 将阶段回切从纯 regex 升级为可追踪的业务事件

---

**创建时间**: 2026-04-16
**优先级**: 高
