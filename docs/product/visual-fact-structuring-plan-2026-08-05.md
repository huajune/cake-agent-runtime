# 图片信息结构化专项方案（Visual Fact Structuring）

> 立项日期：2026-08-05 ｜ 状态：待评审
> 基准代码：`origin/develop @ 5a6ce7c3` ｜ 配套盘点：[docs/technical/visual-fact-pipeline-inventory-2026-08-05.md](../technical/visual-fact-pipeline-inventory-2026-08-05.md)
> 直接诱因：badcase `vkikct39`（P0，2026-08-04）——候选人转发的 BOSS 直聘截图被当成候选人自陈：交换微信截图里**招聘者（招募经理本人）的微信号**进了报名电话，岗位卡里「面试基本都过，**18岁以上**+健康证即可」被提成候选人年龄 18，随报名提交进真实工单，AI 面试短信发到了经理自己的手机上（运营原话「报名填我的电话干嘛」）。同案还把岗位卡「薪资5000-6000元/月」记成了候选人期望薪资 `pref.salary=6000元/月`。
>
> ⚠️ 事实修正（2026-08-05 复核）：早期版本写「18-40岁」，实际生产字符串是「18岁以上」——**这个差别是要害**：`extractAge` 既有的岗位范围守卫能拦「年龄要求18-40岁」（带触发词），拦不住「面试基本都过，18岁以上」（无触发词），后者才是真实穿透路径。

---

## 一、问题定义

### 1.1 一句话

vision 对候选人所发图片的描述被**拍平成一行自由文本、直接替换候选人消息正文**（`[图片消息] <描述>`），此后全链路 7 个消费点把它当候选人原话读——没有任何一处能回答三个判据：

1. **这是什么图**（岗位截图 / 地图定位 / 简历 / 聊天截图 / 证件 / 其他）
2. **图里的信息归谁**（候选人本人 / 第三方发布方）
3. **可不可信**（vision 渲染的文本 vs 需工具核实的岗位事实）

### 1.2 立项依据：故障重心已从「读不出」迁移到「用错了」

全表扫描 678 条 badcase，运营诉求或归因结论把「图」指为问题所在的共 **11 条 + 1 条已归档**（发布方品牌劫持）。按时间劈开是两个族：

| 族 | 时段 | 条数 | 现状 | 性质 |
|---|---|---|---|---|
| C 族 · vision 读不出/读错 | 05-13 ~ 07-14 | 7 | **6 条已解决** | 模型/提示词问题，修得掉 |
| **A 族 · 读对了但用错了** | **07-22 ~ 08-04** | **3**（+1 归档） | **0 条解决，含唯一 P0** | **消费层无结构可判，单点修不掉** |
| B 族 · 读出来了不用 | 08-04 | 1（`oaz6inzf`） | 处理中 | 类型缺失 + 消费入口缺失 |

A 族三条共享同一缺失判据（详见 §1.3），每条的局部补丁都互相不覆盖——`vkikct39` 的修复（PR #870）碰不到品牌轨和岗位事实轨；品牌域自己长出的来源标记（`BrandResolutionSource`）粒度不含「发布方 vs 意向」，品牌劫持照样发生。**这是结构性缺陷的典型形态：补丁数量在涨（现存 9 个，见盘点 §3），故障族却在换着消费点复发。**

按量它是小簇（近期 badcase 会话中有图的占 16.9%，对全量基线 13.9% 几乎无富集）——**立项理由不是量大，是单例伤害等级（P0：陌生人手机号进真实报名）+ 补丁模式已证明追不上**。

### 1.3 缺口 ↔ badcase 对照

| badcase | 失效消费点 | 缺的判据 |
|---|---|---|
| `vkikct39` **P0** 发布方手机号+年龄进真实报名 | C4 身份出处门（认整个 prompt 含图片描述）+ C2 规则轨 | 归谁的 |
| 发布方品牌劫持（07-22 归档，跃橙云服覆盖必胜客） | C5 品牌轨（有 `image_description` 标记但无发布方概念） | 归谁的 |
| `umr69uqq` P1 对截图岗位直判「班次不冲突」 | C1/C3（截图岗位被当可判断事实，绕过 `duliday_job_list`） | 可不可信 |
| `oaz6inzf` P1 地图上已是北京仍问城市 | C6 geo（描述里的城市没进定位入口；疑时序） | 这是什么图 |
| `x3pdj7qh` 识别完拉进杭州群 | C6 invite 城市门吃到描述里的城市 | 归谁的 + 这是什么图 |

三判据 × 7 消费点的能力矩阵**三行全空**（盘点 §4）。同时，两个局部先例证明这三个判据是刚需：

- 「这是什么图」已被发明过一次：简历图靠 `isResumeImageDescription` **硬编码**识别，且在两个生产者里各复制了一遍；
- 「归谁的」已被发明过一次：品牌域的 `BrandResolutionSource = 'user_text' | 'contact_name' | 'image_description'` + 来源门 + reducer 优先级——全仓唯一，且粒度不足。

本专项做的事就是：**把这两个已经各自长出来的东西收拢成一等公民，补上第三个判据，让 7 个消费点按同一份结构消费。**

---

## 二、目标与非目标

### 目标

1. vision 产出从自由文本升级为**带类型与归属的结构化对象**（VisualFactSheet），在生产出口一次定型；
2. 身份、地理、品牌三个高危消费域改按结构化判据消费，A 族三条 badcase 的机制性根除；
3. 归并现存的复制粘贴补丁（简历硬编码 ×2、PR #870 的文本前缀猜测），消费面收敛。

### 非目标

- **不做图片真伪鉴别**（`jtdpmy9x` 假订单图属反欺诈，另立）；
- **不改 vision 模型选型与识别质量**（C 族已基本收敛，不在本专项）；
- **不在投递路径新增 LLM 调用**（复用现有 vision 调用与主模型工具调用，只改输出契约——与「实时反馈循环行不通」裁定对齐）;
- **不重建已下线守卫**；`umr69uqq` 类「截图岗位可信度」先走 prompt 口径 + 观测，确定性守卫按兜底边界原则等 badcase 实证再立。

---

## 三、方案设计

### 3.1 核心数据结构

```ts
/** 单张视觉消息的结构化事实。与描述文本同源产出（同一次 vision/主模型调用）。 */
interface VisualFactSheet {
  /** 判据一：这是什么图 */
  kind:
    | 'job_posting'      // 招聘平台岗位截图/海报（BOSS直聘、独立客工单页…）
    | 'map_location'     // 地图/定位/门店位置截图
    | 'resume'           // 简历（拍照/手写/截图）——归并现有硬编码
    | 'chat_screenshot'  // 聊天记录截图（双方信息混合）
    | 'certificate'      // 健康证/学生证/身份证件类
    | 'other';           // 兜底：只出 rawDescription，行为等同现状
  /** 判据二：结构化字段，每个字段带归属 */
  fields: VisualFactField[];
  /** 原自由文本描述，照旧渲染进消息窗口（C1 兼容） */
  rawDescription: string;
}

interface VisualFactField {
  /** 收敛的字段名：phone / name / age_range / brand / brand_id / publisher / store /
   *  address / city / candidate_address / salary_text / shift_text / cert_type / cert_issue_date …
   *  - brand_id：我方平台截图自带品牌ID（如 [10006]），确定性锚点直通 brandIdList（裁决 A2）
   *  - candidate_address：岗位页「我的地址：XX街道」/「距我 X km」锚点——候选人设备上的
   *    真实地址，证据强度不低于定位分享，今天零消费（裁决 A7）
   *  - 刻意不设：身份证号/证件号——booking 用不到，纯隐私暴露面，vision 不转写为字段（裁决 B3） */
  key: string;
  value: string;
  /** 判据二：归谁的。kind 决定默认值，字段级可覆盖（聊天截图必须逐字段判） */
  ownership: 'candidate' | 'publisher' | 'third_party' | 'unknown';
}
```

**归属默认规则**（vision 提示词内置，字段级可覆盖）：`job_posting` → 全部 `publisher`（`candidate_address` 例外，归 `candidate`）；`resume` → 全部 `candidate`；`map_location` → 位置类字段 `candidate`（候选人用它指自己的位置）；`chat_screenshot` → 逐字段判，判不了给 `unknown`；`unknown` 一律按第三方处理（**宁可要求候选人重说一遍，不可把陌生人信息当自陈**——与 PR #870 的残余风险取向一致）。

**置信度规则（2026-08-05 裁决 B3）**：证件/简历图上的 `phone` 即使归属 `candidate`，入档一律压 `confidence=medium`——办证登记的号码可能是旧号/代办号。booking/precheck 预填只信 high，medium 须经**确认问答**（"电话就用 176···6584 这个吗？"）升级后才可预填；升级机制复用现有 `EXPLICIT_UPGRADE_FIELDS` + 确认问答裁决，零新造。

**判据三（可不可信）不进 schema，进消费规则**：`job_posting` 的薪资/班次/年龄字段天然是「候选人看到的版本」，走附录 A 的**通道②（语境信息）**——主模型可见、不进查询参数、不进档案，回答须以 `duliday_job_list` 当前结果为准（§3.4-R4）。

### 3.2 两个结构化点（对应两条生产路径）

| 路径 | 现状 | 改造 |
|---|---|---|
| P1 渠道预描述（`ImageDescriptionService`） | `generate`（自由文本）→ 拼前缀回写 | 换 `llm.generateStructured`（`llm-executor.service.ts:143` 已有，session 抽取在用）出 VisualFactSheet；`rawDescription` 照旧回写文本 |
| P2 Agent 工具（`save_image_description`） | 主模型看图后把自由文本填进 `description` 参数 | inputSchema 增加 `kind` 与 `fields`（可选），主模型看图时顺手结构化；工具内做校验与归属默认值补齐 |

两条路径共用同一个新域 **`src/resolution/visual/`**（schema 定义 + 归属默认规则 + 校验 + 文本渲染/解析），**顺手归并 F1/F2 简历硬编码的两份复制**——`resume` kind 就是 `isResumeImageDescription` 的正名。

**为什么放 `resolution/` 而不是渠道层**（2026-08-05 评审意见采纳）：

1. **多渠道前瞻**：未来接入企微之外的渠道时，图片事实的 schema、归属规则、渲染格式都必须一致，放 `channels/wecom/` 下等于宣布它是企微私有物；
2. **修掉一个现存分层违规**：今天 `src/tools/save-image-description.tool.ts` 就在 import `@channels/wecom/message/utils/message-parser.util` 的 `isResumeImageDescription`——tools 反向依赖渠道层。搬进 `resolution/visual/` 后该 import 转正；
3. **完全符合 `resolution/` 域的既有定义**：与 brand/geo 同构——纯确定性零 LLM、零出向依赖（vision 的 LLM 调用留在 channels/tools 调用方，`resolution/visual` 只持有 schema 与规则，正如 brand 域的 LLM 调用留在外面、matcher 纯确定性）；`channels → resolution` 的依赖方向已有先例（`image-brand-backfill.service.ts`）。

### 3.3 存储与传递：文本照旧 + 结构化旁路（复用品牌域先例）

**消息窗口文本完全不动**（`[图片消息] <rawDescription>`，简历附加行照旧）——C1 主模型、现有测试、历史数据全部向后兼容。唯一文本增强在 Phase 3：前缀升级为 `[图片消息·岗位截图]` 带 kind 标注。

结构化 sheet 走**旁路**，架构模板直接抄品牌域已走通的那套（§10.2/§10.3）：

| 品牌域已有 | 本专项泛化为 |
|---|---|
| `onImageBrandResolved(resolutions, {messageId})` 挂回合上下文 | `onVisualFactsResolved(sheet, {messageId})` |
| turn-finalizer 统一写入 | 同 |
| `applyLateImageResolutions`（描述晚到，渠道层重新持锁补写） | `applyLateVisualFacts` —— **`oaz6inzf` 的疑似时序缺口天然被这条路径兜住** |

#### 持久化：`chat_messages.visual_facts` jsonb 列

**它是什么**：图片/表情消息在 `chat_messages` 里本来就各占一行（vision 描述今天就是靠 `updateMessageContent` 回写进该行的 `content`）。本方案在同一行旁边加一个可空 jsonb 列，把结构化 sheet 与它的文本描述**存在同一行**：

```
chat_messages 某一行（仅图片/表情消息非空）
├── content:      "[图片消息] BOSS直聘岗位截图：…"   ← 现状，给 C1 主模型看，不动
└── visual_facts: {"kind":"job_posting","fields":[…]} ← 新增，给确定性消费者用
```

- **写路径**：与描述回写同一时机同一调用（`updateMessageContent` 扩一个可选参数），不新增写库次数；
- **读路径**：短期记忆加载 `chat_messages` 组窗口时顺带带出，消息窗口对象多一个字段——C2/C3/C4/C6 从对象上取 sheet，不再解析文本；
- **成本**：可空列在 Postgres 里是元数据级 DDL（瞬时，不重写表）；不回填历史（旧行为 NULL → 消费端视同 `kind=other`，行为等同现状）；不建索引（没有按 kind 检索的查询场景）。

**为什么必须落库，而不是只放内存/Redis**——比较过的三个替代：

| 替代方案 | 为什么不行 |
|---|---|
| 不存，每次从描述文本里再解析 | 这就是今天的病根：7 个消费点各自解析同一坨文本 |
| 只挂 Redis 消息窗口 | 窗口有 TTL、重启即失；事实抽取的增量窗口、复聊、测试回放都要跨轮重读消息——volatile 存储撑不住；且 Redis 唯一事实源 key 清单是事故审计项，刻意不扩 |
| 独立新表 `visual_facts(message_id, …)` | 多一次 join、多一套生命周期管理，换不到任何好处——sheet 与消息严格一对一，生命周期完全等同该行消息 |

Redis 消息窗口对象同步带该字段（`updateMessageContent` 现有的同步刷 Redis 机制顺带覆盖）——Redis 是缓存，库里是真相源。迁移走仓库红线：`IF NOT EXISTS` 幂等、测试库先行、生产 push 与代码发版同步、上线后真实写入验证。

### 3.4 消费规则（三判据落到 7 个消费点）

| 规则 | 消费点 | 内容 | 根除的 badcase |
|---|---|---|---|
| **R1 身份自陈判据** | C2 规则轨 / C3 LLM 轨 / C4 出处门 | 身份字段（`interview_info` + gender + is_student/education）只吃：手打文本 + `resume` kind 且 `ownership=candidate` 的字段。**替代 PR #870 的文本前缀猜测**——`visual-description.ts` 的判据从「前缀像不像图片」换成「sheet 说归谁」，该文件在 Phase 4 删除。**R1e 扩展（2026-08-05 实锤后新增）**：`ownership=publisher` 字段同样不得进 `preferences`——同案 `pref.salary` 被岗位卡「5000-6000元/月」写成候选人期望薪资；有归属判据后可安全收窄 preferences（不伤地图定位，那是 `map_location`+`candidate`），这正是 PR #870 靠文本猜测做不到的一刀 | `vkikct39`（phone/age/**salary**） |
| **R2 发布方剔除** | C5 品牌双轨 | `fields` 中 `key=publisher` 或 `ownership=publisher` 的公司名/品牌名**不进** `brandResolution.resolve`；意向品牌只取 `key=brand`（候选人看中的岗位品牌）。规则 hints 轨（现在无来源标记）一并接入 | 品牌劫持 |
| **R3 地图直通定位** | C6 geo / invite 城市门 | `map_location` 的 `city/address` 字段直接进 geocode 锚点链（`geocode-location-anchor` 已有消费口），与「定位分享城市证据化」（A2，`buildLocationShareCityFact`）同级证据；**`candidate_address`（岗位页「我的地址」）同级接入**（裁决 A7，样本实证今天零消费的位置金矿）；**`job_posting` 的门店地址不进候选人位置**，只作岗位查询线索 | `oaz6inzf`、`x3pdj7qh`、`yh5wgnnc` 族 |
| **R4 截图岗位需查证** | C1 提示词 | `job_posting` 的窗口文本带 kind 标注 + prompt 一条口径：「截图上的岗位信息是候选人看到的版本，薪资/班次/在招状态必须以 `duliday_job_list` 当前结果为准，不得直接确认或比对」。**先 prompt + 观测，不立守卫**（兜底边界原则：确定性档位须 badcase 实证） | `umr69uqq` |
| **R5 简历链路正名** | C7 | `resume` kind 替代 `isResumeImageDescription` 双份硬编码；`简历附件：URL` 行保留（下游 F3 正则不动） | —（清债） |

C2 的 4 个调用点（`session.service.ts:812/834`、`memory-lifecycle.service.ts:424`、`geocode-location-anchor.util.ts:106`）**在函数内部消费判据**，与 PR #870 同一落点，调用方零改动。

---

## 四、分期与工作量

> 每期独立可发版、可回滚。shadow 先行，观测跟上（「观测不能只打日志」裁定：结构化产出与消费命中都要可查）。

| 期 | 内容 | 量 | 出口判据 |
|---|---|---|---|
| **Phase 0 · 补盘** | 盘点 §6 的 5 项未验证问题：`awaitVision` 超时率（生产查询）、P1/P2 同轮相对时序与互覆盖、多图行为（`vkikct39` 即一轮 3 张）、表情消息是否进事实层、C1 对前缀的实际降权表现 | 0.5d | 结论回填本方案；若时序结论推翻 §3.3 旁路设计则先修订再动工 |
| **Phase 1 · 生产出口结构化（shadow）** | `src/resolution/visual/` 新域 + P1 `generateStructured` + P2 inputSchema + `visual_facts` 列迁移（测试库）+ 归并简历硬编码；**只落库不改任何消费行为**；每日扫描日报加一节：kind 分布 / 结构化成功率 / 归属分布 | 1.5-2d | 结构化成功率 ≥95%（失败降级 `kind=other` + rawDescription，行为等同现状）；`resume` kind 与旧硬编码判定一致率 100%（并跑对照） |
| **Phase 2 · 高危消费切换** | R1（身份）+ R3（地理）。R1 落地时 PR #870 的门保留但判据换源；`extraction_field_dropped` tracer 事件沿用（reason 细分 `ownership_publisher`） | 1.5d | badcase 复测：`vkikct39` / `oaz6inzf` / `x3pdj7qh` 策展 scenarioCase 全过；身份字段误杀率通过现有 13 例回归 + 新增地图/简历正例守住 |
| **Phase 3 · 品牌与提示词** | R2（发布方剔除，含 hints 轨接入来源）+ R4（kind 标注进窗口 + prompt 口径） | 1d | 品牌劫持场景 scenarioCase 过；`umr69uqq` 场景观测两周无复发（prompt 档，不设硬门槛） |
| **Phase 4 · 清债** | 删 `visual-description.ts` 前缀猜测（测试断言迁移到新判据）、删两处简历硬编码、盘点文档标注「已被 schema 取代」 | 0.5d | 全量回归绿；grep 无 `isResumeImageDescription` 残留 |

合计 ~5-6 人日。**排期前置条件：`#869` 发版先行**——两条守卫闸门与 08-04 修复批的边际收益高于本专项，且 Phase 2 的复测基线需要在新版本上建立。

---

## 五、风险与降级

| 风险 | 应对 |
|---|---|
| vision 结构化输出失败/schema 不合 | 降级 `kind=other` + rawDescription 原文——行为**逐字等同现状**，不新增故障面；失败率进日报 |
| kind 误分类：`map_location` 判成 `other` | 定位能力回到现状（手打城市兜底），**不劣化** |
| kind 误分类：`resume` 判成 `other` | 简历链路断——Phase 1/2 期间保留旧硬编码做双保险（并跑对照），Phase 4 确认一致率后才删 |
| `chat_screenshot` 归属误判（双方信息混合） | 默认 `unknown` → 按第三方处理；代价是候选人被要求重说一遍，可接受（同 PR #870 残余风险取向） |
| 多图同轮的 sheet 覆盖/合并 | Phase 0 先盘清现状再定合并规则，不带病开工 |
| 迁移与代码不同步发版 | 仓库既有红线：先测试库、生产 push 与发版同步、上线后真实写入验证 |

回滚：各 Phase 独立版本回滚即可；`visual_facts` 列只增不改语义，回滚代码后旧版本忽略该列，无数据回滚动作。

---

## 六、验收口径

1. **badcase 复测**：`vkikct39`、`oaz6inzf`、`x3pdj7qh`、品牌劫持 4 条策展进正式测试集（决策时刻锚点按 SOP），Phase 2/3 出口各自全过；`umr69uqq` 走生产观测（prompt 档）。
2. **回归不误伤**：PR #870 的 13 例全保留且过（其中「图片描述里的城市仍可定位」「简历图片号码仍提取」两条边界钉子直接换判据源复跑）。
3. **生产观测**（发版后两周窗口）：
   - `extraction_field_dropped` 中 `ownership_publisher` 类命中数 > 0（门真的在拦）且逐周收敛（模型侧也在学）；
   - 品牌 `publisher` 剔除命中数落库可查；
   - 身份字段「来自图片描述」的写入数归零；
   - kind 分布稳定、结构化成功率 ≥95% 持续。
4. **清债确认**：Phase 4 后全仓 grep 无 `isResumeImageDescription`、无 `visual-description.ts`。

---

## 七、与既往裁定的对齐清单

| 裁定/红线 | 本方案的对齐方式 |
|---|---|
| 实时反馈循环行不通（快环只准确定性动作） | 不新增 LLM 调用；结构化复用现有 vision/主模型调用；消费端全是确定性判据 |
| 兜底边界原则（确定性档位须 badcase 实证 + 给模型退出口） | R4 先 prompt 不立守卫；R1/R2/R3 各自有实证 badcase 锚定；降级路径全部回到现状行为 |
| 观测不能只打日志 | shadow 期落库 + 日报专节；消费命中走 tracer 事件 |
| 7-10 守卫下线裁定 | 不新增出站硬规则，全部改造在抽取/解析层 |
| 类型单一收拢不散 | VisualFactSheet 单点定义；品牌域 `BrandResolutionSource` 保留不动（它是品牌解析的内部来源枚举，与消息级 sheet 正交） |
| 迁移先测试后生产、与发版同步 | §3.3 / §5 已列 |

---

## 附录 A · 图片信息类别与裁决记录（2026-08-05）

> 依据：生产抽样 60 条候选人侧图片消息（2026-08-01 ~ 08-05 12:00，`chat_messages`）。
> 其中 **20 条为裸 `[图片消息]` 占位（描述缺失率 ~33%）**——Phase 0 补盘项之一已由此获得首个实测量级。
> 裁决人：jiezhu ｜ 本附录是 §3.1 字段白名单与 vision 提示词口径的唯一依据，改动须回到这里。

### A.1 有效描述的图片类型分布（40 条）

| 类型 | 占比 | 典型 |
|---|---|---|
| 岗位类（BOSS 岗位卡 / 本平台找工作页 / 海报 / 岗位详情） | ~38% | 达美乐岗位卡、必胜客列表页 |
| BOSS/微信聊天截图（含交换微信页） | ~15% | 交换微信号、招聘话术问答 |
| 地图 / 导航 / 地铁线路 | ~13% | 高德门店位、通勤路线、7号线站点 |
| 证件与自陈材料（健康证 / 简历） | ~8% | 健康证含姓名证号手机号 |
| 流程状态（AI 面试页 / 会议等候 / 排班日历 / 承揽页） | ~10% | 「本场面试已结束」 |
| 无关噪音（助力码 / 好友资料页 / 自拍） | ~10% | 拼多多助力码 |
| 其他（面试安排群聊 / 考勤发薪截图） | ~8% | 群聊含他人面试安排 |

### A.2 信息用途三通道（消费模型）

```
通道① 进查询参数（确定性，仅四类字段够格）
    brand / brand_id / store / candidate_address(含 map_location 的定位点)
    → brandAliasList / brandIdList / searchJobName / geocode location
通道② 进对话语境（主模型可见；不进参数、不进档案）
    薪资文案、班次、年龄门槛、工作内容、第三方对话内容、流程状态
    → 配 prompt 口径：回答前调工具，数字以工具结果为准
通道③ 进候选人档案（唯一入口：ownership=candidate 的自陈材料字段）
    简历/健康证字段（phone 压 medium + 确认升级）、candidate_address、map_location 定位
```

### A.3 裁决终态表

| # | 信息 | 裁决 | 备注 |
|---|---|---|---|
| A1 | 品牌/门店名 | 通道①+③（意向线索） | 现状品牌轨保留 |
| A2 | **品牌ID（我方截图自带）** | **通道①** | 绕过别名匹配全部歧义，白捡 |
| A3 | 岗位薪资类文案 | **通道②** | 禁入 `pref.salary`（本案实锤污染） |
| A4 | 岗位年龄/证件/学历门槛 | **通道②** | 禁入身份档案（本案实锤 `age=18`） |
| A5 | 班次/结算周期 | **通道②** | R4 prompt：以 job_list 为准 |
| A6 | 发布方/招聘者信息（公司、经纪人名、资质） | **废弃** | 不进任何档案与解析（品牌劫持 + 本案经理微信号） |
| A7 | **「我的地址」/「距我 X km」** | **通道③（位置证据）** | 候选人设备真实地址，今天零消费 |
| A8 | 工作内容/福利文案 | 通道② | — |
| B1 | 简历全套字段 | 通道③ | 现状正名（`resume` kind） |
| B2 | 健康证：有证/发证日期/从业范围 | **通道③** | 直接补齐收资字段，少问一轮 |
| B3 | 证件上的手机号 | **通道③ + `confidence=medium` + 确认升级** | 用户裁定：可当自陈但非高置信 |
| B3' | 证件号（身份证号） | **废弃（不设 key）** | booking 用不到，纯暴露面 |
| C1 | 地图定位点/导航起点 | 通道③（位置证据） | `oaz6inzf` 根除点 |
| C2 | 目标门店位置 | 通道①（查询线索） | — |
| C3 | 地铁线路站点列表 | **仅展示（通道②）** | 意图模糊，不结构化 |
| D1 | 交换微信展示的号码 | **废弃** | 本案 P0：经理本人微信号 |
| D2 | 招聘者营销话术数字 | **废弃**（语境里可见但零结构化） | 「18岁以上」「13.8元/时」 |
| D3 | 候选人在第三方平台的发言 | **仅展示（通道②）** | 真实意愿信号但出处弱，用前须当面确认 |
| D4 | 群聊截图里**他人**的 PII | **raw 保真 + 零结构化 + prompt 防复述** | 用户裁定：不丢信息、不打码（含手机号）；加一条口径「截图中他人的姓名/电话/面试安排不得向当前候选人复述」，不加硬规则 |
| E1/E2 | 流程状态/排班考勤 | 仅展示（通道②） | — |
| F | 噪音（助力码/自拍/好友页/假订单） | `kind=other`，零结构化 | 真伪鉴别不做（既有非目标） |

### A.4 本次裁决对正文的改动落点

- §3.1：fields 增 `brand_id` / `candidate_address` / `cert_issue_date`，证件号明确不设 key；新增置信度规则（B3）
- §3.4-R1：新增 R1e（publisher 字段禁入 preferences——`pref.salary` 实锤）
- §3.4-R3：`candidate_address` 接入定位证据链（A7）
- §3.4-R4：口径增补「截图中他人 PII 不得复述」（D4）
- Phase 0：描述缺失率已有 33% 首测值，该项优先级上调
