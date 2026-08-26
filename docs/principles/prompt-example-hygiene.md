# 示例示教与幻觉：示教纪律（Prompt Example Hygiene）

**最后更新**：2026-08-12（成文）

> 状态：经验总结（示教四原则待编号为 P12 并入分工哲学）
> 起因：给 Agent 的上下文里堆了大量"教学示例文案"，反而成了幻觉来源。本文回答三个问题：
> **示例是怎么变成幻觉的（机制）、我们的示例面现状如何（普查）、业界与我们各自怎么解（对照与原则）。**
>
> 数据基础：全库示例面普查（130 处逐字原文对照表，2026-08-13 红区复查全绿后按"落地即删"规范删除，原文见 git 历史 docs/todo/prompt-example-census.md）；
> 姊妹篇：[rules-vs-semantics-design-philosophy.md](./rules-vs-semantics-design-philosophy.md)（P11 裁决权宪法——本文档案侧防线的来源）。

---

## 0. 一句话版本

**示例不是负担，虚构值坐错位置才是**：全库约 130 处模型可见示例中 88% 健康（真值域/话术/封闭枚举），
真正危险的只有 6 处——它们共享同一个公式：**虚构值 × 高频在场 × 形状门放行**。
解法不是删示例（业界也没有任何一家主张删），而是四条示教纪律：
**真值示教优先、虚构必自毁、格式交渲染、语料分域**——四条全部已在库内各有一处成功实践，缺的只是全局化。

---

## 1. 三种致幻机制（每种都有本库实证）

| 机制                 | 定义                                                                                 | 本库实证                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1 示例值→数据**   | 教学里的虚构值在**真值缺席**时被当事实检索——证据缺席时示例是上下文里引力最强的 token | 抽取示例回声族（示例名/新造名/短垃圾值三变体，修了三轮：PR #730 出处门 → #843 四字段门 → #1000 反臆造手术）；幻影预约 badcase 6e9ar9gd（模型引用不存在的"预约"） |
| **M2 教学语→输出**   | 元语言（模板/示例/内部机制表述）漏进候选人可见文本                                   | "AI保持静默"被旁白给候选人（meta_narration）；工具 JSON 骨架漏进回复（internal_output_leak）                                                                     |
| **M3 格式骨架→臆造** | 教了格式 = 给了无数据也能实例化的生成器                                              | precheck 空会话臆造 jobId + 整张报名表（表的形状来自格式教学）                                                                                                   |

M1 有个重要变体：**上下文里的数据形值被错误归属**——岗位要求"21-50岁"被填成候选人年龄 50。
机制与示例回声完全相同（数据形 token 在缺值时被抓来补位），说明问题不限于"教学示例"，
而是**一切与真值同形、却不是真值的上下文内容**。

## 2. 普查结论（2026-08-12，方法与逐字原文见普查表）

- 模型可见示例实例 ≈ **130 处**：红 **6** / 黄 **10** / 绿 ≈ 114（88%）；
- **红区公式：虚构值 × 高频在场 × 形状门放行**。典型：主提示词里的示例人名"常允丽"——每轮在场、
  3 字纯 CJK 穿过全部姓名形状门、不在任何占位黑名单；
- 绿区占 88% 说明示例文案的主体是健康的——真实城市/品牌/枚举/话术模板/地理通识都安全；
- **文案对冲值有天花板**：抽取提示词经三轮"反臆造手术"（推断白名单/宁缺毋假/交空卷）后事故停了，
  但示例值本身仍在（"人民广场店"）——用 13 处禁令文案守 1 个虚构值，是跑步机不是解。
  业界研究同样表明 prompt 级缓解只能减半不能归零（53%→23%）；
- **教学示例会跨面繁殖**："我姐今年24"这个反例句已同时存在于 precheck 描述与 turn-hints section
  两个面——没有登记机制时，示例的传播不可追踪。

**普查方法论教训**（写给下次）：标记 grep（例如/如/示例）会漏「"……"这类句子」式示例；
普查完备性必须以**枚举全部模型可见文本构建器并通读**为准，标记法只作初筛。

## 3. 业界解法对照（2026-08 检索）

| 解法族                 | 代表                                                                                                                                                         | 与本库机制的对应                                                               | 判断                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| **指令/数据结构分离**  | StruQ（保留分隔符双通道）、OpenAI Instruction Hierarchy（角色信任层级）、Spotlighting                                                                        | 我们的"语料分域"（抽取审计语料排除 system prompt）                             | 方向一致；业界主力在训练层（我们不可用），scaffold 层等价物即我们的做法。共同结论：**"这是示例"的自然语言框架永远脆弱，边界必须结构化** |
| **引文接地 + 验证层**  | Anthropic Citations API（字符级出处，客户实测来源幻觉 10%→0%）；CiteCheck/CiteGuard（学界证明只生成引用不够——商用模型引用幻觉率仍 11-57%，须配确定性验证层） | P11 公证器（claim+quote+三问）                                                 | **双层形态被业界独立验证**；我们的"回声检查"（与自家已发消息比对）未见公开对应物，属场景领先                                            |
| **Canary/哨兵值**      | OWASP LLM07:2025 工具链（langchain4j 原生 canary 守卫）：种永不应出现在合法输出的值，出站确定性扫描                                                          | 占位号黑名单（13800138000 被 `isPlaceholderPhone` 拒收）——我们无意识发明的同款 | 同构；**业界多一步出站扫描**（见 §5 唯一新增防线）                                                                                      |
| **上下文工程官方实践** | Anthropic："curate diverse, canonical examples"、"smallest set of high-signal tokens"                                                                        | 普查"88% 绿区、修 6 处"结论                                                    | 官方仍强烈推荐 few-shot；且官方指导**未覆盖示例值污染**——本普查在此维度更细                                                             |
| **抽取接地**           | Google LangExtract："output grounded by original input"                                                                                                      | claims 通道的 quote 强制                                                       | 一致；抽取示例回声在公开文献是空白区，**本库事故档案比文献完整**                                                                        |

## 4. 示教四原则（P12 候选）

1. **真值示教优先**：要演示格式/行为，用本会话真实数据渲染实例。
   库内范本：job-list 的 `${boundaryExamples}` 动态示例（从本轮真实结果渲染）、
   主提示词 :20 直接引产品口径括注原文。示例的最安全形态是真值——被回声也无害。
2. **虚构示例必须自毁**：躲不开虚构时，示例值一律取自**注册的示例词表**，且词表值满足
   "下游形状门可拒收"或"统计上可识别"（值域合法但现实罕见）。占位号黑名单是现成的下游拒收端；
   新增虚构示例必须登记，从此示例的跨面传播可追踪。
3. **格式教学交给渲染，不交给描述**：与其在 describe 里写"表单长这样：姓名：X…"，
   不如让代码渲染真实例（templateText/岗位卡已是）。模型从实例复制结构，永不从描述生成结构——
   这是 P2"按构造约束"用在教学材料上。
4. **教学语料与证据语料分域**：统一使用封闭枚举 `teaching / evidence / tool_result`，
   不从自然语言内容反推身份。候选人引文公证只消费 `evidence + user`；回声审计消费
   `evidence + assistant` 与 `tool_result`；`teaching` 永不取得事实出处资格。2026-08-13 起，
   prompt 叶子 block 与对话消息都在降为模型 transport 前保留结构化旁路；因此内部指令即使为适配
   SDK 以 `user` role 传输，也仍是 `teaching/system`，不再靠消费方各自列排除清单。

**边界案例的裁定指引**：防御性反例（"我姐今年24"这类教模型识别陷阱的句子）允许存在——
它们是紧贴数据渲染处的疫苗；但适用原则 2 的登记要求，且首选真实 badcase 原句（真值示教的反例版）。

## 5. 防线全景（Input / Prompt / Tool / Output）

**架构定位——Prompt 生成防线的示教纪律**：系统有 input / prompt / tool / output 四个作用位。
其中 Prompt 负责生成前预防，不拥有运行时 veto；Input / Tool / Output 负责短路、动作门禁和出站
验收。[Datadog 的业界框架](https://www.datadoghq.com/blog/llm-guardrails-best-practices/)明确列出
Prompt Construction；本库在此基础上还把副作用 Tool 门禁独立成层。本文不是“补一层规划稿”，
而是已经落地的 Prompt 防线宪章：示教四原则约束设计，示例注册制、语料分域、规则台账和 CI
扫描负责执行。完整架构 = **input / prompt / tool / output 四个作用位**。

| 方向                             | 防线                                                                                                                                          | 状态                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 档案侧（示例值想进事实账本）     | P11 引文公证：示例值不在候选人语料里，`quote_not_found` 直接拒                                                                                | ✅ 已上线（shadow 实证：真编造全被抓获）        |
| 档案侧（候选人抄我方模板）       | 回声检查（quote 命中我方已发消息 → 转确认）                                                                                                   | ✅ 已落地（PR #1000 C4）                        |
| 工具入参侧                       | jobId 溯源闸、占位号/纯数字姓名形状门                                                                                                         | ✅ 已上线                                       |
| 出站侧（元语言泄漏）             | meta_narration / internal_output_leak BLOCK                                                                                                   | ✅ 已上线                                       |
| **出站侧（示例值漏给候选人）**   | **示例词表出站扫描**：回复含注册示例值（测试娟/测试门店/占位号）→ `example_value_leak`。纯字符串比对，P3 合法封闭形态，业界 canary 守卫的同款 | ✅ 已落地，按发牌制以 `observe` 入场            |
| 注意力稀释                       | "最小高信号 token 集"——普查红黄区清洗即是减法                                                                                                 | ✅ R1–R6 已清洗；Y2 已换弱 canary               |
| **Prompt Construction 语料边界** | prompt 叶子块与对话旁路标注 `teaching / evidence / tool_result`；出处公证、回声审计、booking 水位按标签选语料                                 | ✅ BL2 已落地；封闭枚举，不新增开放自然语言裁决 |

## 6. 元教训（超出示例问题本身的三条）

1. **"局部悟道未全局化"是本库反复出现的组织病**：四个正确示教范式各自在一处被发明
   （动态示例/占位号黑名单/语料分域/元标题禁令），彼此不知对方存在——与裁决权改造中
   发现的模式（labor-form 冻结令、出站发牌制、CandidatePrefillHint 各自局部正确）完全同构。
   经验的敌人不是无知，是**不流通**。本 principles/ 目录因此而设。
2. **普查先于原则**：本库从不缺原则，缺"哪里在违反"的清单。先拿到 130 处逐字原文，
   四原则才从数据里自己长出来（而不是从直觉里辩出来）。原则文档必须由普查/事故编号背书。
3. **用文案对冲值是跑步机**：三轮反臆造手术、13 处禁令文案，不如把一个虚构值换掉。
   禁令治理的是模型行为，换值治理的是问题存在性——永远优先后者（P2 的又一投影）。

---

## 附：行动清单去向

普查的 6 处红区清洗、Y10（turn-hints 补"提示行禁外泄"纪律行）、示例词表注册制、
出站 canary 扫描规则、门店形 CI 补洞（BL1）与结构化语料分域（BL2）均已于 2026-08-13 落地——见
普查表 §五（已删，见 git 历史 docs/todo/prompt-example-census.md）。

## 附：业界资料（2026-08-12 检索）

- [StruQ: Defending Against Prompt Injection with Structured Queries](https://sizhe-chen.github.io/StruQ-Website/)
- [Introducing Citations on the Anthropic API](https://www.anthropic.com/news/introducing-citations-api)
- [Cited but Not Verified: Source Attribution in LLM Deep Research Agents](https://arxiv.org/pdf/2605.06635)
- [CiteCheck: Retrieval-Grounded Detection of LLM Citation Hallucinations](https://arxiv.org/pdf/2605.27700)
- [langchain4j: Native "Canary Word" Guardrail (OWASP LLM07:2025)](https://github.com/langchain4j/langchain4j/issues/4587)
- [LLM guardrails: Best practices（Datadog）](https://www.datadoghq.com/blog/llm-guardrails-best-practices/)
- [Effective context engineering for AI agents（Anthropic）](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Introducing LangExtract（Google）](https://developers.googleblog.com/introducing-langextract-a-gemini-powered-information-extraction-library/)
- [Task Contamination: Language Models May Not Be Few-Shot Anymore](https://arxiv.org/pdf/2312.16337)
- [Multi-Layered Framework for LLM Hallucination Mitigation](https://www.mdpi.com/2073-431X/14/8/332)
