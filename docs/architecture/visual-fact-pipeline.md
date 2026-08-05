# 图片信息链路架构（Visual Fact Pipeline）

> **现状架构文档**（描述已实现的系统，非方案）。实现于 [PR #885](https://github.com/huajune/cake-agent-runtime/pull/885)（基于 [#870](https://github.com/huajune/cake-agent-runtime/pull/870)），基准 `feat/visual-fact-structuring @ 8693ea3e`。
> 前身三份立项文档（产品方案 / 技术方案 / 链路盘点，2026-08-05）已由本文取代，全文保留在 git 历史与 PR #873 讨论中；本文附录 A 继承其中的**裁决记录**——那仍是字段白名单与提示词口径的唯一权威。

---

## 一、这条链路是什么

候选人发来的图片（岗位截图、地图定位、简历、健康证、聊天截图……）经 vision 识别后，以**两种形态**进入系统：

1. **描述文本**：`[图片消息] <自由文本描述>`，整条替换该消息在 `chat_messages.content` 中的正文——给主模型读（向后兼容，与结构化之前完全一致）；
2. **结构化 sheet**（`VisualFactSheet`）：与描述同源同时机产出，落在同一行的 `visual_facts` jsonb 列——给确定性消费者用。

结构化解决的核心问题是三个判据的缺失（badcase `vkikct39` P0：交换微信截图里**招募经理本人的微信号**被当候选人电话提交进真实报名）：

1. **这是什么图**（kind）
2. **图里的信息归谁**（ownership：候选人本人 / 发布方 / 第三方）
3. **可不可信**（截图上的岗位信息是"候选人看到的版本"，须以工具结果为准）

## 二、端到端架构

```
候选人发图（企微回调入站）
  │  enrichImagePayload：解析原图 artworkUrl 进 payload（P2 依赖）
  ▼
┌─ 生产侧（谁来看图）───────────────────────────────────────────┐
│ 主路径   P2：主模型（多模态）整轮看原图 + 调 save_image_description │
│          （executor 按输入换模型：有图自动跳过非多模态候选，          │
│            llm-executor `supportsVision` 逐台筛；入站预描述分支      │
│            已于 2026-08-05 废弃，净删 110 行）                      │
│ 兜底①   漏调兜底：回合结束核对 toolCalls，漏调即 P1 补描述          │
│ 兜底②   运行时兼容重跑：多模态调用失败（含全链纯文本极端配置）        │
│          → P1 现场描述转文字重跑（callAgentWithVisualCompatibility…）│
│ 兜底③   读时懒补写：回合入口补写本会话 7 天内裸 [图片消息] 占位       │
│          （治接管/非托管时段沉积，归因见 §六）                      │
│ 独立     自侧消息描述（经理发图唯一描述来源）、品牌补写（§10.3）      │
└──────────────────────────────────────────────────────────┘
  │  两种产物同次写入（updateMessageContent 扩参）：
  ▼
┌─ 存储（chat_messages 同一行）─────────────────────────────────┐
│ content:      "[图片消息] <rawDescription>"   ← C1 主模型窗口，不变  │
│ visual_facts: {kind, fields[], rawDescription} ← 确定性消费者       │
│ 缓存一致性：del 短期记忆 list → 下次 cache miss 从 DB 回填带出新列   │
└──────────────────────────────────────────────────────────┘
  │  读路径：getVisualFactsByChat 按「剥时间后缀内容」等值匹配
  │  （描述整条写入，窗口与库中逐字一致；免去窗口对象五层穿线）
  ▼
┌─ 消费侧（三通道模型）──────────────────────────────────────────┐
│ 通道① 查询参数（确定性）：brand/brand_id/store/candidate_address     │
│         → brandAliasList / brandIdList / searchJobName / geocode    │
│ 通道② 对话语境（仅主模型可见）：薪资文案/班次/门槛/流程状态          │
│         → prompt 口径：回答以 duliday_* 工具结果为准                │
│ 通道③ 候选人档案（唯一入口 ownership=candidate 的自陈材料字段）      │
│         → sessionFacts（置信度按消费规则赋予，见 §五）              │
└──────────────────────────────────────────────────────────┘
```

## 三、核心数据结构

`src/resolution/visual/`（与 brand/geo 同构的解析域：纯确定性、零 LLM、仅依赖 zod）：

```ts
VisualFactSheet {
  kind: 'job_posting' | 'map_location' | 'resume' | 'chat_screenshot' | 'certificate' | 'other',
  fields: [{ key, value, ownership: 'candidate'|'publisher'|'third_party'|'unknown' }],
  rawDescription: string,
}
```

- **key 白名单**（15 个，附录 A 裁决 A2/A7/B3'）：`phone / name / age_range / brand / brand_id / publisher / store / address / city / candidate_address / salary_text / shift_text / cert_type / cert_issue_date / other`。schema 层刻意收 `string` 不收 enum——**词表写在 describe 供模型看，白名单过滤在 finalize 做**（批测实证：严格 enum 会让一个坏 key 拖垮整张 sheet；删 enum 不给词表则模型全用中文自由 key，9/351 → 修后 212/212）。
- **归属默认**按 kind 补：`job_posting→publisher`（`candidate_address` 例外归 candidate——岗位页「我的地址」是候选人设备地址）；`resume/certificate/map_location→candidate`；`chat_screenshot→unknown`；`unknown 一律按第三方消费`。
- **finalize 语义**（`finalizeVisualFactSheet`）：解析失败/非法 kind → 降级 `{kind:'other', fields:[], degraded:true}` = 逐字回到纯文本现状；坏 key 字段丢弃不拖垮整表；**15/18 位身份证形态值确定性清洗**（模型无视"证件号不要写"指令的兜底，裁决 B3'）。
- **sheet 不带 vision 自评置信度**：置信度由消费规则按「字段 × 图类型」确定性赋予（模型自评不可信）。

## 四、生产者

| | P2（主路径） | P1 引擎（ImageDescriptionService） |
|---|---|---|
| 执行者 | 主模型（生产 `qwen3.7-plus`，多模态） | 专职 vision（`qwen3-vl-plus`） |
| 触发 | 本轮有图 → 工具动态注册，模型看原图后调用 | 四兜底：漏调 / 运行时降级 / 懒补写 / 自侧消息（+品牌补写） |
| 结构化 | 工具 inputSchema 的 `kind`/`fields`（可缺省，缺省降级 other） | `generateStructured`（描述+kind+fields），失败回退纯文本 `generate` |
| 简历判定 | sheet `resume` kind 与旧文本标记**双判并跑**（`legacyResume || sheetResume`，分歧 warn 落日志）——旧判据是零成本 OR 兜底，分歧归零后顺手清或永久保留（清债已从关键路径除名） | 同 |
| R2 发布方剔除 | `job_posting` sheet 只喂 `key=brand` 字段值进品牌解析；`publisher` 字段（跃橙云服等发布主体）不进 | — |

**入站预描述分支已废弃**（2026-08-05 用户裁定）：executor 按输入换模型后（有图逐台跳过非多模态候选），该分支唯一场景「全链纯文本」由运行时兼容重跑兜底。负向钉子测试防止无意识加回。

## 五、消费规则与置信闸

**三道闸**：进档前（ownership 门：`candidate` 才可进档案）→ 入档时（确定性赋值）→ 消费时（既有闸门原样兜底：booking/precheck 预填只吃 high、brand reducer 手打赢图片、展示出处门）。

**规则轨授权域**（`extractHighConfidenceFacts` 按消息 kind 分域，`resolveExtractionScope`）：

| 消息类别 | 身份域 | phone | 偏好域 | 地理域 |
|---|---|---|---|---|
| 手打文本 | ✅ | ✅ | ✅ | ✅ |
| `resume` / `certificate` sheet | ✅ | ❌（B3：LLM 轨 medium + 确认问答升级才可预填） | ✅ | ✅ |
| `map_location` sheet | ❌ | ❌ | ❌ | ✅ |
| `job_posting` / `chat_screenshot` / 其它 sheet | ❌ | ❌ | ❌（R1e：岗位卡薪资≠期望薪资） | ❌（门店城市≠候选人城市） |
| 视觉消息无 sheet（旧数据/降级） | ❌ | ❌ | ✅ | ✅（= PR #870 行为，不劣化地图定位） |

**LLM 轨配套门**（`session.service`）：phone 自陈出处门语料 = 手打 + 简历/证件 sheet 消息；explicit-upgrade 的 phone quote 只认手打文本；is_student/健康证话题证据门同语料收窄。

**R3 地理直通**：`map_location` 的城市字段经 geo 白名单确权后按 `source='tool'` 入档（与定位分享 A2 同级同让位规则）；invite 城市门新增 `turn_map_screenshot` 档（同轮 sheet 直供），同时**剔除视觉描述全文的城市推断**（badcase `x3pdj7qh` 拉错群根治点）。

**R4 提示词口径**（candidate-consultation.md）：截图岗位信息以工具结果为准；截图中发布方/招聘者的电话微信永远不是候选人的；截图里他人的姓名/电话/面试安排不得复述（裁决 D4：raw 保真不打码，防线在复述层）。

## 六、质量基线与缺失治理（2026-08-05 实测）

**准确率**（50 张近 7 天生产真图，三轮批测；真值 = 双模型共识 + 分歧逐张人工裁定）：

| 指标 | P2（主路径） | 说明 |
|---|---|---|
| kind 分类 | **92%**（46/50） | 判错 2 张均为无害类混淆（授权域相同，行为零差异）；真歧义 2 张 |
| field key 合法率 | **100%**（200/200） | 词表修复后两轮稳定 |
| **危险错向**（第三方图→resume/cert 且含身份字段） | **0/50** | 唯一会造成实际后果的错误维度 |

P1 兜底引擎同批：kind 判错≈2/50、产出 50/50。两模型准确率同档、错误方向互补（P2 偏"手机界面→chat"、P1 偏招聘先验）。

**描述缺失（曾 ~33%）归因与治理**：30 条裸占位实测，**27/30 是人工接管/非托管时段**经 MOBILE_PUSH 同步进历史的候选人图片——无回合则 P2/漏调兜底天然覆盖不到（部分会话当天有几十个回合，图片恰在接管间隙）；3/30 为 timeout 族。图片本身全部健康（14/14 URL 可达可识别）。治理 = 读时懒补写（`backfillBareDescriptionsForChat`：回合入口 fire-and-forget，每会话 5 分钟节流、单次 ≤3 张、同 id 去重、只补图片）。

## 七、运维与观测

- **tracer/日志信号**：`resume 判定分歧` warn（并跑对照）、`[懒补写] 裸图片描述补写触发`、`extraction_field_dropped`（reason 含 `phone_not_self_reported`/`digits_only_name`）
- **日报观测项**（发版后加入扫描 SKILL）：kind 分布、degraded 率、漏调率（漏调兜底 warn 计数）、懒补写触发数、裸占位存量曲线
- **回滚判据**：degraded 率异常高（生产 vision 表现与批测严重不符）或 kind 分布畸变；回滚 = 应用版本回滚，`visual_facts` 列只增不改语义，无数据回滚动作
- **推进节奏**（用户裁定）：T0 发版即全量（加法设计承担安全性，sheet 缺失=现状），观察项全部为监控非门槛；生产迁移 `20260805150000_add_chat_messages_visual_facts.sql` 与发版同窗口（测试库已推）

## 附录 A · 字段与口径裁决记录（唯一权威，2026-08-05）

> schema 字段白名单、归属规则、vision 提示词口径的一切改动须回到本表。裁决人：jiezhu。

### A.1 信息用途三通道

通道①查询参数（brand/brand_id/store/candidate_address+map 定位）→ 只影响"查什么"，错了工具结果当轮纠正；通道②对话语境（薪资文案/班次/门槛/流程状态/第三方对话）→ 主模型可见、不进参数不进档案；通道③候选人档案 → 唯一入口 ownership=candidate 的自陈材料字段。

### A.2 裁决终态表

| # | 信息 | 裁决 |
|---|---|---|
| A1 | 品牌/门店名 | 通道①+③（意向线索） |
| A2 | 品牌ID（我方截图自带 `[10006]`） | 通道①，直通 brandIdList |
| A3-A5 | 岗位薪资文案/年龄证件学历门槛/班次结算 | 通道②，禁入档案（`vkikct39` 同案 `age=18`/`pref.salary=6000` 实锤） |
| A6 | 发布方/招聘者信息（公司、经纪人名、资质） | 废弃：不进任何档案与解析（品牌劫持 + 经理微信号两案） |
| A7 | 岗位页「我的地址」/「距我 X km」 | 通道③位置证据（候选人设备真实地址） |
| B1/B2 | 简历全套 / 健康证有证+日期+范围 | 通道③ |
| B3 | 证件/简历上的手机号 | 通道③ + `confidence=medium` 锁定 + 确认问答升级后才可预填 |
| B3' | 身份证号/证件号 | 废弃：不设 key，finalize 按值形态清洗 |
| C1/C2 | 地图定位点 / 目标门店位置 | 通道③位置证据 / 通道①查询线索 |
| C3 | 地铁线路站点列表 | 仅展示（意图模糊不结构化） |
| D1/D2 | 交换微信展示的号码 / 招聘话术数字 | 废弃（D1 即本 P0 案：经理本人微信号） |
| D3 | 候选人在第三方平台的发言 | 仅展示，用前须当面确认 |
| D4 | 群聊截图里他人的 PII | raw 保真 + 零结构化 + prompt 防复述；**手机号不打码**（用户裁定） |
| E | 流程状态页（会议/面试结束/订单/审核） | kind 归 other，仅展示 |
| F | 噪音（助力码/自拍/好友页/假订单） | kind=other 零结构化；真伪鉴别非本链路目标 |

### A.3 架构级裁定

| 裁定 | 内容 |
|---|---|
| 入站预描述废弃 | 2026-08-05：主聊 99% 多模态 + executor 按输入换模型，分支徒增复杂度 |
| kind 标注前缀取消 | 改存储文本格式波及面大，R4 只走 prompt 口径 |
| T0 全量上线 | 加法设计承担安全性；shadow/观察期不设门槛，观察项均为监控 |
| 清债除名关键路径 | resume 旧文本判据是零成本 OR 兜底，顺手清或永久保留 |
| 置信度不由 vision 自评 | 由消费规则按字段×图类型确定性赋予 |

## 附录 B · 溯源

- 驱动 badcase：`vkikct39`（P0 经理微信号进报名）、发布方品牌劫持、`oaz6inzf`（地图已示北京仍问城市）、`x3pdj7qh`（拉错杭州群）、`umr69uqq`（截图岗位直判班次）
- 实现：PR #870（止血）→ PR #885（全链路 + 批测三修复 + 分支废弃 + 懒补写）；迁移 `20260805150000`
- 前身立项文档（产品方案/技术实施方案/链路盘点，均 2026-08-05）：见本仓库 git 历史 `docs/visual-fact-plan-20260805` 分支各提交，及 PR #873 讨论
