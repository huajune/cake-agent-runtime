# 执行清单 2026-08-17（交接给执行 Agent）

> **2026-08-17 终版裁定（化零为整）**：任务 A（简历 v4）已由 GPT 完成；
> **B/B2/B3/C/B4 全部撤编，不再单独执行**——统一整合进「收资表单状态机」
> （label-driven-collection-refactor.md §2.8，采信专项余项→状态机部件的映射表在彼处），
> 随统一契约落地的重启批一次实施。R1 独立 chip 已撤销。
> 以下任务描述保留作历史底稿与状态机实施时的细节参考，**不作为独立派工依据**。
>
> 背景与完整设计见三份权威文档：
> `docs/todo/resume-tool-overhaul.md`（简历工具 v4，已实施）、
> `docs/todo/confidence-admission-review.md`（采信专项诊断档案）、
> `docs/todo/label-driven-collection-refactor.md`（**主蓝图**：标签制+表单状态机）。

## 0. 全局纪律（动手前必读）

1. **Node 版本**：shell 默认 node 可能是 16，先 `nvm use 22.16.0`。
2. **跑测试**：`pnpm run test <spec路径> --watchman=false`——**不要**在 pnpm 后加 `--`
   （字面 `--` 会原样传给 Jest 使 watchman 参数失效）；不带 watchman 参数会静默 0 测试。
3. **并发会话**：本工作树有多个 AI 会话并发改码，当前 ~79 个未提交改动文件**大多不是你的**。
   - commit **必须用 pathspec 限定自己创建/修改的文件**，严禁 `git add -A`；
   - 发现 stash 或他人改动**勿动**；
   - 特别红线：`src/tools/duliday/precheck/checklist.util.ts`、
     `src/tools/duliday-interview-precheck.tool.ts`、
     `src/tools/duliday/booking/interview-booking-customer-label.builder.ts`
     压着他人未提交成果（9-1 归一层），任务 A/B 均不需要碰它们。
4. **分支**：默认分支 develop（没有 main）；新工作分支自 develop 拉。pre-push 钩子跑全量
   CI 需 5+ 分钟，可自跑 `pnpm run ci:check` 后 `--no-verify`。
5. **测试资产禁真实 PII**：候选人 fixtures 一律用测试假身份**兮兮 / 18271421690**；
   生产真实姓名/手机号（如"杨美英/152…"）不得进仓库。
6. 代码规范：严格 TS 禁 any；禁 console.log（用 NestJS Logger）；DI 不手动 new；
   文件 kebab-case。提交信息 Conventional Commits。
7. 完成每项任务后：更新对应设计文档的状态行（一行即可），并在任务分支跑通
   `pnpm run lint:check && pnpm run typecheck && pnpm run test`。
8. **动任何文件前先 `git status --short <file>`**：若该文件已有非本任务产生的改动，
   停手上报，不得混改混提。

---

## 任务 A：简历工具 v4 重写（独立，可立即开工）

权威 spec：`docs/todo/resume-tool-overhaul.md`（v4 全文照做）。要点浓缩：

**架构**：`read-resume-attachment.tool.ts` 只留 I/O；新增
`src/tools/resume/{docx-text,resume-text,resume-extract,scanned-resume}.util.ts`；
`src/resolution/candidate/resume-fields.ts`（公证+兜底，纯函数零 LLM）。

**三层技术路线**：
- 主轨：`ModelRole.Extract` structured output，文本 → `{field, value, sourceText}[]`
  （LLM 调用留 tools 层，resolution 层零 LLM——eslint 分层规则强制）；
- 公证（resolution 纯函数）：①sourceText 必须是规整后原文的字面子串，失败丢整字段；
  value 须可由 sourceText 确定性推出；②形态校验复用既有解析器
  （`parsePhone`+占位剔除 / `isLikelyRealChineseName` / `normalizeEducationToId`）；
  ③phone 归属：sourceText ±15 字含「紧急联系人/推荐人/HR/店长」剔除，多号全列
  `phoneCandidates` 主值降 medium；④模型自报置信一概不采信，置信度由代码按
  「字段×证据形态」授予（label 锚定 high / 自由位置 medium / 简历 phone 封顶 medium）；
- 兜底轨（Extract 失败时）：姓名三级（`姓名：`标签 → 文件名剥
  「(个人|求职)?简历|resume|cv」后 2~4 汉字严格真名校验 → phone/「N岁」锚点邻行）+
  `parseHighestEducation`（education.ts 新增：按既有 EDUCATION_KEYWORDS 表序取最高，
  **不带**聊天语境的学校守卫——简历必提学校，现 parseEducation 的守卫会全拒）。

**字段集**：name/phone/gender/age/education/email + expectedCity/jobIntent/
expectedSalary/workYears/relevantExperience（餐饮相关经历摘录 ≤120 字）。

**格式分发（四容器一漏斗）**：`%PDF-`→pdf-parse v2（文字层过薄判据 <60 字符/页 即转
vision，防混合 PDF 静默漏正文）；`PK\x03\x04`→docx（**新依赖 fflate**，
`word/document.xml` + `header*.xml`/`footer*.xml`）；`FF D8 FF`/`89 50 4E 47`
（JPEG/PNG）→**长图简历支线**：Vision 逐行转写（超长图切片+重叠拼接，阈值按 spike ⑦）
→ 同一条主轨，置信度按 vision_transcription 封顶 medium；与被动图片描述链路分工
（那边自动环境摘要、这边按需深读带公证）；OLE `\xD0\xCF\x11\xE0`→新 errorType
`read_resume.unsupported_format` 引导转 PDF/拍照；`not_pdf` 语义收窄为"都不是"。

**闸门**：删除 `resumeRequired !== true` 拒读分支及 `READ_RESUME_NOT_REQUIRED`
错误类型（确认无外部引用后）；上传行为不归本工具管。

**回档（v3 裁定，署名如实）**：解析成功产 `FinalizedVisualFactSheet(kind='resume')`
经 `context.ledger.recordVisualFacts(sheet, {messageId})` 入账（fields 只填白名单键，
ownership 按 kind 规则补齐）；**必做承重件**：把简历摘要回写进该条 `[文件消息]` 的
chat_messages content（复用 image-description 一族 updateMessageContent/
appendResumeAttachmentLine 机制及其重试）——身份字段唯一的跨轮通道是会话窗口，
ledger sheet 的 rawDescription 抽取器不读（session-extraction.prompt.ts:229 实证）。
**严禁**把简历字段以 `source:'system'` 写 sessionFacts（虚假署名，已裁定否决）。
messageId 定位不到→降级为只出 output 不产 sheet 不回写（warn），禁合成 id。

**扫描件兜底（P2）**：EMPTY_TEXT 分支 → `getScreenshot({first:2, desiredWidth:1200,
imageBuffer:true})` → `ModelRole.Vision` 逐行转写 → 进同一条主轨；仅 text 为空触发，
失败回落现有 errorType，output 标 `sourceKind:'vision_transcription'`。
依赖注入：`buildReadResumeAttachmentTool(attachments, deps:{llm})`，registry 构造器
注入 LlmExecutorService。

**text 裁剪**：裁「主修课程/自我评价/获奖/证书」超长段；maxChars 默认 6000→3000；
档案块前置作为兜底轨/回写摘要的规整小函数（主轨对乱序免疫，不需要它）。

**先关 7 个 spike 再写码**（resume-tool-overhaul.md §10 + §3.5）：
①getScreenshot 本机 headless 渲染扫描件可行性；②upload_resume 规则事实携带
messageId（或 URL 回查）可靠性；③LlmExecutorService 在 ToolsModule 的 DI 可达性；
④fflate 对真实 docx 的抽取质量；⑤Extract 模型对简历文本的结构化质量与 sourceText
逐字忠实度（公证通过率为主轨可用性判据，不达标走兜底轨降级开关）；
⑥消息回写通道：查 save_image_description 的描述如何落 chat_messages content，
复用同一 biz/message 底层通道（禁 import channels，必要时小幅下沉）；
⑦【最高优先】图片简历道两问：简历图 URL 是否确实流入 upload_resume（须实证非假设）+
Vision 超长图转写质量与切片阈值（拿生产真实长图测）。
——优先级依据（2026-08-17 生产实测，30 天 n=18）：容器分布为图片 61% ＞ PDF 28% ＞
docx 11% ＞ 老 .doc 0，**图片是第一大简历容器**；且识别为简历的 11 张图仅 5 张有
结构化 sheet，现有覆盖仅半。图片道是本任务的主战场，不是附属支线。

**实现蓝图**（类型/函数签名/execute 流程/实现顺序）：resume-tool-overhaul.md **§3.5**，
照写；纯函数地基（resume-fields.ts + parseHighestEducation）先行并单测全覆盖，
再往上盖格式层→主轨→工具重组→sheet/回写。

**测试与验收**：假身份 fixtures（PDF/docx 各一，含一份模拟乱序 PDF）；公证规则全分支
单测（回查失败→重锚→丢字段三段路径：唯一锚定采纳/多锚点拒/零锚点拒、形态校验/
占位剔除/置信授予/phone 归属/兜底切换）；
mock Extract 喂**编造字段样本**验证公证拦截；验收=两条实证 case 形态重放：
「杨美英式」单页乱序 PDF 必须抽出 name 且带出处、docx 必须成功返回文本
（fixtures 用假身份复刻形态，不用真实数据）。

---

## 任务 B：R1 confirm 作证通道修复（独立，可与 A 并行）

背景：`confidence-admission-review.md` §4.2 R1/R2 与 §4.3。已定谳缺陷：
precheck（duliday-interview-precheck.tool.ts:150、:358）与 booking（:607）的工具描述
指示模型「候选人对确认问句作答用 operation=confirm，另附 agentQuestionQuote」，但
`CandidateClaimInputSchema`（src/resolution/evidence/claim.types.ts:229-241）**没有
agentQuestionQuote 键**（zod 静默丢弃），`produceModelClaims`
（src/resolution/evidence/producers/model-claims.ts:25-35）把 interpretation 写死
`'direct'`。导致 notary 两条 context_confirmation 豁免（notary.ts:54-57 出处基准换
问句、:96-102 短语境豁免）是生产不可达死代码；候选人裸答「有/是的」的确认对
age/education/healthCert/height/weight/householdProvince/isStudent 七字段结构性失效
（minContext=3 判 quote_too_short，连同问句引则 quote_not_found，双重绑定）。
生产 14 天实测 confirm claim 出现率 0/359。

**修法**（改动限 `src/resolution/evidence/` + 测试）：
1. `CandidateClaimInputSchema` 加可选 `agentQuestionQuote`（带 describe，长度上限对齐
   quote 的 200）；
2. `produceModelClaims` 透传：operation=confirm 且 agentQuestionQuote 非空时
   interpretation='context_confirmation'、evidence 带 agentQuestionQuote；
3. 补 `operation:'confirm'` 全链路测试（当前全仓零覆盖）：裸答「有」+问句 → notary
   以问句为出处基准、短语境豁免生效 → accepted；无问句的 confirm 维持现行为；
   问句伪造（问句不在 assistant 消息中）的负例——注意 notary 现有验证边界，
   如问句真伪当前不验，测试如实固化现状并注释留痕，勿自行扩权；
4. shadow/enforce 双模式行为一致性（裁决本体不分模式，消费才分）。

**不要**顺手改 precheck/booking 工具文件（描述已写对，且压着他人未提交改动）。
完成后更新 confidence-admission-review.md 的 R1/R2 行与
candidate-fact-authority-refactor.md 的 D2 状态行（后者标注「schema 通道已实修」）。
注：R2（裸答双重绑定）随本任务的豁免通道激活一并消解，无需单独任务。

---

## 任务 B2：sessionFacts 上下文确认升级通道（独立，可与 A/B 并行）

采信专项 P0-3（confidence-admission-review.md §5 提案）。病灶（铁证 A，chat 6a826e8a
7 分钟同题三轮）：sessionFacts 的 medium→high 升级判据要求「quote 能确定性复算出值」
（session.service.ts `applyExtractionProvenance` → policies.ts
`extractionQuoteSupportsCurrentValue`:104-127）——候选人答「可以/对的」复算不出任何值，
**上下文确认在数学上不可能升级置信度**，prefill hint 永驻、逐轮重挂「（如有误请改）」。

**修法**（memory 域 + policies）：为确认场景增设升级判据分支——满足全部条件才升级：
① 候选人本轮消息为肯定应答形态（复用 resolution/signal/dialogue 既有肯定词表，
不新造词表——词表收拢纪律）；② 紧邻的上一条 assistant 消息含该字段的复述
（「字段名：值」或「值…对吧/可以吗」形态，值与当前 medium 值一致）；③ 升级后
source 记 'candidate_quote'（候选人确认即亲证）、evidence 记「确认问答：<问句摘录>
+<应答>」——**署名如实，禁止记成 system**。phone 维持永久锁 medium 的现行纪律不变。
出生日期/年龄等推导值不走此通道（只有被完整复述过的值才可确认升级）。

**测试**：确认升级正例（复述+「对的」→high）；负例：无复述的裸「对的」不升级、
复述值与 medium 值不一致不升级、隔了多轮的确认不升级、phone 不升级；
铁证 A 形态重放（假身份）：「没有健康证」→登记确认→「可以」后健康证 hint 不再重挂。
动 session.service.ts 前按 §0-8 查占用。

---

## 任务 B3：R10 假阳复现定位（独立侦查任务，可并行）

采信专项 R10：候选人**逐字写过**的 quote（「姓名（真名）：宋子瑜」，chat 6a827105
turn 276571，原文实证在 chat_messages 2026-08-17 02:37:56 那条）仍被 notary 拒
`no_candidate_evidence`——72.3% 假阳家族复发，且是确认循环的点火器。

**做法**：离线复现——用该 chat 的消息序列（从生产 chat_messages 拉原文，**测试代码里
换假身份复刻形态**）构造输入喂 `runCandidateFactAdjudication`
（src/resolution/evidence/adjudicate.ts），定位 quote 逐字在场却回查失败的环节。
候选嫌疑（逐一排除）：①`extractCandidateTextsFromCorpus` 的语料窗口/合并截断；
②corpusBlocks 缺失时 fallback 路径的语料差异（precheck:959-961）；③NFKC/空白折叠
不对称；④消息时间戳后缀剥离时序（历史同族：v10.13.0 被 `[消息发送时间：…]` 后缀
击穿）。产出：根因诊断写进 confidence-admission-review.md R10 行；若修复 ≤30 行且
限 resolution/evidence 域则一并修+测试，否则只交诊断不动码。

---

## 任务 B4（低优先，可选）：复问→流失因果对照

采信专项 B 线残项：答后复问会话（45 例口径见 confidence-admission-review.md §2.5）
与同漏斗深度对照组的完单率差异。纯生产只读 SQL（遵守：每条
`SET LOCAL statement_timeout` + 严格串行 + message_processing_records 用 received_at）。
产出数字写进专项文档 §2.5。不阻塞任何其他任务，闲时做。

---

## 任务 C：R9 shadow 措辞去指令化（**前置条件：9-1 改动已提交后才可动**）

precheck shadow 回执 note 现文案含行动指令（"不要当已确认资料复述或提交；向候选人
确认后重新提交"），模型服从 → shadow 期产生确认循环，违反"只观测零行为变化"契约
（confidence-admission-review.md R9，铁证 C ②）。修法：shadow 模式下回执不下达任何
行动指令——rejectedClaims 降级为纯观测数据或不下发给模型；enforce 文案不变。
改动点在 duliday-interview-precheck.tool.ts 的 factAdjudication note 组装处。
**该文件当前压着 9-1 未提交改动，必须等其入库后再动**；动前 `git status` 确认干净。

---

## D. 明确禁止执行的事项（防好心帮倒忙）

1. **R12 语义桥**（有无本地健康证→健康证状态机互填）：**已撤销**，勿实现——
   根因由海绵标签制接口在源头消灭。
2. **R11 确认循环熔断、enforce 切换（P1）**：与标签制改造强耦合（同改收资核），
   已裁定并入标签制重启批，勿单独实现。
3. **标签制收资改造**：挂起等海绵统一契约接口，勿动 precheck 收资核、勿写
   batchQueryInterviewLabels 客户端。
4. **9-1 归一层三文件**（§0-3 红线清单）：勿改勿提交。
5. 勿 drop 任何 stash；勿动 `.env.*`；勿跑写生产的脚本。
6. 简历字段勿以 `source:'system'` 入 sessionFacts（虚假署名，用户明确否决）。

## E. 执行顺序建议

1. A / B / B2 / B3 文件集互不相交，可各开自 develop 的分支并行
   （A：tools/resume + resolution/candidate + registry；B：resolution/evidence schema 侧；
   B2：memory/session.service + policies；B3：只读复现 + 至多 evidence 域小修）；
2. A 先跑 5 个 spike 并把结论记进 resume-tool-overhaul.md §10，再动码；
3. B 完成后可顺手核对 chip task_e46c8322（同一事项，避免重复领工）；
   B 与 B3 同域（resolution/evidence），若同人执行建议 B → B3 顺序做避免自相冲突；
4. C 等 9-1 提交，完成 A/B 后再看时机；B4 闲时做；
5. 一切合并目标 develop，发版由用户统一操作，**不要自行触发 release 流程**。

## F. 采信专项任务映射总览（对照 confidence-admission-review.md）

| 专项条目 | 本清单归属 |
|---|---|
| R1 confirm 作证通道 | 任务 B（立即） |
| R2 裸答双重绑定 | 随 B 消解 |
| P0-3 sessionFacts 确认升级 | 任务 B2（立即） |
| R10 假阳复现 | 任务 B3（立即，侦查优先） |
| R9 shadow 措辞 | 任务 C（等 9-1 提交） |
| B 线因果对照残项 | 任务 B4（低优先） |
| R12 语义桥 | 已撤销，禁做（D-1） |
| R11 熔断 / R3 / R6 / R7 / enforce 切换 | 并入标签制重启批，禁单独做（D-2） |
| P0-2 健康证族确认识别 | 并入标签制重启批（健康证标签适配器承接），禁单独做 |
