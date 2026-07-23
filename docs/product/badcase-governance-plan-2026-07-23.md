# BadCase 未解决池根因分析与治理方案（2026-07-23）

> 状态：**待审核**
> 数据快照：2026-07-23 拉取飞书 BadCase 表全量 3,748 条，未解决（状态 ≠ 已解决）3,329 条
> 发版基线：v10.25.0（已上生产，develop 与 master 内容一致）
> 证据库：生产 Supabase（`uvmbxcilpteaiizplcyp`），所有根因均附 chatId / messageId / 表名

---

## 1. 未解决池全貌

未解决的 3,329 条不是 3,329 个问题，而是三个性质完全不同的群体：

| 群体 | 数量 | 性质 | 处置思路 |
|---|---|---|---|
| 守卫拦截自动转写存量 | ≈3,140 | 7/2–7/16 语义评审 enforce 拦截判例 + 确定性规则命中被批量写成 BadCase，7/17 后已停写，全部"待分析" | 批量归档（§5 D9） |
| 4–5 月人工 triage 高优存量 | 64 | P0×5、P1×13 及"处理中/待验证"，全部卡在验证收口 | 跑验证批次收口（§5 D10） |
| 7/17–7/23 运营新提交 | 30 | 全部"待分析"，反映当前生产活跃问题 | 根因分析主体（§2） |

**存量群体不需要逐条分析**：3,140 条备注有统一签名（`【enforce，已拦截/打回】`、`resultCount=7 但 jobs=[]`），对应两类已修复的已知误拦（语义评审误读 markdown 岗位列表 72eacd66、group_promise 首日假阳 2eddfcf5），且**均为已拦截、未发给候选人**的回复。写入源（守卫拦截 → `/test-suite/feedback` 批量转写）已停止。

---

## 2. 根因分析（活跃问题，按严重度排序)

### 根因 1【P0】抽取提示词示例身份回声 → 臆造档案入记忆 → 编造手机号提交真实预约

约 8 条表面不相关的 badcase 是同一条根因链的不同截面。

**证据链**：

1. **源头**：chat `6a60856cce406a6aeef4bbad`（枫叶不是鱼，北京昌平，只说过"昌平区北七家镇"）的 `message_processing_records.memory_snapshot`，session facts 在 2026-07-22T08:58:17.329Z 一瞬间被写入另一人完整档案（"小付"/15521899062/男 178cm/上海迪士尼保安/已约龙湖闵行星悦荟店），20 个字段 evidence 逐字相同。该手机号与"小付"在全量 `chat_messages` 中不存在——是抽取 few-shot 示例被 LLM 整包回声输出。
2. **用户可见症状**：Agent 对这位北京新候选人说"之前约的上海闵行店离你太远了，那个预约我先帮你取消掉"（badcase 6e9ar9gd"不同招募经理的会话怎么串了"）。
3. **"沿用"洗白放大**：chat `6a60856bce406a6aeef48421`（陈佩珊，东莞）候选人全程只给过姓名/位置/时间偏好，booking args 却带全套编造字段（手机 15921708092/23 岁/165cm/大专/安徽户籍），evidence 写"此前已确认的……均沿用"。Agent 判定"资料都齐了"，**拿编造手机号提交了真实预约网关**。
4. **唯一拦截点及其死锁**：`duliday_interview_booking` 连续 5 次 error"姓名疑似打招呼语昵称"。候选人明确确认（"是的"→"就是陈佩珊"→发身份证照片）**都无法解锁溯源状态**，Agent 重复索名 4 遍。

**归入此簇**：6e9ar9gd、g4ytra23、v7ggyht8、2iin80oe（"张三"正是提示词示例值）、2g84if39、inkj52yt、86hv85a2、pm2ivers（部分）。

**发版核对（v10.25.0，已上生产）**：
- ✅ 源头已修：`placeholder-identity.ts` 运行时回声拦截（挂 `session.service` validateOutput）+ 抽取提示词大改（删光示例值"张三/13800138000/肯德基服务员4个多月/安徽"，新增"宁缺毋假"最高红线，phone 改"没出现就省略"）
- ❌ 仍开缺口：见 §4 残留项 A2/A3/B4

### 根因 2【P1】"转人工"明确请求无确定性通道 + 无岗承接复读（Aron. 辱骂升级案）

chat `6a5df7e7ce406a6aee043595`（7/20 18:26–18:34，8 分钟从加好友到辱骂流失）：

| 时间 | 事件 |
|---|---|
| 18:26 | 加好友，报"沈阳和平长白"，自述老转化用户（"以前入职海底捞就是从 boss 加的独立客微信"） |
| 18:27:59 turn | job_list（沈阳全城）empty → `invite_to_group` error **`invite.no_group_in_city`** → 按工具 `_replyInstruction` 回复"沈阳这边暂时没有合适的岗位，后续有匹配我会主动联系你" |
| 18:30 | 追问"那除了必胜客还有其他在招么" |
| 18:30:43 turn | job_list（和平区，brandFilterMode: clear）empty → 同样 no_group error → **一字不差复读同一句**，未回应"其他品牌"问题 |
| 18:31 | 发"转人工[强]" → **无任何确定性响应**，进 debounce |
| 18:32–18:34 | "我不是假期工 长期工"→"说话跟人机一样 傻B吧"→"滚" |
| 18:34 | 合并 turn 触发 `raise_risk_alert(abuse)` → 托管暂停 + 飞书告警 |

**四层根因**：
1. 供给死区（沈阳 0 岗 0 群）的脚本化收口被逐字执行两遍——`_replyInstruction` 指示"礼貌告知暂无岗位、不提群、不转人工、保持托管"，没有内容梯度；
2. `repeated-reply.rule.ts` 去标点全等必然命中，但分档 **observe** 只观察不拦截；
3. `risk-intercept.service.ts` 词表只有辱骂/投诉/面试结果三类，**"转人工/找人工/真人"不在任何确定性清单**——候选人礼貌要人工得到 3 分钟静默，骂"滚"（命中 ABUSE_KEYWORDS）才触发暂停。**系统实际教会候选人：骂人才能叫来真人**。`handoff_events` 该会话 0 行；
4. 运营层：Boss 在沈阳仍在引流，但平台沈阳零库存零群组——渠道与供给不对账。

本案是原"根因 4 无岗承接体验"簇（4c94j4f7 / z3spgc07 / a4si5r95 / g4ytra23）的最严重升级实例，证明该簇可升级到辱骂流失+人工介入，建议整簇 P2 → P1。**本案目前不在 BadCase 表中**（告警链路与反馈链路是两条线），需补录。

### 根因 3【P1】工单取消的方向性双错

- j8ed80tk（7-23）"面试都面完了，居然还取消工单"——7-21 放宽放弃语义后出现过度取消；
- m5rvlmwm（7-21）"应该取消工单的"——漏取消仍在；
- 根因 1 连带：Agent 试图取消的"上海闵行店预约"本身是回声臆造的——取消动作未锚定真实工单证据。

`duliday-cancel-work-order.tool.ts` 仅在 description 提示"已面试通过 → handoff"，**无工单实时状态的确定性硬拒**。

### 根因 4【P1】带外工单信息开场披露 + 状态口径无据

chat `6a5ee65bce406a6aee1e77bb`（来米，7-21）：刚加好友，Agent 第一句"是来确认奥乐齐那边面试安排的吗，看到你报了银都店的兼职，还在等门店确认排期"。候选人在别处报的名（badcase t9bszhx8），"等排期"状态口径系杜撰（pm2ivers）。案发时点工单上下文注入 prompt 后无披露策略。

**已闭环（v10.25.0）**：b4f2eeb2"预约上下文补面试时间并约束跨顾问披露口径"（随 #651 发版）已落地——`formatBookingContext` 现含披露约束（"仅当候选人主动问起、或主动要求改约/取消时才可提及；不得使用『我看到你报了…』口径"）+ 面试时间字段渲染（杜绝"等排期"脑补，注释直接引用 badcase pm2ivers）。用户 2026-07-23 裁定"不要主动提"，与已上线口径一致。遗留动作仅剩：对源 badcase t9bszhx8 / pm2ivers 跑复测后回写"已解决"。

### 根因 6【P0，双面投诉】电话面试岗被发到店脚本，候选人未等电话直接到店

岗位 39518（必胜客-沈阳新玛特/桃源里，面试方式=电话面试，"面试官先电话沟通，合适的会通知线下门店面试"）。chat `6a608ad4ce406a6aee8fbbac`（刘宪宇）与 `6a607170ce406a6aee5d8f87`（王宏宇），7-22 报名、7-23 事发，客户与候选人双面投诉。

**失败链**（两会话模式一致）：
1. booking 成功后工具输出 `_onSiteScript`（"到店跟前台/店长说独立客介绍来的…"）+ 门店地址——**与同轮的"面试官会先电话沟通"自相矛盾**，候选人采信更具体可执行的到店指引；
2. 候选人追问"10 点是提前到还是 10-12 点"时，Agent 完全用到店叙事回答（"时间段内到店就行，路上注意安全"）；
3. 7-23 8:00 复聊提醒话术含混（"按之前通知的要求参加"——而"之前通知"里有两套矛盾指引）；
4. 候选人 10:37 报"我到了哈"，Agent 顺口再发到店指引，2 分钟后才改口"面试官会先电话沟通"→ 候选人："啊？我都到点了还电话"。

**根因定位**（`message_processing_records` 工具流水实证）：防线 `isOnlineInterview` 早已存在（v10.24.0 起在产，覆盖字面"电话面试"），但本案两个缺口叠加：
- 岗位的面试方式字段未流入 `resolveInterviewType`（booking result 的 `requestInfo.interviewType` 为 undefined）；
- 兜底 freeText（`interviewRemark`，precheck 侧同源字段即 `processRemark`）里明明有"面试官先电话沟通"原文，但 `ONLINE_INTERVIEW_SIGNAL_PATTERN` 只认字面"电话面试"，"先电话沟通"漏网 → 保守兜底走到店脚本。

**修复（已随 PR #684 分支提交）**：① 正则补强电话初面信号（电话初面/电话初试/先电话沟通/电话沟通后/先电话联系；不收"保持电话畅通/会电话联系"防误伤 keciu6u6 回归）；② `_onlineInterviewGuide` 改为兼容两段式（"初始环节不需到店 + 接到电话/通知前不要自行去门店"，禁发地址）。**遗留**：复聊提醒模板不带面试形式（归入 PR-2/复聊侧）；候选人报"到了"时的纠偏敏感度（模型行为，观察修复后是否仍现）；interviewType 字段未下发的海绵侧排查。

### 根因 5【P2】口径类散点

- umkgixpq / aqv35lhw：岗位经验要求被说成"无要求"（筛选条件呈现）
- b4echyzh：今天下午的面试说成明天下午；oo83ez03：AI 面试可提前做的规则口径
- zmuhev8o："聋哑人不需要"类硬性要求的话术边界需复核
- rulkoast / 1ptrzpwk：人名识别成品牌、"在做麦当劳"当"要找麦当劳"（品牌解析长尾）

---

## 3. v10.25.0 发版核对结论

> 方法：按内容验证（`git grep <特征串> v10.25.0`），SHA merge-base 判定在 release squash 下全是假阴性。

**已发版**（可从待办划掉）：
- 示例回声拦截全套（placeholder-identity + 提示词示例值清除 + 宁缺毋假红线），PR #660 含 #662/#651
- 半径无岗不再口播全城无岗（工具层 forbiddenActions）、年龄 hard_reject 岗默认不推荐、品牌边缘误判两处、拉群 errcode=-12 按成功处理
- **B6 带外工单披露策略**（b4f2eeb2，随 #651）：跨顾问预约"候选人不提不主动说"约束 + 面试时间字段渲染杜绝"等排期"脑补——与用户 7-23 裁定口径一致，无需再做

**未修**（进入 §4/§5 方案）：A2、A3、B4、B5、B8、C9 及全部 D 项。

---

## 4. 解决方案矩阵

### A 级：立即（本周）

| # | 方案 | 层 | 说明 |
|---|---|---|---|
| A2 | **存量 Redis facts 污染清洗** | memory/data | 回声拦截只防新增。写一次性脚本按回声签名（占位手机号、示例姓名+经历组合、同毫秒整包写入+evidence 雷同）定位并清除污染字段；受害会话至少 `6a60856c`/`6a60856b`。**先 dry-run 出清单人工过目再执行**。facts 是唯一事实源、无 DB 备份，脚本要幂等且只删不改 |
| A3 | **booking 姓名闸门解锁路径** | tools | `evaluateBookingNameGate` 现状：`parseName` 只认"姓名：X/我叫X"，`isFromAutoGreeting` 是存在性判断 → 昵称=真名的候选人答"就是X/是的/发身份证"永远 reject，死循环必复现。修：①明确确认句式（"就是X/是的，全名就是X"）计入权威出处；②身份证图片 OCR 姓名一致 → allow；③同题最多问 1 次，二次失败转 handoff |
| B8 | **"主动转人工"确定性通道** | guardrail/input | 给 `risk-intercept.service.ts` 增加人工请求词表（转人工/找人工/人工客服/要真人等），命中走既有 `conversation_risk` 短路链路：**确定性静默 + 暂停 + 告警**（与 abuse 拦截同款行为），不进 debounce。**出站侧一个字都不发**——人设是真人招募经理，接管发生在同一企微账号上，候选人对切换无感知；任何"帮你转人工/叫真人"话术反而是唯一会暴露 AI 身份的环节，违反人设红线。告警文案中提示经理尽快接手首句自然承接（如"刚在忙，你说"） |

### B 级：短期（1–2 周）

| # | 方案 | 层 | 说明 |
|---|---|---|---|
| B4 | phone 提交溯源守卫 + "沿用"来源审计 | tools/memory | booking 提交层手机号必须能追溯到候选人亲口发送的消息（正则可验），否则 precheck 判 missing；抽取"沿用"须携带字段首次提取轮次 |
| B5 | 取消工单前置核验 | tools | cancel 执行前查工单实时状态，已面试/已完成硬拒；取消对象必须来自本会话 booking 真实返回，不接受纯记忆来源 |
| ~~B6~~ | ~~带外工单披露策略~~ | ✅ 已落地 | 用户 7-23 裁定"不主动提"；v10.25.0 的 b4f2eeb2 已按同口径上线（见 §2 根因 4），仅剩源 badcase 复测回写 |
| B7 | 无岗承接话术内容梯度 | tools/prompt | 同会话第二次无岗必须换话术：说明覆盖范围（"平台在沈阳暂时没有合作的在招岗位"）、正面回应候选人点名品牌、承接老用户背景；`noMatchScript` 生成时带"本会话第 N 次无岗"状态 |

### C 级：中期

| # | 方案 | 层 | 说明 |
|---|---|---|---|
| C9 | repeated_reply 全等档升级 enforce | guardrail/output | 去标点全等复读是零假阳场景，确定性改写/加变体；相似度 0.9 档维持 observe |
| C10 | 口径类散点回归测试 | test-suite | 岗位经验/时间/AI 面试规则口径，从本轮 badcase 策展 5–8 条原子 case 进正式测试集 |

### D 级：池治理与运营

| # | 方案 | 说明 |
|---|---|---|
| D9 | **批量归档 3,140 条自动转写存量**：按"来源=AgentTest + 分类 semantic_review:/规则名前缀 + 时间 ≤7/16"过滤，状态批量置"已解决"，修复说明统一写"守卫拦截判例存档，对应误拦修复 72eacd66/2eddfcf5，未外发候选人"。归档前按 reason_code 各抽 10 条人工复核（shadow 精度 ~80%，真阳主类薪资编造单独挑出）。**共享资产批量变更，需用户确认口径后执行** |
| D10 | 收口 4–5 月 64 条高优存量：P0×5/P1×13 多数对应已上线修复（真名校验/拉群协议/案底硬拒），跑验证批次推进到"已解决"或退回"处理中" |
| D11 | 删除测试占位记录 y3dzymr3（PR619 回归联调残留） |
| D12 | 停止守卫拦截自动转写 BadCase（如未来重开）：拦截判例已有 `guardrail_review_records` 全档案，样本池只进人工反馈 |
| D13 | **引流-供给对账**（运营）：Boss 投放城市 vs 岗位库存城市 vs 群覆盖城市三张清单对账；沈阳类"零岗零群仍在拉新"冷区要么停投、要么配专用承接话术 |
| D14 | Aron. 案补录 BadCase 表（分类 11-情绪/话术，P1，chatId `6a5df7e7ce406a6aee043595`），与无岗承接簇建立关联 |

---

## 5. 待裁定问题

1. **A2/A3/B8 是否按此优先级开做**？A2 清洗脚本先测试库演练 + dry-run 清单过目。
2. **D9 批量归档 3,140 条**的口径与抽样复核量需确认后执行。
3. ~~B6 披露策略~~ 已裁定（不主动提）且 v10.25.0 已按同口径上线，闭环。
4. **B8 的产品边界**：候选人说"转人工"即断托管是否过于激进？注意出站话术**没有讨论空间**——人设红线禁止任何暗示 AI/转接的表述，唯一合规行为是静默暂停（同 abuse 拦截现行设计），由真人经理用同一账号无缝接续。真正需要裁定的只有两点：①词表边界——"转人工"字面词几乎零误伤可直接收；"找人工/人工客服"等泛化词是否收，需权衡误触发率（误触发的代价只是提前转真人，不暴露身份，代价可控）；②静默期 SLA——暂停后到经理接手前候选人处于无响应状态，告警需带催办与超时升级，避免复刻本案"3 分钟静默"。

---

## 6. 实施计划（2026-07-23 制定，A2/A3/B8 优先已确认）

工作项打包为 2 个代码 PR + 2 个脚本任务 + 1 个测试收口 + 1 个运营任务，可并行推进。

### PR-1「booking 身份链路解锁 + 转人工确定性通道」（A3 + B4 + B5 + B8）｜Day 1–3

**A3 姓名闸门解锁**（`src/tools/shared/precheck-core.ts`、`src/memory/facts/name-guard.ts`、`src/tools/shared/candidate-field-parser.ts`）：

1. 新增 `isNameConfirmedInDialogue(name, messages)`：识别"assistant 提问句含该姓名 + 全名/真实姓名/对吧 → 下一条 user 为肯定答复（是的/对/嗯/没错）或『就是X』"的对话对，计入权威出处（需要 assistant 上下文，现有 `extractUserTexts` 只取 user 文本，函数签名要扩）
2. `parseName` 增加"就是X"直陈句式
3. 身份证图片证据：vision 描述以 user 消息落历史（`[图片消息] 身份证图片：姓名XX…`），增加容错匹配（"身份证…姓名X"无冒号分隔形态），OCR 姓名与提交姓名一致 → allow
4. 同题限问：booking 姓名闸门 reject 前扫最近 assistant 消息，索要"真实姓名"已 ≥2 次 → `_replyInstruction` 改为指示 `request_handoff`，杜绝 4 连问
5. 单测必须复刻陈佩珊案完整时序（打招呼昵称=真名 → "是的" → "就是X" → 身份证照片）

**B4 phone 溯源守卫**（同域文件 + booking/precheck 接线）：新增 `evaluateBookingPhoneGate`——提交的手机号必须在剥离引用块后的 user 原文中出现（11 位号码 substring 匹配），否则按 missing_fields 指示向候选人索要。陈佩珊案的编造号 15921708092 这类非示例值靠这条兜住。

**B5 取消前置核验**（`src/tools/duliday-cancel-work-order.tool.ts`）：执行前 `getWorkOrderById` 实时状态；`interviewPassTime` 存在或状态 ∈ {面试通过/已入职/已完成} → 硬拒并指示先向候选人核实、异常走 handoff；同时校验 work_order_id 必须属于本会话 `[当前预约信息]` 渲染过的工单集（provenance，防臆造工单被"取消"）。

**B8 转人工确定性通道**（`src/types/guardrail.contract.ts`、`src/agent/guardrail/input/risk-intercept.service.ts`）：

1. `INPUT_RISK_TYPE` 增 `HUMAN_HANDOFF_REQUEST: 'human_handoff_request'`
2. 词表第一期只收高置信短语：转人工 / 找人工 / 人工客服 / 叫人工；**误伤防护**：仅当消息剥离标点表情后较短（≤6 字）或整句命中模板才判——"人工客服岗位还招吗"这类岗位咨询必须放行
3. 命中走既有 `conversation_risk` 短路：确定性静默 + 暂停 + 告警，**出站零话术**（人设红线）；告警文案附"候选人在等待，请尽快用同一账号自然接续（首句如『刚在忙，你说』）"
4. 单测复刻 Aron 案"转人工[强]"时序

**验收**：单测全绿 + test-suite 跑陈佩珊/Aron 两条策展 case + booking 现有回归不破。

### PR-2「无岗承接体验」（B7 + C9）｜下周

- **C9**（`repeated-reply.rule.ts`）：去标点全等档 observe → enforce，产出改写 directive"换一种表述并回应候选人本轮新问题"；0.9 相似度档维持 observe。**风险开关**：repair 有白改前科（守卫修复版二审失败会投原首版），合入后观察 3 天白改率，>30% 则改为 delivery 层全等去重方案。
- **B7**（`duliday-job-list` noMatchScript）：生成 candidateMessage 前读短期记忆最近 8 条已发 assistant 消息，若与本次 canned 话术全等 → 切二档话术（说明"平台在{城市}暂时没有合作的在招岗位"+ 回应候选人点名品牌 + 留资承接），工具层确定性完成，不依赖模型自觉。

### S1「A2 存量污染清洗脚本」｜Day 1–5 并行

- **双介质**：Redis `factsv2:{corpId}:{userId}:{sessionId}` hash（唯一事实源，无备份，只删不改）+ Supabase `agent_long_term_memories.profile_facts`（经 settlement 沉淀的污染按 originSessionId 血缘回溯）
- **命中签名**：① evidence 含旧示例证据串（"用户通过Boss直聘转发了一条肯德基服务员的岗位标题…"）；② 值命中已删示例集（15521899062 / 13800138000 / 张三 / 小付 / 上海迪士尼乐园保安 / 龙湖闵行星悦荟店…）；③ 同 extractedAt 毫秒整包多字段写入且 evidence 雷同
- **二次校验**：interview_info.phone 的值在该会话 `chat_messages` 原文中不存在 → 判臆造
- **流程**：test 库演练 → prod **dry-run 输出清单（chatId / 字段 / 值 / 命中签名）交用户过目** → 分批限速执行 HDEL → 复扫为 0 → 删除动作留审计日志
- 已知受害会话 `6a60856c` / `6a60856b` 作为清洗正确性的锚点样本

### S2「D9 批量归档 + D14 补录 + D11 清理」｜Day 4–5，抽样过目后执行

1. 按 reason_code 分层各抽 10 条人工复核（job_recommendation_not_best_supported / active_booking_state_conflict / brand_or_geo_ambiguity_ignored / job_detail_lookup_required / district_level_distance_claim / group_promise…），真阳（薪资编造类为主）单独挑出转"处理中"
2. 抽样结论交用户过目后，bitable 批量置"已解决"，修复说明统一模板（引用 72eacd66 / 2eddfcf5，注明未外发候选人），限速分批
3. D14：Aron 案补录（P1 / 11-情绪/话术 / chatId `6a5df7e7ce406a6aee043595`）；D11：删 y3dzymr3

### T1「测试与收口」（C10 + D10）｜PR-1 合入后

- C10 策展 ~10 条 scenarioCases 入正式测试集：姓名确认解锁 ×3、phone 溯源 ×2、取消方向 ×2、转人工静默 ×1、无岗二档话术 ×2（决策时刻锚点按 skill 闸门执行）
- D10：64 条 4–5 月高优存量分两批跑验证批次，按 SOP 回写测试集/验证集/源 BadCase 状态；含 B6 的源 badcase t9bszhx8 / pm2ivers 复测回写

### O1「D13 引流-供给对账」（运营协同）

- 数据侧交付：近 30 天 `job_list empty` + `invite.no_group_in_city` 按 geocode 城市聚合的"冷区接客榜"（含会话量），生产 SQL 产出
- Boss 投放城市清单需运营提供，拼"投放 × 库存 × 群覆盖"三张对照表；沈阳类冷区给停投/换承接话术建议

### 时序总览

| 时间 | 动作 |
|---|---|
| Day 1–2 | PR-1 编码+单测；S1 test 库演练 |
| Day 3 | PR-1 提测合入；S1 prod dry-run 清单交付 |
| Day 4–5 | S1 执行+复扫；S2 抽样交付→归档；T1 策展 |
| 下周 | PR-2；D10 两批验证；O1 榜单交付 |

### 风险与回滚

- PR-1 全部为工具/守卫层确定性改动，逐条独立可回滚；B8 误触发的代价仅是提前转真人、不暴露身份
- C9 依赖 repair 改写有效率，设 3 天观察期与白改率阈值，超限降级 delivery 去重
- S1 只删不改、幂等、带审计日志；执行前有 dry-run 人工闸门
- S2 批量状态变更前有分层抽样人工闸门

---

## 附：证据索引

| 结论 | 证据位置 |
|---|---|
| 示例回声整包写入 | `message_processing_records.memory_snapshot`，chat `6a60856c`，extractedAt 2026-07-22T08:58:17.329Z |
| 回声值不存在于任何会话 | `chat_messages` 全量检索 15521899062/"小付" 0 命中 |
| "沿用"洗白 | chat `6a60856b` 的 memory_snapshot evidence："此前已确认的……均沿用" |
| 编造手机号提交预约 | 同 chat `tool_calls`：booking args phone=15921708092（候选人从未提供） |
| 姓名闸门 5 连拒 | 同 chat booking result："姓名疑似打招呼语昵称"×5 |
| 沈阳无群 | chat `6a5df7e7` tool result：`invite.no_group_in_city` ×2 |
| 转人工无通道 | `risk-intercept.service.ts` 词表清单；`handoff_events` 该会话 0 行 |
| repeated_reply 只观察 | `repeated-reply.rule.ts` 注释"本层只观察" |
| 发版状态 | `git grep` 内容验证 v10.25.0 tag；develop 与 master src diff 为空 |
