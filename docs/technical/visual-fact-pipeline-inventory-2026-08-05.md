# 图片事实提取 · 现状盘点清单

> 基准：`origin/develop` @ `5a6ce7c3`（2026-08-05）。所有行号经实际核对。
> 口径：只盘「候选人发图 → 描述进入会话 → 被当事实消费」这一条链路。

---

## 0. 一句话现状

vision 描述被**拍平成一行文本、写回候选人消息内容**，此后 **7 个消费点**各自把它当普通用户原话读，
没有任何一个消费点能回答「这是什么图 / 图里的信息归谁 / 可不可信」。
唯一的例外是简历图片和品牌域——它们各自用**硬编码**和**来源枚举**做了局部补救，
这两处正好证明这三个判据是刚需。

---

## 1. 生产侧：2 条路径，1 种格式

| # | 路径 | 触发 | 写入点 | 格式 |
|---|---|---|---|---|
| P1 | `ImageDescriptionService`（渠道层预描述） | 入站即 fire-and-forget 异步跑 vision | `image-description.service.ts:274` → `updateMessageContent` | `image-description.service.ts:22-23` |
| P2 | `save_image_description` 工具（Agent 主动调） | 本轮有图/表情时动态注册（`tool-registry.service.ts:291`） | `save-image-description.tool.ts:85` → `updateMessageContent` | `save-image-description.tool.ts:49` |

**两条路径产出完全相同的扁平格式**：

```
[图片消息] <vision 自由文本描述>
[表情消息] <vision 自由文本描述>
```

简历图片额外追加一行 `简历附件：<URL>`。**没有第三种结构。**

写入目标是 `chat_messages.content` —— 即**直接替换掉候选人那条消息的正文**。
`updateMessageContent` 同步刷 Redis（`memory/README.md:85`），避免窗口脏读。

### 1.1 时序

P1 是异步的，靠两处 `awaitVision` 兜底：
- `reply-workflow.service.ts:1080`（主链，带 `VISION_AWAIT_TIMEOUT_MS`）
- `accept-inbound-message.service.ts:437`（入站，30s）

⚠️ **超时后果未盘**：等不到就带着裸 `[图片消息]` 占位往下走。
badcase `oaz6inzf`（图上已是北京仍问城市）的归因方向就指这里，**尚未坐实**。

---

## 2. 消费侧：7 个消费点

| # | 消费点 | 代码位置 | 读到的是什么 | 能否区分图片/手打 |
|---|---|---|---|---|
| C1 | **主 Agent 提示词窗口** | `preparation.service.ts:203` `memory.shortTerm.messageWindow` | 完整消息文本 | ⚠️ 只能靠模型自己看前缀 |
| C2 | **规则抽取轨** | `high-confidence-facts.ts` `extractHighConfidenceFacts()` | 用户消息数组 | ❌ 否 |
| C3 | **LLM 抽取轨** | `session.service.ts` `callLLM()` prompt | 消息窗口 + 已确认事实 + 图片描述 | ❌ 否 |
| C4 | **身份出处门** | `placeholder-identity.ts` `assertExtractionIdentityProvenance(output, promptText)` | **整个提取 prompt**（含图片描述） | ❌ 否 —— **这就是 vkikct39 的放行点** |
| C5 | **品牌解析** | 双轨（见下） | 描述文本 | ✅ **部分是**（唯一带来源标记的） |
| C6 | **geo / invite 城市门** | `invite-city-gate.ts:86` `scanGeoSignalsFromText(text)` | 用户文本（含描述） | ❌ 否 |
| C7 | **简历链路** | `high-confidence-facts.ts:1267` 抓 `简历附件：URL` → `upload_resume` → precheck → booking | 描述里的标注行 | ✅ **靠硬编码字符串** |

### 2.1 C2 有 4 个调用点（同一函数，四处消费）

| 调用点 | 语料 |
|---|---|
| `session.service.ts:834` | `userMessages`（会话段全部用户消息） |
| `session.service.ts:812` | `[lastUserText]`（本轮） |
| `memory-lifecycle.service.ts:424` | `[trimmed]` |
| `geocode-location-anchor.util.ts:106` | `[text]` |

**一处收窄不覆盖另外三处** —— 我今天的补丁改的是函数内部，所以四处都吃到了；
但任何在调用方做的过滤都会漏。

### 2.2 C5 品牌解析是双轨的

| 轨 | 位置 | 有无来源标记 |
|---|---|---|
| 工具直连轨 | `save-image-description.tool.ts:90` → `brandResolution.resolve(description, 'image_description')` | ✅ **有** |
| 规则 hints 轨 | `high-confidence-facts.ts` `detectBrandAliasHints(normalizedMessages)` | ❌ 无 |

---

## 3. 现有补丁清单（散落的局部补救）

| # | 补丁 | 位置 | 治什么 | 覆盖范围 |
|---|---|---|---|---|
| F1 | **简历图片识别**（硬编码） | `message-parser.util.ts:30` `isResumeImageDescription` | 让简历图走报名链路 | **两个生产者各写一遍**（`image-description.service.ts:246` + `save-image-description.tool.ts:79`） |
| F2 | `stripResumeAttachmentLines` | `message-parser.util.ts:42` | 单条简历消息出现两条相同「简历附件」行（badcase `6a2fac72`） | 同上两处 |
| F3 | 简历附件只认 URL | `high-confidence-facts.ts:1264-1267` | 候选人回填模板时把别的内容连在该行后面，脏值进 booking | C2 |
| F4 | **品牌来源枚举** | `brand-resolution.types.ts:12` `BrandResolutionSource = 'user_text' \| 'contact_name' \| 'image_description'` | 让品牌域知道线索出处 | C5 工具轨 |
| F5 | 品牌来源门 | `brand-matcher.ts:301` `if (params.source !== 'user_text') return false` | 昵称自介类识别只对手打文本生效 | C5 工具轨 |
| F6 | 品牌来源优先级 | `brand-state.reducer.ts:21` `POSITIVE_SOURCE_ORDER = ['image_description','user_text']`（文字后应用即文字赢） | 手打意向优先于图片意向 | C5 工具轨 |
| F7 | `awaitVision` 时序等待 | `reply-workflow.service.ts:1080` / `accept-inbound-message.service.ts:437` | 描述晚到导致 Agent 只看到占位符 | 主链 + 入站 |
| F8 | **`visual-description.ts`**（今天新加，PR #870，**未合并**） | `src/memory/facts/visual-description.ts` | 图片描述不作为身份字段来源 | C2（`interview_info` 组 + gender + is_student/education）、C3/C4 的 phone 与 name |
| F9 | `stripQuotedBlocks`（同族取向，非图片） | `high-confidence-facts.ts:134` | 引用块里的第三方内容不当自陈 | C2 |

**F1/F2 在两个生产者里各写一遍** —— 说明「图片类型」这个概念已经存在，只是以复制粘贴的形式存在。
**F4/F5/F6 是全仓唯一的来源标记体系** —— 说明「归谁的」这个判据已经被品牌域独立发明过一次。

---

## 4. 能力矩阵：三个判据 × 7 个消费点

| | C1 主 Agent | C2 规则轨 | C3 LLM 轨 | C4 出处门 | C5 品牌 | C6 geo/invite | C7 简历 |
|---|---|---|---|---|---|---|---|
| **这是什么图**（岗位截图/地图/简历/聊天截图/证件） | ⚠️ 靠模型看 | ❌ | ⚠️ 靠模型看 | ❌ | ❌ | ❌ | ✅ 仅"是不是简历"（F1 硬编码） |
| **归谁的**（候选人 / 第三方发布方） | ❌ | ❌ | ❌ | ❌ | ⚠️ 仅"来自图片"，**不含发布方 vs 意向** | ❌ | — |
| **可不可信**（vision 渲染文本 vs 工具事实） | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — |

**三行全是空的。** 这就是 A 族三条 badcase 的共同根因。

---

## 5. 缺口 ↔ badcase 对照

| badcase | 状态 | 失效消费点 | 缺的判据 |
|---|---|---|---|
| `vkikct39` **P0** 经理本人微信号+年龄进真实报名 | 处理中（PR #870） | **C4**（出处门认整个 prompt 含描述）+ C2（`extractAge` 吃「18岁以上」——无「要求」触发词，穿透既有范围守卫；同案 `pref.salary` 也被岗位卡「5000-6000元/月」污染） | 归谁的 |
| 发布方品牌劫持（07-22，已归档） | 已归档 | **C5**（有 `image_description` 标记，但标记不含"发布方字段"概念） | 归谁的 |
| `umr69uqq` **P1 待分析** 对截图岗位判"班次不冲突" | 待分析 | **C1/C3**（截图岗位被当可判断的事实，绕过 `duliday_job_list`） | 可不可信 |
| `oaz6inzf` **P1** 地图上已是北京仍问城市 | 处理中 | **C6 / F7**（描述里有城市但没进定位入口；疑时序） | 这是什么图 |
| `x3pdj7qh` 识别完拉进杭州群 | 处理中 | **C6**（`inferCitiesFromGeoSignals` 吃到描述里的城市） | 归谁的 + 这是什么图 |
| `jtdpmy9x` 假订单图片未识别 | 处理中 | vision 层 | 这是什么图（+ 真伪，超出本盘点） |

---

## 6. 待补盘（本次未查证，不要当结论用）

1. **`awaitVision` 超时率 / 描述缺失率**：~~未查生产~~ → **已有首个实测数据点（2026-08-05）**：抽样 08-01~08-05 候选人侧图片消息 60 条，**20 条是裸 `[图片消息]` 占位（缺失率 ~33%）**。缺失是超时、漏调 `save_image_description` 还是回写失败，仍需下钻；但量级已确认，Phase 0 该项优先级上调——描述缺失时结构化整体落空。
2. **P1 vs P2 谁先谁后**：两条生产路径在同一轮的相对时序与互相覆盖行为，未读透。
3. **C1 主 Agent 的实际表现**：模型看到 `[图片消息]` 前缀后是否自发降权，未做实验。
4. **表情消息**：`[表情消息]` 走完全相同的链路，是否也进事实层，未单独盘。
5. **多图**：一轮多张图（`vkikct39` 是 3 张）的描述合并/覆盖行为，未验证。
