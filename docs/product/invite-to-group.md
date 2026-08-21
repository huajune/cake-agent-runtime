# 拉人进群 — 产品设计文档

Agent 在对话中根据候选人情况，自动将其拉入匹配的企微兼职岗位信息群（`invite_to_group` 工具）。本文描述已实现系统的现行口径；实现在 `src/tools/invite-to-group.tool.ts` 与 `src/tools/shared/invite-timing-gate.ts` / `invite-city-gate.ts`。

---

## 目录

- [业务背景](#业务背景)
- [触发策略（0820 口径）](#触发策略0820-口径)
- [两轮协议与守卫口径](#两轮协议与守卫口径)
- [确定性闸门](#确定性闸门)
- [群匹配规则](#群匹配规则)
- [群容量管理](#群容量管理)
- [核心流程](#核心流程)
- [投递方式与返回字段](#投递方式与返回字段)
- [失败分档](#失败分档)
- [工具定义](#工具定义)
- [数据依赖](#数据依赖)
- [运维操作](#运维操作)
- [后续迭代](#后续迭代)

---

## 业务背景

当前招聘 Agent 以 1v1 私聊为主。兼职群（如"上海零售群"）是岗位信息的二级分发渠道，群内定期推送岗位、抢单信息。将候选人拉入群聊，可以：

1. **扩大岗位触达** — 已完成预约的候选人，在群里看到更多同城/同行业岗位
2. **承接推荐不匹配的候选人** — 连续推荐均不满意的候选人，转入群内持续运营
3. **降低流失率** — 候选人留在群里，后续有新岗位时可自然触达

本工具只发送**兼职岗位信息群**（返回 `groupPurpose: "job_pool"`），不发送面试群——预约成功岗位若要求单独面试群，走 booking 工具的 `_manualInterviewGroupGuide` 人工链路，两者严格区分。

拉人使用企业级接口（`/hub-api/api/v1/instantReply/addFromRoom`，`RoomService.addMemberEnterprise`），不受小组限制：优先用当前接客 bot 邀请；若接口返回 `room not found`（接客 bot 不在该群），先用群列表记录的群所属 bot 把接客 bot 拉进群，触发 `syncRoom` 刷新群数据后按 3s/5s/8s 退避重试拉候选人（企微入群与平台数据同步有数秒延迟，立即重试必然再报 room not found）。

---

## 触发策略（0820 口径）

拉群只有**两条合法入口**（外加同意确认轮），真无岗**不拉群**：

### 场景 1：首次面试预约成功后，同轮首拉

| 条件 | 说明 |
|------|------|
| 前提 | `duliday_interview_booking` 返回 `success: true`，且必须检查 `_outcome` 字段确认预约真的成功 |
| 时机 | 已知候选人城市时，**同轮**调用 |
| 限制 | 仅限本会话**首次**预约成功时触发；后续再预约不再重复拉群 |

> 旧口径的"登记完成后由 `advance_stage` 推进触发"已废弃——现行判据是 booking 工具本轮成功（回合账本 `bookingSucceeded`），与阶段推进无关。

### 场景 2：连续两轮推荐均不满意后的群承接

严格的三步节奏，**不是"没岗就拉群"**：

1. 候选人已明确否定**两轮**具体岗位推荐；
2. 上一轮 Agent **停止第三轮推荐**，按 noMatchScript 口径征询入群意愿（"要不我邀请你进群？"）——本轮**不调工具**；
3. 候选人下一轮明确同意后，才实调本工具。

**拉群不能替代取消工单**：候选人在面试开始之前放弃的岗位若有进行中的工单，必须同时走 `duliday_cancel_work_order` 取消再拉群收尾（面试时间已到/已过属爽约，不取消工单）。

### 场景 3：候选人同意入群/后续通知

上一轮 Agent 曾提出"拉群/进群/有岗位通知"，候选人本轮回复"好/可以/嗯/谢谢"等同意词时，**必须实调**本工具确认是否真的能拉群；只有 `success: true` 才能说已拉群或已发邀请。提了拉群却一直不调 = 空头承诺，候选人看到没动静会立刻流失。

### 真无岗不拉群

**真实搜索 0 条、暑假工无库存**等"查了确实没有"的情况**不属于任何拉群场景**：按 noMatchScript 如实收口、等待库存，不得借"本轮跑过 job_list"偷渡拉群。这是 0820 口径对旧"穷尽推荐后无匹配就拉群兜底"策略的替换——查岗完成不等于获得拉群授权。

### 禁止触发

- booking 本轮已调用且返回失败/抛异常（场景 1 前提不成立）
- 城市未知，或候选人明确拒绝/表示不需要
- 本会话已经成功拉过群（会话记忆 `invitedGroups`）
- 尚未做过任何岗位检索
- [兼职群资源] prompt 段已注明该城市无可用群
- **候选人正在推进某个已匹配岗位的收资/约面/确认**（"怎么报名/几点面试"等推进信号）——拉群是"无岗维护"场景，不是"有岗推进"场景，此时拉群等于打断成单

### 拉群即收口

决定拉群（工具成功）后，本轮必须停止继续推荐其他岗位、不再输出追问话术；后续轮也不再向候选人推岗位，转为群内运营。

---

## 两轮协议与守卫口径

拉群动作链固定为**两轮**：征询（不调工具）→ 候选人同意 → 下轮实调。与之配套的守卫口径（产品裁定）：

- **征询式/将来时**（"要不我拉你进群？""后面群里有岗位通知你"）**不拦**——这是协议第一轮的合法话术；
- **完成时态假宣称**（"已拉你进群""群邀请已经发你了"）必须本轮实调工具且 `success: true`，否则由出站守卫拦截：语义审查档以 `groupInvite` 工具证据对账，无 `success: true` 证据的完成态群邀请陈述按无证据事实裁决；有证据时同句话属如实陈述、明确豁免。

---

## 确定性闸门

工具描述里的前置条件屡被模型击穿（badcase 63eefu6c：同会话两次违规拉群），因此全部关键前置已落成**工具运行时确定性闸门**，拒绝均为可恢复（reject_collect 语义），执行顺序如下：

### 0. 区县误传纠正

`city` 传了区/县（如"静安区"）时返回 `invite.invalid_city_scope` + `expectedCity`（`resolveCityFromDistrict` 确定性映射），指示模型改用城市级名称重调。

### 1. 前置已在群闸门

城市 provenance 校验**之前**，先用缓存群列表 + 实时群成员关系核验候选人是否已在目标城市兼职群：已在群则直接短路成功（业务目标已达成），不再要求城市出处——实时群成员关系本身就是该城市的最强依据。

### 2. 城市 provenance gate（`invite-city-gate.ts`）

拉群是不可逆副作用，`city` 入参必须能追溯到外生出处，模型自报不构成依据。五档出处（任一命中即放行）：

| 档位 | 出处 |
|------|------|
| `session_fact` | 会话记忆高置信城市事实（含 geocode 确权/定位分享按 source='system' 写入） |
| `user_text` | 候选人本会话原文出现过该城市 |
| `district_inference` | 候选人原文命中 geo 地名白名单（唯一区名/高置信地标 → 城市），走 `@resolution/geo` 统一扫描 |
| `turn_geocode` | 本轮 geocode unique 确权城市（`ledger.geo.anchors` 穿线，补"轮末写档、下轮生效"的同轮时序空档） |
| `turn_map_screenshot` | 本轮视觉事实 sheet 中 map_location 截图的城市（岗位截图的门店城市不算） |

拒绝两分支：`invite.city_conflict`（与会话城市事实不一致，返回 `expectedCity`）/ `invite.city_unverified`（任何出处都找不到，先向候选人确认城市）。

### 3. 时机 gate（`invite-timing-gate.ts`）

四档判定（顺序即优先级）：

| 拒绝原因 | 判据 | errorType |
|---------|------|-----------|
| `already_invited_city` | 会话记忆 `invitedGroups` 已有同城市记录（换城市放行） | `invite.already_invited` |
| `no_job_result_this_turn` | 本轮没跑过 `duliday_job_list`（突兀拉群） | `invite.no_job_result` |
| `group_consent_required` | 本轮查过岗但没有合法入群授权——既非预约成功首拉、亦非两轮协议第二轮 | `invite.group_consent_required` |
| `booking_progress_signal` | 候选人本轮原话命中报名/约面推进词表（打断成单） | `invite.booking_in_progress` |

豁免：`bookingSucceeded === true`（场景 1）与 `groupOfferAccepted === true`（两轮协议第二轮，由"上一轮 assistant 征询 + 本轮 user 同意词"消息序列确定性识别）豁免后三档。`group_consent_required` 拒绝时，若已累计两轮推荐不满意，返回值内嵌 noMatchScript 指导模型本轮征询入群（进入两轮协议第一轮）。

---

## 群匹配规则

### 标签体系

群通过托管平台标签标识，格式为 3 级标签：

```
[群类型, 城市, 行业]
```

示例：
| 群名 | 标签 |
|------|------|
| 上海餐饮群 | [兼职群, 上海, 餐饮] |
| 上海零售群 | [兼职群, 上海, 零售] |
| 武汉餐饮群① | [兼职群, 武汉, 餐饮] |

（容错：第二标签是行业词且存在第三标签时，按 [类型, 行业, 城市] 换序解析。）

### 匹配优先级

```
1. 城市过滤：normalizeCity 归一后精确匹配（"北京市"≈"北京"）
   无匹配 → invite.no_group_in_city，静默自然收口
2. 行业精筛：入参 industry 有匹配群 → 只在其中选
   无匹配 → 回退城市级全部群（返回 fallbackUsed: true + matchedIndustry 供解释）
3. 同标签多群：按实时 memberCount 升序，选人数最少的未满群（负载均衡）
   selectionReason: lowest_member_count / only_option
```

Prompt 侧 [兼职群资源] 段（`group-inventory.section.ts`）预先注入该城市各行业群的分布与容量概览，让模型调用前就知道该传什么 `industry`、该城市有没有群。

---

## 群容量管理

- **数据来源**：选群前调 `refreshMemberCountsFromEnterpriseList` 用企业级群列表实时刷新 `memberCount`
- **容量阈值**：`GROUP_MEMBER_LIMIT`（默认 200），选群时过滤 `memberCount >= limit` 的群
- **群满处理**：候选群全满（含拉人接口实时返回 -10 群满）→ 飞书告警（含城市/行业/群列表及人数，提示扩群）+ 返回 `invite.group_full`；**不向候选人提及群满**。候选人本轮是在同意入群/等群维护时，按失败分档转人工跟进
- **运营扩群**：创建新群 + 打相同标签，10 分钟缓存过期后自动纳入分配

> **为什么不自动建群**：托管平台 API 不支持建群接口，且建群涉及群名规范、群主分配等运营决策，适合人工处理。

---

## 核心流程

```
LLM 决定拉群（city 必填, industry 强烈建议）
  │
  ├─ 0. 本轮 booking 失败短路 / 区县误传纠正（expectedCity）
  ├─ 1. 前置已在群闸门（缓存群列表 + 实时成员关系）→ 已在群直接 success
  ├─ 2. 城市 provenance gate（五档出处）→ conflict/unverified 拒绝
  ├─ 3. 时机 gate（already_invited / no_job_result / consent / progress）
  ├─ 4. testing 链路（test-suite 重放）在此返回模拟成功，不触达企业接口
  │
  ├─ 5. 获取兼职群列表（forceRefresh）→ 城市过滤 → 行业精筛（可回退）
  ├─ 6. 实时成员预检（forceRefresh 后群列表再核一次，覆盖缓存缺群窗口）
  ├─ 7. 企业级列表刷新 memberCount → 按容量升序选群
  │
  ├─ 8. 逐群尝试企业级拉人 addMemberEnterprise
  │     ├─ room not found → 群所属 bot 拉接客 bot 入群 + syncRoom + 3s/5s/8s 退避重试
  │     ├─ errcode=-9 已在群 → 按 success（alreadyInGroup）返回
  │     ├─ errcode=-10 群满 → 记录，换下一个候选群
  │     ├─ errcode=-12 → 平台已改发邀请卡片，视为投递成功（不再换群连发卡片）
  │     └─ 其他拒绝（含 -8 非好友）→ 记录，换下一个候选群
  │
  ├─ 9. 成功：写会话记忆 invitedGroups → 记 ops 事件 group.invited
  │        → 返回 success + inviteDelivery + _replyInstruction
  └─ 10. 全部失败：按 -8 全拒/接口拒绝/群满 分档返回（见失败分档）
```

---

## 投递方式与返回字段

### inviteDelivery 两档

| 值 | 判定 | 候选人体验 | 话术口径 |
|----|------|-----------|---------|
| `direct_add` | 群人数 **< 40** 且非 -12 降卡 | 直接被拉入群 | "已帮你加入了「XX群」" |
| `invite_card` | 群人数 ≥ 40，或接口返回 **errcode=-12**（企微对外部联系人强制发卡） | 收到入群邀请卡片，点击同意后入群 | "邀请已经发你了，点一下卡片就能进" |

errcode=-12 表示平台已实际下发邀请卡片，**按投递成功处理**——若当失败继续换群重试，候选人会连收该城市全部候选群的卡片（badcase：上海零售 5 群连发 5 张卡）。`invite_card` 场景严禁模型输出/编造任何群链接 URL。

### already_in_group 语义

候选人已在群（前置闸门/实时预检/接口 -9 任一命中）返回 **`success: true` + `alreadyInGroup: true`**——这是业务目标已达成的正常路径，**不是失败**；不走失败分支，避免 prompt 的"invite 失败转人工"兜底把它误当故障处理。同时写入会话记忆防重调。

### 成功返回字段

`groupName` / `groupPurpose`（固定 `"job_pool"`）/ `city` / `industry` / `inviteDelivery` / `matchedIndustry`（实际命中行业）/ `fallbackUsed`（行业回退标记）/ `selectionReason` / `citySnapshot`（该城市群分布概览，候选人质疑选群时作解释依据）/ `_outcome` / `_replyInstruction`（必须严格遵守的话术指令，含"这是兼职群不是面试群"边界与中间步骤文字未送达提醒）。

---

## 失败分档

核心裁定：**只有群满/结构性失败转人工；无群、非好友不转**。

### 不转人工（自然收口，继续托管）

| errorType | 场景 | 处理 |
|-----------|------|------|
| `invite.no_group_in_city` / `invite.no_group_available` | 该城市/平台本就没有兼职群（区别于群满） | `NO_GROUP_CONTINUE_INSTRUCTION`：不提群、不转人工，礼貌告知暂无合适岗位、后续有匹配主动联系，正常收口保持托管。会话已告知过无岗时追加防复读升级指令（禁止逐字重复、只回应本轮问题） |
| `invite.candidate_not_friend` | 全部候选群返回 errcode=**-8** "is not a friend"（候选人已删除/拉黑接客账号） | 候选人侧真实状态、人工无可作为：不发运维告警、不转人工、不提群，自然收口 |

### 转人工（request_handoff，reasonCode="other"）

| errorType | 场景 | 附加动作 |
|-----------|------|---------|
| `invite.group_full` | 候选群均满（预检或接口 -10） | 飞书群满告警（扩群） |
| `invite.api_rejected` | 候选群均被接口拒绝（含接客 bot 补偿入群后仍失败的结构性问题） | 飞书拒绝告警（修 bot 群关系，与群满告警分通道） |
| `invite.enterprise_token_missing` / `invite.missing_bot_identity` / `invite.api_failed` | 配置缺失 / 上下文缺失 / 接口异常 | — |

转人工的适用前提：候选人本轮是在同意入群/后续通知，或当前意向已无匹配需要群维护——不能自然语言收尾把候选人晾住。

### 可恢复拒绝（模型按指令纠偏，不转人工）

`invite.invalid_city_scope`（用 expectedCity 重调）/ `invite.city_conflict` / `invite.city_unverified`（先确认城市）/ `invite.no_job_result`（先查岗）/ `invite.booking_in_progress`（先推进这单约面）/ `invite.already_invited`（据实回应"邀请已发过"）/ `invite.group_consent_required`（按 noMatchScript 征询或继续正常推荐）/ `invite.booking_not_success`。

所有失败场景共同底线：不向候选人提及群相关内容；**只有 `success: true` 才能用完成口径**声称群动作已发生。

---

## 工具定义

### invite_to_group

```typescript
{
  name: 'invite_to_group',

  inputSchema: {
    city: string      // 必填，候选人所在城市级名称（严禁区/县/商圈/门店地址）
    industry?: string // 强烈建议传：餐饮/零售；意向明确漏传会按"人数最少"兜底选群
  },

  // 成功
  output: {
    success: true
    alreadyInGroup?: boolean       // 已在群短路时为 true
    groupName: string
    groupPurpose: 'job_pool'       // 固定值：兼职岗位信息群，不是面试群
    city: string
    industry?: string
    inviteDelivery: 'direct_add' | 'invite_card'  // <40 直拉 / ≥40 或 -12 发邀请卡
    matchedIndustry?: string
    fallbackUsed?: boolean
    selectionReason?: 'lowest_member_count' | 'only_option'
    citySnapshot?: CitySnapshot    // { totalGroups, memberLimit, byIndustry[] }
    _outcome: string
    _replyInstruction: string      // 必须严格遵守的话术指令
  }

  // 失败（buildToolError 统一结构）
  output: {
    success: false
    errorType: string              // invite.* 错误码，见失败分档
    _outcome: string
    _replyInstruction: string
    details?: { expectedCity?, groupName?, citySnapshot?, noMatchScript?, ... }
  }
}
```

完整触发场景、前置条件、禁止项与话术口径以工具 DESCRIPTION（`invite-to-group.tool.ts`）为准，本文与其保持同步。

---

## 数据依赖

### 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `GROUP_TASK_TOKENS` | 小组级 token（群列表查询用，与群任务共用） | 是 |
| `STRIDE_ENTERPRISE_TOKEN` | 企业级 token（拉人/群成员/实时人数） | 是 |
| `GROUP_MEMBER_LIMIT` | 群人数上限阈值 | 否，默认 200 |

### 服务依赖

| 服务 | 用途 |
|------|------|
| `GroupResolverService` | 兼职群列表获取 & 标签解析（10 分钟缓存） |
| `GroupMembershipService` | 实时群成员关系（Redis Set `room:members:{roomWxid}`，TTL 10 分钟，与群列表缓存对齐） |
| `RoomService` | `addMemberEnterprise` 拉人 + `syncRoom` 群数据同步 |
| `SessionService` / `MemoryService` | 城市事实读取（gate）+ `invitedGroups` 会话记忆（会话层 TTL 2 天） |
| `OpsNotifierService` | 群满告警 / 接口拒绝告警 |
| `OpsEventsRecorderService` | `group.invited` 运营事件（幂等键按 turn+群，供日报统计） |

---

## 运维操作

### 新增群

1. 在托管平台创建群，打标签 [兼职群, 城市, 行业]
2. 等待 10 分钟缓存过期后系统自动识别（拉群主路径 forceRefresh，实际更快生效）

### 告警处置

| 告警 | 含义 | 动作 |
|------|------|------|
| 群满告警 | 某城市/行业候选群全满 | 创建新群（如"XX群②"）+ 打相同标签，系统自动开始分配 |
| 接口拒绝告警 | 候选群全部被企业接口拒绝（含 bot 群关系补偿失败明细） | 修 bot 群关系/排查托管平台，与扩群是两种不同动作 |

-8 非好友不告警（人工无可作为）；无群城市不告警（静默自然收口）。

### 监控

- 日志：`invite_to_group` 工具调用日志（含选群、重试、降卡明细）
- 运营事件：`ops_events` 的 `group.invited`（进日报）
- Redis：`room:members:*` 成员缓存状态

---

## 后续迭代

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P1 | 群内欢迎语 | 用户进群后自动发送欢迎消息 |
| P2 | 建群 API | 托管平台支持后，实现自动建群 |
| P2 | 多群类型支持 | 扩展到抢单群、店长群等场景 |
| P3 | 群活跃度路由 | 优先分配到活跃度高的群 |

> 旧条目"退群回调维护成员缓存"已删除：现行 10 分钟 TTL 实时成员缓存过期自愈，候选人退群后自然恢复可邀请状态，无需回调维护。
