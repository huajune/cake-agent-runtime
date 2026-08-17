# 简历读取工具（read_resume_attachment）整改方案 v4

> 状态：已实施待评审 · 2026-08-17
>
> 实施偏离（2026-08-17）：① `transcribeScannedPdf` 接收 `Buffer` 而非已构造 parser，
> 由 util 自己创建/销毁 `PDFParse`，避免跨层泄漏资源所有权；② 长图切片直接调用
> `@napi-rs/canvas`，因此把 pdf-parse 已有的同版本传递依赖提升为直接依赖；③ 乱序 PDF
> 验收在工具集成测试中 mock 文字层结果复刻容器形态，docx 与 tall PNG 则现场生成，未提交
> 二进制 fixture；PDF 文字层与 getScreenshot 分别由 util 单测及 spike 实测覆盖；④ 安全审查
> 禁止把生产真实 PII 再发送给外部模型，Extract/Vision 质量验收改用同形态假身份样本。
>
> 已拍板：闸门放开读取（resumeRequired 只管上传）；三期全做；回档并入 sheet 信号轨；
> 解析改三层技术路线（LLM 主轨 + 确定性公证 + 正则兜底）。
> v4 变更（用户质询「为什么不用大模型」成立）：纯正则路线是对「resolution 零 LLM」
> 分层规则的过度应用——宪法是 P11 三权分立（模型作证/代码公证/本人终审），不是禁用模型。
> 图片简历已是 Vision 产 sheet（kind 92%/key 100%），PDF 用正则是容器不同技术分裂。
> 编造风险由公证层封死：sourceText 逐字回查 ∈ 文档原文（全文在手，公证条件最强）、
> 形态校验复用既有解析器、置信度由代码授予。姓名三级兜底/档案块前置降级为兜底轨。
> v2 变更：①版面重建放弃坐标方案（pdf-parse 未暴露坐标 API），改文本级档案块前置；
> ②证据化回档不动 claim 引擎。
> v3 变更（用户裁定）：v2 的 sessionFacts `source:'system'` 通道是**虚假署名**——简历是
> 候选人提供的材料，不是"外部系统查来的"；但也不是"本人亲口"（帮朋友投/文档过时/
> 转发材料，vkikct39 第三方截图夺号同族风险）。正确语义=三判据（这是什么文档/归谁/
> 可不可信），该语义已由视觉信号域实现且 `kind='resume'` 现成：**PDF/docx 简历与
> 拍照简历是同一语义对象，统一走 sheet 信号轨**。
> 实证基线：record 265669（PDF 成功但 name 丢/文本乱序）、record 181397（docx 直接 not_pdf）。
> **容器分布生产实测（2026-08-17，30 天 chat_messages，n=18，小样本方向可信比例粗）**：
> 图片（拍照/截图/长图）11 例 61%＞PDF 5 例 28%＞docx 2 例 11%＞老 .doc 0 例。
> **图片是第一大容器**——图片道是主战场不是支线，spike ⑦ 最高优先；
> PDF 内部数字版/扫描件比例未测。另：11 张识别为简历的图仅 5 张产出结构化 sheet，
> 图片简历现有结构化覆盖仅半，按需深读通道的必要性高于设计时预估。

## 1. 实证问题清单

| #   | 问题                                                                                                                          | 证据               | 定级        |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------- |
| 1   | `fields.name` 抽不到：正则强制 `姓名：` 标签；文件名 `杨美英简历.pdf` 免费兜底没用                                            | 265669             | P0          |
| 2   | .docx 直接失败（`%PDF-` magic bytes），5 样本 2 份 docx，覆盖率丢 40%                                                         | 181397             | P0          |
| 3   | `education` 取最左命中而非最高学历；且 `parseEducation` 的学校语境守卫（含"学院/学校"即拒）在简历文本上必然拒绝——简历必提学校 | 代码审读           | P0          |
| 4   | 工具内手写 5 条正则，与 `resolution/candidate/`（字段解析唯一居所）重复                                                       | parseName 等已存在 | P0 随手收编 |
| 5   | 业务字段错配：性别/期望城市/求职意向/期望薪资/餐饮经历全没抽                                                                  | 265669             | P1          |
| 6   | fields 无出处无置信度；解析结果不回档，跨轮即失忆                                                                             | 代码审读           | P1          |
| 7   | phone 全文首个命中，无归属判定（紧急联系人/HR 会被误抽）                                                                      | 代码审读           | P1          |
| 8   | PDF 文本流乱序（侧栏排版页眉信息堆末尾）                                                                                      | 265669             | P2          |
| 9   | 扫描件 PDF 提取不到文字即放弃，vision 与渲染能力都是现成的                                                                    | 代码审读           | P2          |
| 10  | text 不裁剪低价值段，6000 上限偏大                                                                                            | 265669             | P2          |

## 2. 现状技术盘点（结论依据）

- 解析：`pdf-parse@2.4.5`（底层 pdfjs-dist 5.4.296 + @napi-rs/canvas，**整体打进 CJS bundle，
  拿不到裸 pdfjs**）。`getText` 无坐标输出；`getLines()` 是几何线段（表格检测），非文本行。
  可用增量能力：`getScreenshot()` 渲染整页位图（扫描件兜底用）。
- 仓库 `module: commonjs`、零动态 import 先例 → 直接依赖 pdfjs-dist（5.x 纯 ESM）成本高，放弃。
- 图片简历另有独立链路（image-description.service → Vision 模型 → [图片消息] 描述），本方案不动。
- 无任何 zip 库 → docx 需新依赖 fflate。
- lint 分层：tools → llm 合法（eslint 限制只约束 resolution/memory/infra 方向）。

## 3. 总体架构

```
tools/read-resume-attachment.tool.ts        只留 I/O：下载、格式分发、错误映射、output 组装、ledger 登记
  ├─ tools/resume/docx-text.util.ts         fflate 解 zip → word/document.xml → <w:p>/<w:t> 抽文本
  ├─ tools/resume/resume-text.util.ts       归一化 + 低价值段裁剪
  ├─ tools/resume/resume-extract.util.ts    解析主轨（v4）：ModelRole.Extract structured output
  │                                           文本 → {field, value, sourceText}[]（LLM 调用留 tools 层）
  ├─ tools/resume/scanned-resume.util.ts    getScreenshot 渲染 → ModelRole.Vision 转写 → 同一条主轨（P2）
  ├─ resolution/candidate/resume-fields.ts  公证 + 兜底（纯函数，零 LLM）：
  │                                           公证=sourceText 逐字回查 ∈ 原文 + 形态校验
  │                                           （parsePhone/isLikelyRealChineseName/normalizeEducationToId
  │                                            /占位剔除）+ 置信度按「字段×证据形态」代码授予；
  │                                           兜底=正则抽取（Extract 失败时保 label 类字段）
  └─ 回档 = 并入视觉/文档 sheet 信号轨（v3 裁定，零新机制）：
       解析成功 → FinalizedVisualFactSheet(kind='resume') →
       ledger.recordVisualFacts（绑定 [文件消息]）→ 轮末 extractionToolFacts.visual.factSheets
       → 三向量门判自陈资格 / ownership 判归属 / 「简历 phone 一律 medium+确认升级」纪律
       全部复用——与拍照简历同轨同待遇
```

**关键简化**：不扩 claim.types、不加 producer、不改 ledger/generator/memory-lifecycle/
session.service（`recordVisualFacts` 与轮末收编链路全部现成）。归属与置信语义由视觉信号域
统一承载：sheet 轨的三判据（这是什么文档/归谁/可不可信）正是简历需要的署名系统，
tools 本就是该管线注释里预留的 P2 主路径生产者。
身份字段（name/phone）依旧过不了 booking 闸门的 candidate_quote 要求——P11「本人终审」天然满足。

## 3.5 实现蓝图（v4.1，供执行者照写）

### 类型（resolution/candidate/resume-fields.ts 内定义并导出）

```ts
type ResumeExtractedBy = 'extract_model' | 'filename' | 'rule_fallback';
interface ResumeExtractedField<T = string> {
  value: T;
  sourceText: string;
  extractedBy: ResumeExtractedBy;
  confidence: 'high' | 'medium';
}
interface ResumeFieldExtraction {
  name?;
  phone?;
  gender?;
  age?;
  education?;
  email?;
  expectedCity?;
  jobIntent?;
  expectedSalary?;
  workYears?;
  relevantExperience?;
  phoneCandidates: string[]; // 归属剔除后仍多号时全列
  notaryDrops: Array<{ field; reason: 'quote_not_found' | 'shape_invalid' | 'placeholder' }>; // 观测用
}
```

### 模块与函数签名

| 文件                                    | 核心导出                                                                                              | 职责                                                                                                                                                                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/resume/resume-text.util.ts`      | `normalizeResumeText(text)` / `trimLowValueSections(text)` / `hoistProfileBlock(text)`                | 归一化；裁「主修课程/自我评价/获奖/证书」段；档案行前置（仅兜底轨/回写摘要用）                                                                                                                                                               |
| `tools/resume/docx-text.util.ts`        | `extractDocxText(buffer): string`                                                                     | fflate `unzipSync` → `word/document.xml` **及 `word/header*.xml`/`word/footer*.xml`**（简历常把姓名电话放页眉，只读正文是盲区），`<w:p>`→`\n`、`<w:t>` 取文、`<w:tab/>`→空格；页眉内容拼在正文前；解析失败抛 ResumeReadError('parse_failed') |
| `tools/resume/resume-extract.util.ts`   | `extractResumeFieldsViaModel(text, llm): Promise<RawField[]>`                                         | `llm.generateStructured({role: ModelRole.Extract, schema, maxOutputTokens≈800})`；schema=字段枚举+value+sourceText 数组；prompt 要求 sourceText 逐字摘自原文；失败抛（调用方转兜底轨）                                                       |
| `tools/resume/scanned-resume.util.ts`   | `transcribeScannedPdf(parser, llm): Promise<string>`                                                  | `parser.getScreenshot({first:2, desiredWidth:1200, imageBuffer:true, imageDataUrl:false})` → Vision 逐行转写（schema `{text}`）                                                                                                              |
| `resolution/candidate/resume-fields.ts` | `notarizeResumeFields(raw, fullText, opts{fileName})` / `extractResumeFieldsFallback(text, fileName)` | 公证（§5.2 四规则；文件名作独立证据源参与 name 合并）；正则兜底轨                                                                                                                                                                            |
| `resolution/candidate/education.ts`     | `parseHighestEducation(text)`                                                                         | EDUCATION_KEYWORDS 表序首中即最高；无学校语境守卫                                                                                                                                                                                            |

### execute() 主流程

```
闸门已删（放开读取）→ resolveAttachment → downloadFile（magic bytes 分发）
  ├ %PDF- → parsePdfText；**文字层过薄即转 vision**（判据：总字符数/页 < 60，
  │         不是只判空——混合 PDF「封面有字+正文扫描图」会静默漏正文）
  ├ PK\x03\x04 → extractDocxText
  ├ FF D8 FF (JPEG) / 89 50 4E 47 (PNG) → **图片简历道（生产第一大容器！）**：
  │         Vision 逐行转写（超长图按高度切片+重叠拼接，阈值经 spike ⑦ 定）→ 同一条主轨；
  │         与被动图片描述链路分工：那边是自动环境摘要（≤512t 有损），
  │         这边是按需深读（全文转写+公证+出处），互不替代
  └ OLE/其他 → read_resume.unsupported_format / not_pdf
→ normalizeResumeText
→ 主轨 extractResumeFieldsViaModel ── 抛错 ──→ 兜底轨 extractResumeFieldsFallback
→ notarizeResumeFields（两轨产物统一过公证；公证通过率过低亦转兜底并 warn）
→ buildResumeFactSheet：VISUAL_FACT_FIELD_KEYS 白名单内字段（phone/city/address）
  组装 VisualFactSheet{kind:'resume'} → finalizeVisualFactSheet → 非 degraded 才
  ledger.recordVisualFacts(sheet, {messageId})（messageId 缺失→跳过并 warn）
→ 消息回写：简历摘要（hoistProfileBlock 后 ≤500 字）回写该 [文件消息] content
→ 返回 output：fields（带出处置信）/ phoneCandidates / text（trim 后 ≤3000）/
  totalPages / sourceKind / usageHint（high 直用；medium 求证后入报名；与聊天明示冲突以聊天为准）
```

### 两个关键接线（实现者最容易踩的点）

1. **消息回写不得 import channels**：updateMessageContent 一族目前在
   channels/image-description.service。做法：找到它落 chat_messages 的底层 biz/message
   服务方法复用（tools→biz 合法，registry 已注入 ChatSessionService 先例）；若该能力
   只在 channels 内，则小幅下沉到 biz/message 再由 registry 注入——**此为 spike ⑥**：
   先查 save_image_description（P2 工具轨）的描述如何落库，照它的通道走。
2. **messageId 出处**：resolveResumeAttachments 现只有 URL。实施时从 upload_resume
   规则事实同源携带消息定位或按 URL 回查该轮消息（spike ②）；拿不到就降级
   （不产 sheet 不回写，output 照常）。

### 最终代码树（v4.2，含长图支线）

```
src/
├── tools/
│   ├── read-resume-attachment.tool.ts      壳：编排 execute()，错误映射，output 组装（重写）
│   └── resume/                             容器/感知层（有 IO、有 LLM 调用）
│       ├── resume-format.util.ts           detectResumeFormat(buffer)→'pdf'|'docx'|'image'|'legacy_doc'|'unknown'（纯函数）
│       ├── pdf-text.util.ts                extractPdfText(buffer)→{text,totalPages,thin}（文字层+过薄判据）
│       ├── docx-text.util.ts               extractDocxText(buffer)（fflate；正文+header/footer）
│       ├── resume-text.util.ts             normalizeResumeText/trimLowValueSections/hoistProfileBlock（纯函数）
│       ├── resume-transcribe.util.ts       transcribeScannedPdf/transcribeResumeImage（Vision；长图切片 sliceTallImage）
│       ├── resume-extract.util.ts          extractResumeFieldsViaModel + RESUME_EXTRACT_SCHEMA（Extract 主轨）
│       └── resume-sheet.util.ts            buildResumeFactSheet→FinalizedVisualFactSheet(kind='resume')
├── resolution/candidate/
│   ├── resume-fields.ts                    内核（纯函数，零 LLM 零 IO）：
│   │                                         notarizeResumeFields（①回查+⑤重锚→②形态→③归属→④授予表）
│   │                                         extractResumeFieldsFallback（兜底轨）
│   │                                         全部类型定义
│   └── education.ts                        +parseHighestEducation（增量）
├── tools/types/tool-error-types.ts         +read_resume.unsupported_format，−READ_RESUME_NOT_REQUIRED
└── tools/tool-registry.service.ts          buildReadResumeAttachmentTool(attachments, deps:{llm, messageWriteback})

tests/（镜像 src/）
├── resolution/candidate/resume-fields.spec.ts    公证全分支/兜底轨/授予表/重锚三段路径——最厚的一份
├── resolution/candidate/education.spec.ts        parseHighestEducation 增量
├── tools/resume/*.spec.ts                        每 util 一份；extract 用 mock llm+编造样本
└── tools/read-resume-attachment.tool.spec.ts     集成：全错误分支+两 case 形态重放
    fixtures/: fake-resume.pdf / fake-resume-scrambled.pdf / fake-resume.docx / fake-resume-tall.png（全部假身份）
```

依赖方向（violate 即 eslint 拦）：壳 → resume/\* → resolution/candidate；
LLM 只出现在 resume-transcribe/resume-extract 两个文件；ledger/回写经 context 与注入服务，
resolution 内核 import 不到任何 IO。

### 实现顺序（可测地基先行）

1. spike ①-⑥ 全关（结论记回本节）；
2. `resolution/candidate/resume-fields.ts` + `parseHighestEducation`——纯函数，
   单测全覆盖后再往上盖；
3. 格式层（docx/text util）+ 单测；
4. 主轨 extract util（mock llm 测试，含编造字段样本验证公证拦截）；
5. 工具 execute 重组 + registry 注入 + 错误类型增删；
6. sheet 组装 + 消息回写 + 集成测试；
7. 两条实证 case 形态重放（假身份 fixtures）收官。

## 4. Phase 1（P0 正确性，独立可发版）

### 4.1 解析主轨 + 姓名兜底（v4 重排）

**主轨**：Extract 模型 structured output 抽全字段（含 name），每字段必须带 sourceText；
公证层逐字回查失败即丢弃该字段。文件名（decodeURIComponent 剥「(个人|求职)?简历|resume|cv」
后剩 2~4 汉字过严格真名校验）作为独立确定性证据源参与合并——模型抽不到时它单独成立。

**兜底轨**（Extract 调用失败/降级时）：

```
① 标签正则：姓名[：:] X                    → isLikelyRealChineseName → high
② 文件名（同上）                           → isStrictRealChineseName → high
③ 锚点邻近：phone/「NN岁」所在行 ±2 行内 2~4 字纯汉字 token
   （排除学历词/职位词）                    → isStrictRealChineseName → medium
```

### 4.2 docx 支持

- 新依赖 **fflate**；`unzipSync` → `word/document.xml`，`<w:p>` 转换行、`<w:t>` 取文本。
- magic bytes 三路分发：`%PDF-`→pdf；`PK\x03\x04`→docx；OLE `\xD0\xCF\x11\xE0`（老 .doc）
  → 新 errorType `read_resume.unsupported_format` 引导转 PDF/拍照。
- `not_pdf` 语义收窄为「都不是」。

### 4.3 education 取最高

`education.ts` 新增 `parseHighestEducation(text)`：按 EDUCATION_KEYWORDS 既有降序表
首个命中即最高（表序即等级序）；**不带**聊天语境的学校守卫（文档语境必提学校）。
聊天轨 `parseEducation` 原样不动。

### 4.4 收编 + 闸门

- `extractResumeFields` 迁入 `resolution/candidate/resume-fields.ts`，委托既有解析器；
- 删除 `resumeRequired !== true` 拒读分支及 `READ_RESUME_NOT_REQUIRED` 错误类型
  （确认无外部引用后）；上传行为不归本工具管，不受影响。

## 5. Phase 2（P1 业务字段 + 回档）

### 5.1 字段集

主轨 Extract schema 字段：name/phone/gender/age/education/email + `expectedCity`、
`jobIntent`（求职意向）、`expectedSalary`、`workYears`、`relevantExperience`（餐饮相关经历
摘录 ≤120 字）。每字段模型必须给 sourceText；公证后形态
`{ value, sourceText, extractedBy: 'extract_model'|'filename'|'rule_fallback', confidence: 'high'|'medium' }`，
confidence 由公证层按「字段类型×证据形态」授予（如 label 锚定→high、自由位置→medium、
简历 phone 按 visual 纪律封顶 medium）。

### 5.2 公证规则（v4 核心，resolution 纯函数）

1. **逐字回查**：sourceText 必须为文档原文（规整后全文）的字面子串，失败即丢整字段——
   direct-field producer 的复算纪律照搬；value 必须能从 sourceText 确定性推出（含归一化）。
   **sourceText 长度上限 120 字**（schema 与公证双侧强制）：防模型把整篇文档当引文，
   使检查①永真、检查②约束稀释——上限逼精确引用；抽取回查两侧用同一份规整文本
   （先规整、再抽取、再回查，全程一份，防 R10 式规整不对称假阳）。
2. **形态校验**：phone 过 parsePhone + 占位号剔除；name 过 isLikelyRealChineseName
   （booking 侧仍有 strict 档二审）；education 过 normalizeEducationToId；age 数值域校验。
3. **phone 归属**：sourceText ±15 字含「紧急联系人/联系人(亲属)/推荐人/HR/店长」即剔除；
   全文 matchAll 多号剩余时全列 `phoneCandidates` 且主值降 medium（兜底轨同规则）。
4. 模型自报的任何置信/判断不采信——只收 value+sourceText，其余全由代码判。
5. **代码自采重锚（业内 LangExtract 二级验证同款，2026-08 调研吸收）**：检查①失败时
   不立即丢字段——先用该字段的确定性解析器在全文中自找证据（如 parseFlexiblePhone
   扫全文、学历词表扫全文），**唯一锚定**且值一致则采纳，sourceText 换为代码自采段、
   extractedBy 标 `rule_fallback`；多锚点或零锚点才丢。挽救模型引文笔误
   （空格/截断），且代码自采的证据强于模型引用。name/phone 等严格身份字段
   仍要求唯一锚定 + 严格形态校验双过。

**置信度授予表（自上而下先命中先生效；对两轨产物统一适用——extractedBy 不参与定级，
证据形态才参与）**：

| 优先级 | 规则                                                                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 封顶 1 | phone 恒 ≤ medium（visual 管线「简历 phone 一律 medium+确认升级」纪律）                                                                                              |
| 封顶 2 | `sourceKind=vision_transcription`（扫描件转写来源）全体 ≤ medium                                                                                                     |
| high   | 证据为 **label 锚定形态**（sourceText 含「字段名：值」结构或等价强形态：页眉「女 \| 24岁」、文件名派生姓名）**且**通过该字段严格档校验（isStrictRealChineseName 等） |
| medium | 自由位置证据 / 锚点邻近启发 / 重锚采纳 / 仅宽松档校验通过                                                                                                            |
| 丢弃   | 形态校验不过 / 占位号 / 归属命中排除词 / 重锚不唯一（phone 例外：多候选主值降 medium + 全列 phoneCandidates）                                                        |

**置信度的下游语义（权限而非概率）**：high=模型可直接引用推进对话（身份字段进报名
仍须 booking 闸门+本人终审）；medium=表单带值求证（「X（如有误请改）」）；
丢弃=字段不存在，正常补问。

### 5.3 回档：并入 sheet 信号轨（v3 裁定）

解析成功后产 `FinalizedVisualFactSheet`：

- `kind: 'resume'`（词表现成，释义「简历本体」，PDF/docx 补进拍照/手写/截图的同一括号）；
- `fields`: 白名单内字段确定性填入（phone/city/address 等，ownership 按 kind 规则补齐）；
- `rawDescription`: 规整后的简历文本（裁剪版）；
- 经 `ledger.recordVisualFacts(sheet, { messageId })` 入账。

**v3.1 实证修正（审计发现）**：抽取器消费 ledger sheet 时只渲染白名单 fields，
从不读 rawDescription（session-extraction.prompt.ts:229 `视觉关键事实` 段），且身份
出处门语料「刻意排除工具事实」（同文件 :243）。图片简历的身份字段能跨轮，靠的是
描述**回写进 chat_messages.content 进入会话窗口**——不是靠 ledger。因此：

- **消息内容回写从"可选增强"升级为 Phase 2 必做承重件**：读取成功后把简历摘要
  回写进该条 `[文件消息]` 的 content（复用 image-description 一族的
  updateMessageContent/appendResumeAttachmentLine 机制），身份字段经会话窗口
  进轮末抽取与身份出处门——与图片简历真正同构；
- 不回写则身份字段只有本轮 output 可用，跨轮必然失忆——此路径明确不接受。

**明确边界**：

- sheet 字段白名单（visual-fact-pipeline.md 附录 A 唯一权威）现无 name/age/gender/education
  键；"文档身份字段确定性入档"若要做，是对附录 A 的受治理修订，**单独立项不塞本方案**。
- expectedCity/意向/薪资/经历只留工具 output 供本轮用（城市域有独立裁决协议，
  标量扇出假城市冲突有前科）。
- 「简历 phone 一律 medium + 确认问答升级」按 visual-fact.types 既定纪律执行。

**实现注意点**：sheet 与内容回写都需绑定 `[文件消息]` 的 messageId；当前
resolveResumeAttachments 只携带 URL。实施时从 upload_resume 规则事实同源携带消息定位
（或按 URL 回查该轮消息），定位不到时降级为不产 sheet、仅 output（记 warn），
不得用合成 id 污染绑定。

### 5.4 output 新形态

```jsonc
{
  "success": true,
  "fields": { "name": { "value": "兮兮", "sourceText": "…", "extractedBy": "filename", "confidence": "high" }, … },
  "phoneCandidates": [],
  "text": "…",
  "usageHint": "confidence=high 可直接用；medium 须向候选人求证后再入报名；与聊天明示冲突时以聊天为准。"
}
```

## 6. Phase 3（P2 解析质量，两项独立）

### 6.1 档案块前置（v4 降级为兜底轨资产）

主轨 Extract 模型对乱序文本天然免疫，本项不再服务主路径；保留为兜底轨/回写摘要的
文本规整手段：识别「档案行」（姓名标签/手机号/「N岁」/性别单字/求职意向/期望薪资/
期望城市）前置为合成「基本信息」块，无命中时零改动。工作量收缩到 resume-text.util 内
一个小函数。

### 6.2 扫描件 vision 兜底

`EMPTY_TEXT` 分支改为：`getScreenshot({first:2, desiredWidth:1200, imageBuffer:true})`
→ `ModelRole.Vision` 逐行转写 → 转写文本进**同一条主轨**（Extract 结构化 + 公证）——
全系统只有一个结构化点；转写即公证回查的基准原文。
依赖注入：`buildReadResumeAttachmentTool(attachments, deps: { llm })`，registry 构造器新增 LlmExecutorService。
护栏：仅 text 为空触发、≤2 页、失败回落现有 errorType、output 标注 `sourceKind: 'vision_transcription'`。

### 6.3 text 裁剪

裁剪「主修课程/自我评价/获奖/证书」超长列表段（fields 抽取仍在全文跑）；
默认 maxChars 6000 → 3000。

## 7. 文件改动清单

| 文件                                                                                                               | 动作                                        |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `src/resolution/candidate/resume-fields.ts`                                                                        | 新增（Phase 1+2 核心）                      |
| `src/resolution/candidate/education.ts`                                                                            | +`parseHighestEducation`                    |
| `src/tools/resume/docx-text.util.ts` / `resume-text.util.ts` / `resume-extract.util.ts` / `scanned-resume.util.ts` | 新增                                        |
| `src/tools/read-resume-attachment.tool.ts`                                                                         | 重写为 I/O 壳                               |
| `src/tools/types/tool-error-types.ts`                                                                              | +unsupported_format，−not_required          |
| `src/tools/tool-registry.service.ts`                                                                               | 注入 llm、传 deps；attachments 携带消息定位 |
| `package.json`                                                                                                     | +fflate                                     |

（v3 后 turn.types / turn-ledger / generator.agent / memory-lifecycle / session.service
全部退出清单——sheet 轨收编链路现成。）

## 8. 测试与验收

- fixtures 一律假身份（兮兮/18271421690）；生产真实 PII 不进仓库。
  PDF fixture 脚本生成（含一份模拟乱序），docx fixture 用 fflate 现场 zip。
- 单测（确定性层全覆盖）：**公证规则**（回查失败丢字段/形态校验/占位剔除/置信度授予/
  phone 归属）、兜底轨姓名三级×来源、education 取最高、档案块前置、docx XML 抽取、
  tool 全错误分支、sheet 产出形态与消息定位失败降级、Extract 调用失败→兜底轨切换。
- 主轨集成测试：mock Extract 返回（含编造字段样本，验证公证层拦截）；
  真实模型质量 spike 在实施期对生产样本文本跑通后记录数字，不进 CI。
- 验收重放：265669 形态 name 必出且带出处；181397 形态 docx 必成功。
- 观测：tool_calls 既有 errorType/durationMs 够用，不加新表。

## 9. 风险与边界

- 简历信息经 sheet 轨进抽取，与拍照简历同待遇：三向量门判自陈资格、phone medium+确认
  升级，最坏情形是表单预填错值待改，不会自动进报名。
- 身份字段经消息回写→会话窗口→轮末 LLM 抽取（同图片简历现状），确定性解析质量会
  部分经过抽取器；缓解：工具 output 直接携带确定性 fields 供本轮模型使用。
- 回写依赖 messageId 定位与 updateMessageContent 时序（图片链路有回写竞态前科），
  实施时必须复用其重试机制而非另写。

## 10. 断言验证台账（v3.1 起交付标准）

方案中每条承重断言必须标注验证状态；未实证项在实施前用 spike 关闭，不得带着假设开工。

已实证（读代码/查库）：pdf-parse API 面与 getLines 语义、CJS/pdfjs 打包现实、
既有解析器签名、parseEducation 学校守卫拒简历文本、EDUCATION_KEYWORDS 表序、
prefill hints 判定条件、VISUAL_FACT_KINDS 含 resume、tools=P2 生产者注释、
recordVisualFacts/drain 链路、抽取器只读 sheet fields 不读 rawDescription、
身份出处门排除工具事实、eslint 分层许可、30 天调用量、仓库无 zip 库。

实施 spike 结论（2026-08-17，七项已关闭）：

1. **getScreenshot 可用**：本机把一页纯图片转为 raster-only PDF 后，`getText` 仅得
   12 字符，`getScreenshot({ first: 2, desiredWidth: 1200, imageBuffer: true, imageDataUrl: false })`
   成功返回 1 页、1200×2597、690826 bytes；headless
   `@napi-rs/canvas` 运行正常，`<60 字符/页` 可稳定转 Vision。
2. **upload_resume 水流成立，messageId 需在同轮补接**：生产 30 天只读重放 19 条
   用户 IMAGE/FILE 简历消息，19/19 经 `produceRuleFactClaims` 产出 http
   `interview_info.upload_resume`，且原始行 19/19 有 messageId；但 RuleFactClaim 本身
   不携带 messageId。实施采用同源同轮定位：文件消息由 `session.turnId` +
   `currentUserMessage` URL 对齐，图片由 `imageUrls ↔ imageMessageIds` 对齐；历史 sessionFact
   只有 URL、无法可靠定位时按裁定降级（不产 sheet、不回写、output 照常），不合成 id。
3. **ToolsModule 当前不可直接注入 LLM**：`LlmModule` 虽导出 `LlmExecutorService`，
   `ToolModule` 未直接 import；其导入的 Memory/GroupTask 等模块也未 re-export LlmModule。
   因此实施需给 `ToolModule.imports` 增加 `LlmModule`，再由 registry 构造器注入。
4. **fflate 对生产 docx 可用**：生产两份 docx 匿名结构重放均成功 unzip 并读取
   `word/document.xml`，抽得 217/225 字；一份另含 header+footer，验证只读正文会漏页眉，
   蓝图要求的正文+header/footer 合并必须保留。
5. **Extract 可用但必须有公证通过率降级**：安全边界禁止把生产真实 PII 再发外部模型，
   故用两份假身份、同形态的乱序/顺序文本实测。Extract 首选超时后回退
   `qwen/qwen3.7-plus`：乱序样本 sourceText 逐字通过 12/12；顺序样本仅 6/20。
   结论不推翻主轨，但证实模型引用不可采信：统一公证；通过率低于 50% 时追加兜底轨，
   编造字段仍由 `quote_not_found` 丢弃。
6. **消息回写通道可复用且无需 import channels**：底层公开入口是
   `ChatSessionService.updateMessageContent(messageId, content, visualFacts?)`，同时失效短期
   Redis 窗口；图片链路外层为 4 次重试、500ms×attempt 退避。registry 注入
   messageWriteback 闭包复用同一 biz 服务与重试语义，tools 不反向依赖 channels。
7. **图片简历真实水流成立；切片阈值定为 3000px/重叠 200px**：生产 30 天只读实测
   用户图片简历实时样本 11（复扫时增至 12）条，标记 URL 11/11 可解析，10/11 与 payload
   原图 URL 同值，10/11 当时仍可下载；现有结构化 sheet 仅 5/11。可达样本最高
   2532px（高宽比 2.16），线上既有 Vision 已全部识别为简历并追加附件标记，故 ≤3000px
   走整图；>3000px 按 3000px 高切片、上下 200px 重叠后拼接。再次把真实 PII 图片发送
   给外部 Vision 被安全审查禁止，超阈值质量改由假身份 tall fixture 验收；这是验证材料
   限制，不改变图片深读主路线。

- vision 兜底有模型成本，但触发条件苛刻（30 天 5 例中的空文本子集），上限可忽略。
- 老 .doc（OLE）仍不支持，走引导话术；出现频率待观测。
- 落地位置：按执行授权在当前分支、当前工作树实施；commit 一律用 pathspec 限定本任务文件。
