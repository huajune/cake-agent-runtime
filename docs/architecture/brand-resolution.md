# 品牌解析域架构（brand resolution）

**最后更新**：2026-08-12
**代码居所**：`src/resolution/brand/`（纯确定性，零 LLM 调用）+ `src/resolution/evidence/brand-policy.ts`（状态迁移策略行）

> 本文描述已实现的系统。品牌状态的**入档裁决**共用候选人档案域的证据底盘，域宪法见
> [candidate-profile-domain.md](./candidate-profile-domain.md)；品牌是候选人信息的一种，与姓名/城市平级。

---

## 1. 域边界

品牌的**归一化、识别、标准化、极性、品类展开、同音回指、公司名规范化**只允许存在于 `resolution/brand`。任何模块不得再私有实现 normalize 或 includes 匹配——历史上这套逻辑散在七处（memory 的 `normalizeForBrandMatch`、tools 的 `normalizeKeyword`、guardrail 的 `normalizeClaimedBrand` 三套规则各自演化），是「同一品牌名多处判断结果不一致」的结构性原因。

职责切分：**memory 管存储与锁，tools 管消费与查询，guardrail 管对账，三者只 import**。

```text
Sponge 品牌目录
        ↓
resolution/brand  ←── 零出向依赖（不反向依赖 SessionService / 工具 / Prompt / Redis / Guardrail）
        ↓
memory / agent preparation / tools / guardrail
```

### 1.1 文件布局

```text
src/resolution/brand/
├── brand-resolution.types.ts   # 类型契约（来源/匹配方式/极性/结果/queryMeta）
├── brand-resolution.service.ts # DI 门面（注入 SpongeService，薄封装，无业务逻辑）
├── brand-resolution.module.ts
├── brand-normalize.ts          # 全库唯一归一化实现 + 降噪词表
├── catalog-index.ts            # 目录索引构建 + 脏别名加固三规则
├── brand-matcher.ts            # 匹配主体 + 置信度档位
├── category-expansion.ts       # 品类词展开
├── polarity-rules.ts           # 极性确定性规则轨（模式清单集中一处）
├── llm-intent-guards.ts        # LLM 极性轨的确定性输入闸（见 §5.1）
├── fuzzy-recall.ts             # 0 结果同音回指（独立管线，不被 resolve() 调用）
└── sanitize-brand-name.ts      # 对外公司名规范化「独立日」→「独立客」
```

核心解析逻辑是**纯函数导出**（`resolveBrands(text, source, catalog)`），Service 只做「取目录 → 调纯函数 → 返回」，单测不需要 NestJS 容器。`fuzzy-recall.ts` 与解析主链路物理分居——目录结构上就能看出「解析」与「查询失败补救」是两条链路。

---

## 2. 端到端链路

一轮回合中品牌信息的流转有**两个时间锚点**：回合准备解析文字类来源，turn-finalizer 解析图片来源并统一写状态。**品牌状态一轮只在收尾写一次。**

```text
【接入】channels/wecom
  文本消息 ──────────────→ 存历史
  图片消息 ─┬ 主模型多模态 → 存历史(带类型标识)，不转写
            └ 不支持vision → 独立Vision预转写，描述落历史
  Debounce 静默窗口合并成一轮
        ↓
【回合准备】preparation / memory.onTurnStart          ← 锚点一
  resolve(用户文字, 'user_text')     规则轨定极性，目录匹配定实体
  resolve(昵称, 'contact_name')      目录验证；brand_state 不存在时
                                     seed 为 currentBrand（仅一次，见 §7.3）
  读 SessionBrandState → Prompt Section 注入品牌状态
        ↓
【主 Agent 回合】generator
  看文字 + 原图(多模态) + 品牌状态提示
  调 save_image_description → 描述回写（含「品牌ID：10239」）
    └ execute 内同步 resolve(描述) → 图片品牌挂回合上下文（§8.2）
  调 duliday_job_list → 传 brandIdList/brandAliasList
        ↓
【工具入口】tools（§6.2）
  入口标准化：别名→标准品牌→优先ID；未验证/歧义/低置信 → rejected
  brandFilterMode 只描述查询形态（§6.1）
  查询执行；口误 0 结果 → fuzzy-recall 回指建议（§6.3）
  产出 queryMeta（filterMode + brandSource）
        ↓
【出站守卫】guardrail（§9）
  硬规则 + 语义档只读 queryMeta 对账
        ↓
【turn-finalizer / memory.onTurnEnd】统一副作用出口    ← 锚点二
  extract_facts（LLM 轨）  极性判断 + 指代链接，品牌名回目录验证
  复用回合上下文中的图片品牌解析结果  缺描述→异步补写（§8.3）
  汇总本轮全部结果 → brand-policy 批量应用（先 positive 后 negative）
  → 持租约锁写 facts hash 单字段 brand_state（§7.2）
        ↓
【观测】brand_state_change（状态变化时才落，§10）
```

### 2.1 四条贯穿性规则

1. **实体裁定只有一处**：`resolve()` 的目录验证。四个 LLM 触点产出的只是候选文本 / 极性 / 参数。
2. **状态写入只有一扇门**：turn-finalizer 里的策略行应用。准备阶段、工具、守卫全部只读。
3. **当轮行为与跨轮状态解耦**：当轮查什么靠主 Agent 判断 + 入口标准化 + 会话品牌兜底，不等图片解析；图片品牌进状态服务的是下一轮。
4. **审计一条线**：三类事件同 `trace_id` 落库，任何品牌行为可回答「从哪来、为什么命中、最后用了什么」。

---

## 3. 解析契约

### 3.1 来源

```ts
export type BrandResolutionSource = 'user_text' | 'contact_name' | 'image_description';
```

会话记忆是结构化状态，不属于原始解析来源；模型工具参数也不是用户事实来源，二者都不入该类型。

**`contact_name` 的真实语义**是候选人的**微信昵称**（项目内没有运营维护的 `contact_remark` 字段）。部分候选人在加好友时自己把昵称改写为「昵称 + 品牌/门店」（如「小王 肯德基五角场」）——品牌是候选人本人写上去的。因此昵称唯一命中品牌库时是强线索，未命中时只是普通昵称、不得推断为品牌。

**`image_description`** 统一命名（不叫 `image_ocr`，因为现有能力不止字符 OCR，也含视觉理解）。招聘截图里识别出的品牌就是候选人的正向意向。

### 3.2 匹配方式

分类轴是**证据形态**，因为证据形态决定误判时的修法——修法不同的档位不合并。

| 匹配方式 | 含义 | 例子 | 误判修法 |
| --- | --- | --- | --- |
| `brand_id` | 文本中直接出现品牌 ID | 图片描述中的「品牌ID：10239」 | 格式契约 |
| `canonical_exact` | 归一化后与标准名完全相等 | 「肯德基」→ 肯德基 | 清理品牌库数据 |
| `alias_exact` | 归一化后与唯一别名完全相等 | 「KFC」→ 肯德基 | 清理品牌库数据 |
| `alias_containment` | 安全长别名以子串形式出现在整句中 | 「我要瑞幸咖啡的兼职」 | 收紧长别名白名单 |
| `category_expansion` | 品类词展开为品类下一组品牌 | 「咖啡」→ 品类内每个品牌一条 | 调品类词典 |

**长短别名匹配规则不同**：「瑞幸咖啡」这类长名出现在句中即命中（几个字连在一起基本不可能巧合）；「全家」这类短名（同时是日常词）必须是候选人独立说出的词才算命中——说「想去全家」算，说「我们全家都可以」不算。

**查不到就不猜**：品牌库里对不上的词一律不当品牌，不做「长得像」「读音像」的猜测。解析结果会被系统当事实使用（写记忆、决定查哪些岗位、被守卫对账），事实必须能指着品牌库说「就是这一条」。

**`category_expansion` 的边界**：仅当文本命中品类词且**未命中任何具体品牌**时触发；输出仅作当轮查询扩展，**不写入会话主品牌、也不解除排斥**（「咖啡」没有点名瑞幸，谈不上赦免「不要瑞幸」）；展开出的查询列表须**先减去会话 `excludedBrands`**。`contact_name` 不做品类展开。

### 3.3 意图极性

```ts
export type BrandIntentPolarity = 'positive' | 'negative' | 'browse_all';
```

| 用户表达 | 极性 |
| --- | --- |
| 「我想去肯德基」/「肯德基还招吗」/「你刚才说的肯德基」 | `positive` |
| 「不要肯德基」 | `negative` |
| 「换个品牌」 | `negative`（品牌为空，指向当前主品牌） |
| 「品牌不限」 | `browse_all` |

**默认极性是 `positive`**（业务裁定）：候选人在求职对话里主动提到一个品牌就视为兴趣信号——不感兴趣不会提。**不设中性的「仅提及」档位**，也不做 6 值细分（「换个品牌」语义上就是排斥当前主品牌；「还招吗」在招聘场景就是意向表达）。

防误判不靠中性档，靠三道闸门：

1. 匹配层的短别名 / 上下文门槛（§4.3）拦截「我们全家都可以」类假命中，走不到极性判断；
2. 显式否定规则优先，「不要肯德基」不会落成正向；
3. 状态机是**替换式更新**而非永久并集——单次误判的影响从「永久」降为「一轮」。

### 3.4 结果结构与服务接口

```ts
export interface BrandResolution {
  canonicalName: string | null;
  brandId: number | null;
  matchedText: string | null;
  source: BrandResolutionSource;
  matchType: BrandMatchType | null;
  intentPolarity: BrandIntentPolarity;
  /** 规则评分，不代表统计概率 */
  confidence: number;
  ambiguous: boolean;
  candidates?: BrandCandidate[];
}

async resolve(text: string, source: BrandResolutionSource): Promise<BrandResolution[]>;
```

- 未命中品牌也未命中品牌控制意图时返回**空数组**；
- `browse_all` 与品牌为空的 `negative` 可以没有具体品牌；
- 别名对应多个品牌时 `ambiguous=true`，候选项放入 `candidates`，标准名与 ID 留空；
- 一句话可返回多个结果（「肯德基不要，麦当劳可以」）。

品牌目录经 `SpongeService.fetchBrandList()` 获取（自带缓存），目录索引按 `brandData` 引用 memoize（30 分钟缓存期内零重建）。服务**不持有任何会话数据**。

---

## 4. 匹配规则

### 4.1 归一化契约

全半角统一必须以 **NFKC 折叠**实现在白名单过滤**之前**：

```text
normalize('NFKC') → lowerCase → 剔除非 [a-z0-9一-龥]
```

⚠️ 顺序不可颠倒。遗漏折叠步骤会让全角字符（「６姐」的「６」）被白名单直接删除、别名塌缩成单字词形——这是 2026-07-16「姐」批量误命中 P0 事故的成因。清洗只为对比用，展示给人看的 `matchedText` 保留原文。

### 4.2 匹配优先级

```text
品牌 ID > 标准品牌名精确命中 > 唯一别名精确命中 > 安全的长别名包含命中
```

同一文本命中标准名和其别名时只返回一个标准化品牌结果。

### 4.3 脏别名免疫（目录加固三规则）

**品牌库别名由运营维护、质量不可假设**——全角、单字、纯数字、业态泛词四类脏别名实测并存。解析层必须对脏数据免疫，而不是依赖目录治理：

- **非标准名别名归一化后 <2 字符整体剔除**——品牌库实存 17 个单字别名（报 / 捞 / 红 / 匠 / … 含全角塌缩产物），单字词形在中文对话里是纯噪音源。品牌标准名本身不受限，单字品牌仍可整句全等命中；
- **纯数字别名禁无边界子串包含**——ID 型别名嵌在手机号 / 时间串里必然巧合命中。带边界的短词包含要求 ≥3 位（「711」保留、「71」不再命中「玫瑰街71号」）；
- **业态泛词入 `BRAND_GENERIC_ALIAS_BLOCKLIST`**（如 7-11 的别名「便利店」），降级为仅全等匹配。

回归集：`tests/resolution/brand/catalog-hardening.spec.ts`。必须覆盖的误判案例：

```text
「我们全家都可以」   不能命中「全家」
「给我来一份工作」   不能命中「来伊份」
「我报过名了」       不能因短别名命中品牌
```

### 4.4 置信度档位

`confidence` 是可解释的规则评分，**不宣称为统计概率**。

| 匹配结果 | 评分 |
| --- | ---: |
| 品牌 ID 命中 | 1.0 |
| 标准名唯一精确命中 | 0.95 |
| 唯一别名精确命中 | 0.90 |
| 安全长别名包含命中 | 0.75 |
| 品类展开 | 0.75 |
| 冲突或上下文不足 | ≤ 0.40 |

**工具可执行阈值**：`>= 0.75` 的无歧义结果才可形成品牌过滤条件，`<= 0.40` 一律进 rejected。档位设计上不产生 (0.40, 0.75) 区间的值——**阈值即二分，不存在灰区行为**。

来源不做统一降权：`contact_name` 经品牌库唯一验证后同样是高置信线索。

---

## 5. LLM 触点全景

品牌链路共有四个 LLM 触点。`resolution/brand` 自身零 LLM 调用，是全部触点共同的确定性裁定关口。

| 触点 | 居所 | 时机 | 允许决定 | 禁止决定 | 失效兜底 |
| --- | --- | --- | --- | --- | --- |
| 图片转写者 | 多模态主路径=主 Agent `save_image_description`；兼容路径=channels 独立 Vision 服务 | 主路径回合内；兼容路径消息接入时 | 转写图片可见内容（品牌名 / ID / 门店） | 不认定品牌：转写文本经 `resolve()` 目录验证 | turn-finalizer 异步 Vision 补写 |
| 事实提取 LLM | memory `extractFacts` | onTurnEnd 收尾序列 | 极性判断 + **指代链接** | 不创造品牌名：输出必须过目录验证 | 只剩规则轨，默认 positive |
| 主 Agent LLM | agent/generator | 回合内 | 本轮工具查询传什么品牌参数 | 参数不是事实：入口标准化校验重写，永不直接写状态 | 参数为空走会话品牌兜底 |
| 守卫 LLM（语义档） | guardrail | 出站审查时 | 回复与工具实际行为是否对账一致 | 不做品牌匹配：只读 queryMeta | 确定性硬规则仍在 |

**共同原则**：LLM 产出的是候选文本、极性或参数，**品牌实体是否成立一律由 `resolution/brand` 的目录验证裁定**；品牌状态的写入一律经 §7.3 的策略行。

### 5.1 LLM 极性轨的输入闸（`llm-intent-guards.ts`）

`extract_facts` 的 `brand_intents` 契约要求 `brand` 字段是品牌名，但弱模型会把对话上下文里的整句话塞进来。整句经包含匹配仍能过目录验证，造成两类「说话人不对」的状态污染：

1. **助手话术回声**——Agent 自己的找店话术被当作候选人意向输出（生产实例 chat `6a633590`，`null → 塔可贝尔` 凭空立主品牌）；
2. **系统文本回流**——守卫 repair 反馈被当候选人原话解析，形成「守卫抱怨品牌 → 品牌被重新种进状态」的自我强化回路。

两个判定都是纯函数，调用方 `session.service` 的 `validateBrandIntents` 持有对话上下文，命中即整条丢弃。**裸品牌名 / 短指代不在拦截范围**——指代链接（「你刚才说的那家」→ 品牌名）是 LLM 轨的本职，不能因 Agent 提过该品牌就拦。

### 5.2 极性双轨的时序与降级

- **规则轨在 onTurnStart 运行**：处理高置信模式的有限清单——「不要X」「除了X都行」「品牌不限 / 都行 / 随便」「换个品牌」，以及**指示代词排斥**「这个 / 那个不考虑」（输出品牌为空的 `negative`）。规则命中即定极性；
- **LLM 轨在 onTurnEnd 的 `session_turn_end_updates` 串行序列内运行**（`extract_facts` 步骤，带缓存 / 跳过 / 降级），产出正好赶在品牌状态写入之前；
- **两轨冲突时显式否定规则优先**——把「不要肯德基」落成 positive 的代价远高于漏掉一次 positive；
- ⚠️ **状态应用步骤不因 extract_facts 失败而跳过**：extract_facts 抛错或降级时仍须以规则轨结果照常运行，否则当轮确定性解析出的 positive/negative（连同首轮 seed）随异常一起丢失。

LLM 轨承担一个规则轨和目录匹配**结构上做不了**的职责——**指代链接**：候选人发 M Stand 海报配文「这个不考虑」，「这个」在品牌库中无从命中，只有能读到完整上下文的 LLM 才能把它链接到图片品牌。

---

## 6. 工具品牌控制

### 6.1 查询形态与品牌来源

**建模原则：模式只描述查询形态，品牌来源单独记录。**

```ts
export type BrandFilterMode = 'enforce' | 'exclude' | 'clear' | 'browse_all';
export type BrandSource = 'model_input' | 'session_state' | 'none';
```

| 模式 | 行为 |
| --- | --- |
| `enforce` | 仅查询指定品牌（列表非空时的默认语义） |
| `exclude` | 排除指定品牌 |
| `clear` | 模型有意放宽（0 结果重查、探索别家）：不带品牌查询，**不修改会话状态** |
| `browse_all` | 用户明确不限品牌：查询所有品牌，**清空会话状态** |

⚠️ `clear` 与 `browse_all` 必须保持区别：前者是模型的单次查询策略，后者是候选人的明确表达。

| 组合 | 生效查询 | brandSource |
| --- | --- | --- |
| 品牌列表非空 | 按指定品牌查 / 排除 | `model_input` |
| 列表空 + mode 未传 | 会话品牌兜底：`currentBrand` 命中按 enforce 并披露 | `session_state` / `none` |
| 列表空 + `clear` / `browse_all` | 无品牌查询 | `none` |
| 列表空 + `enforce`/`exclude` | 矛盾组合，工具报错引导 | — |

**兜底边界原则：只补「模型看不到的跨轮遗忘」，不干预「模型刚看过的本轮判断」。** 仅 `currentBrand` 一档；本轮文字 / 图片是模型眼前的上下文，没传更可能是策略而非遗忘，不注入。

意图完整性的三个保障——兜底不是「系统篡改意图」：

1. **契约可见**：兜底语义写在工具 description 里，模型读得到。真正的篡改是**未声明的静默注入**；
2. **可覆盖**：想无品牌查询传 `clear`/`browse_all`，显式声明永远优先于兜底。否则会出现「策略要放宽、兜底强行拉回、永远查同一品牌永远 0 结果」的死循环；
3. **可追溯 + 知情**：`brandSource` 非 `model_input` 时向模型披露所用品牌与 `clear` 出口。

**`exclude` 的执行面限制**：Duliday 岗位接口没有品牌排除参数，只能在召回结果内本地后过滤。受分页扫描上限影响（距离召回最多 200 条），排除后可能出现「被排除品牌占满前几页、目标岗位被截断」的召回空洞——已知局限，queryMeta 中如实记录供审计。

### 6.2 工具入口标准化

所有 `brandAliasList` 在工具入口统一通过品牌目录标准化：校验已有 `brandIdList` → 别名解析成唯一标准品牌 → 能取 ID 时优先生成 `brandIdList` → 冲突 / 低置信 / 未命中进 rejected，不形成强制过滤 → 保留模型原始参数用于审计但**不视为权威事实**。

### 6.3 同音回指是独立管线

`brandAliasList` 硬过滤 0 结果时的拼音同音回指（badcase「刘姐妹」→「成都你六姐」）住在 `fuzzy-recall.ts`，但**不并入 `resolve()`**，三个实质差异：

| | `resolve()` | `fuzzy-recall` |
| --- | --- | --- |
| 候选集 | 整个品牌库 | 仅本会话最近推荐过的少数品牌 |
| 置信契约 | 可直接执行的品牌事实（≥0.75 放行） | **必须经候选人确认的猜测**，永不直接成为事实 |
| 触发条件 | 每条消息 | 仅「查询命中 0 结果」事件 |

若并入 `resolve()` 每条消息都跑，会在普通文本上持续产出低置信噪音，破坏「解析结果必须能溯源到品牌库」的确定性。衔接点在 queryMeta 的 `fuzzySuggestions` 字段。

---

## 7. 会话品牌状态

```ts
export interface SessionBrandState {
  currentBrand: SessionBrandRef | null;
  excludedBrands: SessionBrandRef[];
}
```

**不设 `historicalBrands`**：被替换的品牌即遗忘——查询不过滤、提示词不注入。历史从 `brand_state_change` 事件流回放；模型若需要「他之前提过什么」，对话历史本身就在上下文里。

### 7.1 单一写入方

**写品牌状态的路径全系统只有一条。** LLM 事实提取抽出的品牌不再直接落任何字段，先经品牌库验证（对不上库即丢弃）+ 极性判定，转换为标准 `BrandResolution`，与用户文字 / 昵称 / 图片的解析结果一样走 §7.3 的策略行。

### 7.2 存储与并发

`SessionBrandState` 整体 JSON 序列化后存入会话状态 hash（`factsv2:{corpId}:{userId}:{sessionId}`）的**单一字段** `brand_state`——不是独立 Redis key。复用 factsv2 的字段级写入与 **90s 租约锁 + 心跳续期**；读取搭 `getSessionState` 的 HGETALL 便车。

⚠️ **禁止**把 current/excluded 拆成多个 hash 字段——字段级合并会让事务性迁移出现半更新状态，这正是 debounce 并发下修过的 P0 坑型。`brand_state` 需注册进 `SessionFactsRedisContentSchema`，否则 zod 校验会丢弃该字段。

### 7.3 状态迁移规则

实现在 `src/resolution/evidence/brand-policy.ts`（品牌策略行：复合槽值 + set/exclude/clear 替换语义），与其它候选人字段共用同一套证据裁决底盘。执行位置在 `memory/services/brand-state.service.ts` 的 `applyTurnResolutions`，memory 侧只负责「持锁读 → 调策略 → 写回」。

**第 0 步 · 过滤输入**：剔除 `contact_name` 来源的结果——昵称品牌不参与常规轮次的状态更新，否则这个每轮都在的静态值会不断把自己写回 `currentBrand`。它进入状态的唯一通道是**首次初始化 seed**：`brand_state` 不存在时设为初始值，一次性、此后与普通品牌同权。**状态一旦存在（哪怕被 browse_all 清成空值）永不重新 seed**——「清空后被昵称锁回」在结构上不可能发生。

**第 1 步 · 应用全部 `positive`**（按来源排序：图片先、文字后）：

- **单品牌表达** → 替换 `currentBrand`，被替换的旧值直接丢弃；**同时将该品牌从 `excludedBrands` 移除**（候选人反悔即赦免）；
- **多品牌表达或品类展开** → **不立主品牌**（候选人没说更想去哪个，系统不替他挑），但**显式命中的解除排斥照常**——若肯德基此前被排斥、现在他点名说「都可以」，黑名单必须移除，否则系统行为与他刚说的话矛盾；
- **品类展开产出的 positive 不解除排斥**。

判别规则：**同一来源的 positive ≥2 条，或任一结果 `matchType='category_expansion'`，即为多品牌表达**。跨来源不算多品牌——图片 positive(A) + 文字 positive(B) 按「图片先、文字后」逐来源应用替换，文字赢。

**第 2 步 · 应用全部 `negative`**：有品牌 → 加入 `excludedBrands`，若恰是 `currentBrand` 则同时清空；品牌为空（「换个品牌」）→ 把 `currentBrand` 移入 `excludedBrands` 并清空。

**第 3 步 · 应用 `browse_all`**：清空 `currentBrand` 和 `excludedBrands`。

这个执行顺序**自动保证**三条性质，无需额外规则：

1. 结果与说话顺序无关——「肯德基不要，麦当劳可以」正反着说结果相同（negative 永远最后应用）；
2. 同一品牌同轮又要又不要时，**排斥赢**；
3. 图文并发时**文字赢**——发 M Stand 截图 + 配文「有没有瑞幸」，`current=瑞幸`。

> 同轮内先后顺序不可信（消息可能被 debounce 拆合），故保守判排斥；跨轮 positive 是时序明确的新事件，按「最新表达为准」处理。

**读取方**（均为只读）：提示词注入 `currentBrand` + `excludedBrands`；工具会话品牌兜底读 `currentBrand`。current 与 excluded 互斥由迁移规则保证——排斥即清空，兜底不可能拉回刚排斥的品牌。

---

## 8. 图片品牌处理

### 8.1 描述的两条产出路径

取决于主聊天模型是否支持 vision（`accept-inbound-message` 按 `supportsVisionInput` 分流）：

| 路径 | 条件 | 产出者 | 时机 |
| --- | --- | --- | --- |
| **多模态主路径**（生产常态） | 主模型支持 vision | 主 Agent 调 `save_image_description` 回写 | **回合内** |
| 文本兼容路径 | 主模型不支持 vision | 独立 Vision 服务预转写 | 回合前 |
| 运行时降级 | 多模态调用失败 | 独立 Vision 服务转写后文本重跑 | 回合内重试时 |

关键推论：**多模态主路径下，回合准备时刻图片描述尚不存在**，无法在准备阶段解析。

**格式契约双侧同步**：「品牌ID：10239」行的约定同时存在于独立 Vision 服务的 prompt 与 `save_image_description` 工具的 description，**修改必须两处同步**。

### 8.2 解析执行点与状态写入点分离

- **解析在 `save_image_description.execute` 内**：模型回合内落描述时，execute（确定性代码）立即同步 `resolve(description, 'image_description')`，结果挂**回合上下文**。当轮消费方限于两处**不干预模型行为**的用途——出站守卫对账、turn-finalizer 写状态；
- ⚠️ **不进当轮查询兜底**：模型刚看过图，没按图片品牌查更可能是策略而非遗忘，注入即篡改工具调用意图。图片品牌自**下一轮**起经 `currentBrand` 参与兜底；
- **状态写入仍只在 turn-finalizer**：复用回合上下文里的解析结果（不重复解析），与 extractFacts 的极性 / 指代链接结果汇合后批量应用。

### 8.3 描述缺失兜底与两道时序防护

主路径的描述回写靠工具提示词驱动，模型可能忘调。turn-finalizer 检测本轮图片消息缺描述时触发一次**异步 Vision 补写**。

补写落状态是**处理锁外的异步晚到写**，必须带两道防护，否则会出现「旧图片信号覆盖新表达」的时间倒流：

1. **重新持锁**——补写落状态前必须重新获取该会话的处理锁（复用 90s 租约锁语义，被占则等待重试）；
2. **过期即弃**——解析结果携带产生轮次，拒绝应用早于 `brand_state` 最后变更轮次的补写结果。**宁可丢一次图片品牌，不做时间倒流。**

> 具体时间倒流场景：turn N 发 M Stand 截图但模型漏调描述 → turn N+1 候选人说「M Stand 不要」进 excludedBrands → 补写此后才完成，若径直应用，positive(M Stand) 会解除排斥并立回主品牌。

**图片消息的识别以结构化 `messageType` 为准**，`[图片消息]` 前缀仅作为描述文本的渲染约定，**不得作为判定依据**。

---

## 9. 出站守卫对账

`queryMeta` 不是新增的运行时层——工具返回值里本就有 `result.queryMeta`。品牌相关字段收拢为其中的 `brand` 小节：

```ts
export interface NormalizedBrandQueryMeta {
  filterMode: BrandFilterMode;
  brandSource: BrandSource;
  appliedBrandIds: number[];
  appliedCanonicalNames: string[];
  rejected: Array<{ input: string; reason: 'unmatched' | 'ambiguous' | 'low_confidence'; candidates?: BrandCandidate[] }>;
  fuzzySuggestions?: Array<{ brandName: string; inputAlias: string; score: number }>;
}
```

工具返回值整体就是喂回模型的 tool output（AI SDK 机制），**模型天然可见 queryMeta**——兜底披露即通过它送达。

**出站守卫读 `toolResult.queryMeta.brand`，不读模型原始 `brandAliasList`**，共三个读点：

- `requested_brand_mismatch` → 读 `appliedCanonicalNames` / `appliedBrandIds`（对账对象是「工具实际应用的」而非「模型请求的」）；
- `brand_alias_fuzzy_match_ignored` → 读 `queryMeta.brand.fuzzySuggestions`；
- **语义档 review packet** → `review-packet.builder` 读 `queryMeta.brand`（applied + rejected）。前两条是硬规则，这条在语义档取数层，最容易被遗漏。

被拒绝的昵称或模型别名不会成为品牌不匹配守卫的权威依据——rejected 不在 applied 里。

---

## 10. 可观测性

复用 observability 体系（AgentTracer → CompositeObserver → PersistingObserver），落 `agent_execution_events`，与 `message_processing_records` 同 `trace_id` 可 join。

| 事件 | 触发 | 内容 |
| --- | --- | --- |
| `brand_state_change` | 仅状态**实际变化**时（多数轮次零行） | 前后快照 + 触发它的解析结果（来源 / 匹配方式 / 极性 / `matchedText` / `sourceText`） |
| `brand_resolution_ambiguous` | 歧义结果无条件记录（不依赖状态变化） | 歧义现场 + candidates；过期丢弃路径也留痕 |

⚠️ 新事件除加入 `AgentEvent` union 外**必须同时注册 `PersistingObserver` 的 `ALWAYS_PERSISTED_EVENT_TYPES` 白名单**，否则事件发了不落库。

`brand_state_change` 是品牌链路上唯一**不可重放**的信息（状态迁移依赖前态），并承担 `historicalBrands` 删除后的历史回放职责。归因字段 `matchedText` + `sourceText` 让误命中归因在事件表内自足——没有它们，脏别名塌缩与候选人真实简称在事件里长得一模一样。

**刻意不落的两类**（事件表「只存不可再得的结构化事实、不当日志表」纪律）：

- **解析结果不单独落事件**——`resolve()` 是纯函数，拿候选人原文 + 品牌目录离线重放即可精确复现；
- **queryMeta 不单独落事件**——已随 `agent_invocation` 落在流水表中。

补写的「过期丢弃」与「锁竞争放弃」两类设计上罕见的异常升级为**飞书告警**；漏调净残留用数据侧兜底查询（`chat_messages` 中裸 `[图片消息]` 占位计数）。Logger 仅作辅助排障。

---

## 11. 开放项

| # | 项目 | 现状 |
| --- | --- | --- |
| 1 | **品类偏好跨轮记忆** | `currentCategory` 未实现。品类词走 `category_expansion` 不写会话主品牌，跨轮不留痕迹、只能靠模型读对话历史。该退化已成既成事实，**需补裁定** |
| 2 | **`excludedBrands` 查询侧强制** | 仍是提示词软约束。`brand-query.util.ts` 只在**品类展开**时减 `excludedBrands`，`brandSource ∈ {session_state, none}` 的无品牌查询无确定性后过滤 |
| 3 | **受控模糊匹配** | 不是「待决策」，而是**决策所依赖的数据从未采集**——`unmatched` 仅作为工具入参的 rejected reason 存在，无未命中率聚合观测。要么补观测，要么承认无限期挂起 |

---

## 相关文档

- [候选人档案域架构](./candidate-profile-domain.md) — 品牌状态的入档裁决底盘与域宪法
- [地理解析域架构](./geo-resolution.md) — 同构的确定性解析域
- [记忆系统架构与数据流](./memory-architecture.md) — `brand_state` 在会话状态中的位置
- [安全护栏说明](./security-guardrails.md) — 出站守卫总览
