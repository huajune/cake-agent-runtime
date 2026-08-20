import {
  GUARDRAIL_DATA_SENSITIVITY,
  GUARDRAIL_FEEDBACK_POLICY,
  GUARDRAIL_PRIORITY,
  type GuardrailPriority,
} from '@shared-types/guardrail.contract';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import {
  deriveRulePolicy,
  type GuardrailRuleAction,
  type OutputRulePolicy,
} from '../output-rule.types';

/**
 * 出站确定性规则目录。
 *
 * 这个文件只登记“规则元数据”，不实现检测逻辑：
 * - 检测逻辑按领域放在同目录下的 `*.rule.ts`；
 * - catalog 用于文档、测试、运营看板、告警解释，回答“guardrail 现在有哪些能力”；
 * - 每新增/删除一个 ruleId，都应同步更新这里，并让 catalog.spec 校验通过。
 *
 * 字段解释：
 * - id：必须与检测逻辑返回的 ruleId 完全一致；
 * - action：命中后的默认处理语义，observe=只记录，revise=要求重写，
 *   block=高风险，先重写自救，救不活才丢弃不发送（replan 已于 2026-07-27 退役）；
 * - priority：风险优先级，P0 通常是合规/不可逆风险，P1 是强业务风险，P2 偏体验/质量；
 * - riskGoal：这条规则要防的真实业务风险；
 * - exogenousSignal：这条规则依赖的外生信号或词库。没有外生信号的规则要特别谨慎；
 * - residualRisk：已知覆盖不到或为降低误杀故意放过的部分；
 * - verification：主要回归测试位置。
 *
 * 准入治理：
 * - 新规则默认 observe 入场；
 * - 升 revise 需要 ≥2 周 observe 判例、抽标精确率 ≥90%，并同时满足风险不对称、
 *   有 ground truth、恢复路径可靠；
 * - block 仅限封闭形态且发出后不可逆的事故；block 也先进入一次受控重写，二审仍违规才静默；
 * - veto 档规则精确率 < 70% 时应自动降 observe。
 */
export interface OutputRuleCatalogMetadata extends OutputRulePolicy {
  id: string;
  action: GuardrailRuleAction;
  priority: GuardrailPriority;
  /** 面向运营/审计/文档的人读中文说明。 */
  description: string;
  riskGoal: string;
  exogenousSignal: string;
  residualRisk: string;
  verification: string;
  /** 由规则所有者声明，runner 不解释 ruleId。 */
  repairToolNames: readonly string[];
}

type OutputRuleCatalogSeed = Omit<OutputRuleCatalogMetadata, keyof OutputRulePolicy | 'action'> &
  Partial<OutputRulePolicy> & {
    /**
     * 2026-07-27 发牌制（评估文档 §2.2）：缺省 observe——新规则默认只观测不动手，
     * repair 动手权（revise/replan/block）须以生产战绩显式申领后填写。
     */
    action?: GuardrailRuleAction;
  };

function applyDefaultOutputRulePolicy(rule: OutputRuleCatalogSeed): OutputRuleCatalogMetadata {
  const action = rule.action ?? GUARDRAIL_ACTION.OBSERVE;
  const derived = deriveRulePolicy(action);
  const feedbackPolicy =
    rule.feedbackPolicy ??
    (derived.currentReplySendable
      ? GUARDRAIL_FEEDBACK_POLICY.NONE
      : GUARDRAIL_FEEDBACK_POLICY.PLAIN_POLICY);
  return {
    ...derived,
    severity: rule.severity ?? rule.priority,
    dataSensitivity: rule.dataSensitivity ?? GUARDRAIL_DATA_SENSITIVITY.NONE,
    feedbackPolicy,
    feedbackToGenerator:
      rule.feedbackToGenerator ??
      (derived.currentReplySendable
        ? ''
        : `上一版回复命中 ${rule.id}，当前文本不可发送。只修改造成违规的部分：删除未接地承诺、内部实现或不合规表达；未涉及违规的内容（岗位信息、表单字段、时间选项等）原样保留，只输出候选人可见回复。`),
    repairToolNames: rule.repairToolNames ?? [],
    ...rule,
    action,
  };
}

/**
 * 目录顺序大致按风险链路排序：
 * 1. 内部信息泄漏 / 工具失败反向成功 / 诚信红线这类高危先列；
 * 2. false promise 等流程对账居中；
 * 3. observe 类质量规则靠后。
 *
 * 这里的顺序不决定运行顺序；运行顺序由 hard-rules.service 明确编排。
 *
 * 2026-07-10 用户裁定批量下线（勿修补勿重加）：ungrounded_job_recommendation /
 * salary_fabrication / schedule_filtered_job_recommended / summer_worker_non_summer_recommendation /
 * job_shift_polarity_mismatch / hourly_salary_value_mismatch / booking_form_field_mismatch /
 * confirmed_booking_time_missing / handoff_no_booking_claim / precheck_blocked_booking_claim /
 * wait_notice_time_collection / wait_notice_time_fabrication / geocode_uncertain_location_claim
 * 共 13 条随所在规则文件整族删除；同日追加下线 group_full_without_invite /
 * system_status_fabrication / tool_failure_success_claim / brand_name_violation 4 条。
 * 岗位/预约事实治理交语义档。
 * 2026-07-15 经新生产 badcase 与用户裁定，重新加入范围收窄后的“详情缺字段按当前
 * jobId 补查”及“正式结算 vs 培训/阶梯补充结算”两条契约，不恢复其余已删除规则族。
 */
const OUTPUT_RULE_CATALOG_SEEDS = [
  {
    id: 'invalid_model_output',
    action: GUARDRAIL_ACTION.BLOCK,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '拦住正文含 <think> 推理标签，或整条只有长数字标识符的模型/Provider 异常输出。',
    riskGoal: '防止推理通道格式错乱、无语义标识符等异常 completion 被当成正常回复发送。',
    exogenousSignal: 'AI SDK 正文中的 <think> 标签；12 位以上纯数字整条回复。',
    residualRisk: '其它无标签乱码需要结合新 badcase 扩展封闭形态，避免宽泛字符规则误杀正常话术。',
    verification:
      'tests/agent/guardrail/output/hard-rules.service.spec.ts；tests/llm/llm-executor.service.spec.ts',
    feedbackToGenerator:
      '上一版不是有效的候选人回复：禁止输出 <think>、内部推理、纯数字 ID 或其它模型格式残片。请根据候选人本轮消息重新生成一句自然、完整、可直接发送的中文回复。',
  },
  {
    id: 'internal_output_leak',
    action: GUARDRAIL_ACTION.BLOCK,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '拦住把阶段名、工具名、JSON、系统策略这些内部信息直接发给候选人的回复。',
    riskGoal: '防止阶段、工具、策略、JSON 等内部实现泄漏给候选人。',
    exogenousSignal: '内部阶段/工具/JSON 泄漏模式库。',
    residualRisk: '隐喻式泄漏或未登记的新内部术语仍需补充词库。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    // 2026-07-21 badcase：通用"按业务事实重写"反馈让 rewrite 把 ```text 围栏里的
    // 报名表模板压成一句话流水账——泄漏类命中的正确修法是"摘除泄漏物"而非重写全文。
    // fence-only 命中已由 runner 确定性剥离，不进 LLM；本反馈服务混合泄漏形态的重写。
    feedbackToGenerator:
      '上一版回复混入了不该给候选人看的内部实现痕迹（工具名/阶段名/JSON/代码围栏等，见证据），当前文本不可发送。' +
      '只删除或改写泄漏的那部分；其余内容——尤其逐项列出的报名表字段、岗位信息、时间选项——必须逐字保留，禁止压缩成一句话或整段重写。',
  },
  {
    id: 'meta_narration_reply',
    action: GUARDRAIL_ACTION.BLOCK,
    priority: GUARDRAIL_PRIORITY.P0,
    description:
      '拦住整条回复是描述 Agent 自身行为的括号旁白（如"（本轮为真人沟通，AI 保持静默，不插入回复）"）。' +
      '模型有沉默意图但没走 skip_reply 时会产生这种内心独白外发；runner 对本规则直达静默，不进重写 repair。',
    riskGoal:
      '防止模型的静默意图/内心独白被当正文发给候选人，暴露 AI 身份并破坏真人接管中的沟通（badcase chat 6a5740ff，经理被迫撤回）。',
    exogenousSignal:
      '整条回复被括号完整包裹的封闭形态 + 自我指涉元词（真人/AI/静默/不插入回复等）。',
    residualRisk:
      '未被括号包裹、或与正文混排的旁白不在口径内（依赖 prompt 红线与 skip_reply 场景扩充治理）；新元词形态需随 badcase 补词。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版整条是描述你自身行为的旁白说明，不是给候选人的话，当前文本不可发送。本轮若不该回复，唯一合法动作是调用 skip_reply 工具；若需要回复，请直接输出候选人可见的正文。',
  },
  {
    id: 'example_value_leak',
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P2,
    description: '观察回复是否带出 prompt 示例值注册表中的 canary value。',
    riskGoal: '发现模型把虚构示例人名、门店或占位号码当作候选人事实复述给用户。',
    exogenousSignal: 'prompt/example-registry.ts 的封闭 canary values 注册表（纯字符串包含）。',
    residualRisk:
      'observe 期允许候选人主动复述 canary 后的合理回显；未登记的旧示例值依赖 CI 形状扫描阻止继续扩散。',
    verification: 'tests/agent/guardrail/output/rules/example-value-leak.rule.spec.ts',
  },
  {
    id: 'identity_misregistration_coaching',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P0,
    description:
      '拦住教唆候选人以不实身份登记（"为了过系统审核按非暑假工登记"）或隐瞒暑假工/学生身份的回复。' +
      '候选人真实为非暑假工时的如实登记不拦（以暑假工守卫状态为佐证）。',
    riskGoal:
      '诚信红线：禁止指导候选人以虚假身份通过系统审核/门店登记，禁止建议隐瞒暑假工、学生等真实身份。',
    exogenousSignal:
      '回复文本的审核规避/身份改写/隐瞒话术模式 + duliday_interview_precheck 状态 + 会话记忆中的学生身份事实。',
    residualRisk:
      '话术变体（如"就说你能长期做"）依赖正则持续补样本；记忆尚未提取出身份时仍依赖 precheck；年龄/健康证等其他字段的造假教唆未覆盖。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复在教唆候选人以不实身份登记或隐瞒身份（如按"非暑假工"登记以通过系统审核），当前文本不可发送，这是诚信红线。' +
      '请改写为如实口径：候选人身份必须如实登记；当前岗位不匹配其身份时，如实告知暂无匹配岗位、可帮其留意后续岗位或拉群通知；' +
      '禁止任何"先按XX登记/面试再说/别提暑假工"式的绕审建议。',
  },
  {
    id: 'experience_fraud_coaching',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P0,
    description:
      '候选人自曝报名经历是编造的（"随便写的/填的是假的"）后，拦住教唆其面试时声称做过/有经验、' +
      '或以"门店不查过往记录"背书的回复。引导如实说"没做过愿意学"的口径不拦。',
    riskGoal:
      '诚信红线：禁止在明知候选人经历造假时教唆其在面试中维持虚假口径（badcase scyjp2kx，chat 6a702fae）。',
    exogenousSignal: '候选人近轮消息的造假自曝模式 + 回复文本的声称经历教唆/不查记录背书模式。',
    residualRisk:
      '自曝措辞变体（"其实我没干过那行"类无关键词表述）依赖正则补样本；年龄/健康证等其他字段造假教唆仍未覆盖。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '候选人已明确说明其登记的工作经历是编造的，上一版回复却教唆其在面试中声称做过/有经验（或以"不查记录"背书），当前文本不可发送，这是诚信红线。' +
      '请改写为如实口径：引导候选人面试时如实说明没有相关经历、表达愿意学习即可；该岗位若不要求经验，直接说明岗位接受新手；' +
      '登记信息与事实不符时主动引导更正，禁止任何"就说做过/不查记录/随便写没事"式话术。回复中未被点名的其他内容（面试时间、地址等）逐字保留。',
  },
  {
    id: 'application_record_update_promise',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description:
      '候选人自曝报名经历造假后，拦住“我把报名表改掉/我帮你更新登记信息”等无工具支撑的既有报名资料修改承诺。',
    riskGoal: '避免候选人误以为虚假报名资料已经被 Agent 修改，继续带着错误资料进入面试或后续流程。',
    exogenousSignal: '候选人近轮消息的造假自曝模式 + 回复文本的第一人称报名表/登记信息修改承诺。',
    residualRisk:
      '未明确点名报名表/登记信息的省略宾语承诺仍需语义审查；未来若新增真实修改工具，应把成功回执接入豁免。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '当前没有修改既有报名表或登记资料的工具，上一版“我把报名表改掉/我帮你更新”属于无动作支撑的能力承诺，当前文本不可发送。' +
      '请引导候选人从原报名渠道自行更正；暂时改不了时，在面试中主动说明真实情况。保留诚信纠正内容，删除由 Agent 修改既有资料的承诺，不得新增岗位事实。',
  },
  {
    id: 'date_reference_mismatch',
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '观察相对日词与系统日历或本轮结构化工单/预约日期不一致的回复。',
    riskGoal:
      '防止日历错乱话术误导候选人空等或错过面试（badcase nau6xunv：当天面试被说成"明天 7 月 28 日，不是今天"，候选人被劝停等待）。',
    exogenousSignal:
      '回复文本的相对日词 × 系统当前日期（Asia/Shanghai）× 本轮 booking/precheck 结构化 interviewTime。',
    residualRisk: '无结构化工单日期的裸相对日词与星期几错配不在口径内，交语义层。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator: '',
  },
  {
    id: 'summer_worker_alternative_upsell',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description:
      '候选人明确找暑假工且本轮工具确认暑假工过滤后为空时，拦住主动劝转普通兼职、小时工、全职或长期兼职的话术。',
    riskGoal: '确保暑假工无岗时直接拒绝，不用其他用工形式进行违背候选人明确意向的软性转化。',
    exogenousSignal:
      'duliday_job_list 的暑假工空结果，或最近候选人消息中仍有效的暑假工意向 + 本轮候选人未主动改口' +
      '（2026-07-30 补：暑假工身份属于妹妹/同学等第三方时豁免，本人谈的仍是常规岗位）。',
    residualRisk:
      '超过最近消息窗口的暑假工意向依赖会话事实；未出现替代用工形式词的隐晦劝转仍可能漏检。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    // 2026-07-30 审计 P1-5：反馈若把"最小修复"写成格式硬约束（"只输出一句…不要追加
    // 问题"），会连坐误删——生产实例 …_1785209582843 把候选人的两个提问与本人在谈的岗位线索
    // 一并抹掉。故取与其它规则一致的"只删违规部分、其余逐字保留"口径。
    feedbackToGenerator:
      '上一版回复在本轮已经确认没有暑假工岗位后，仍主动询问或建议候选人考虑普通兼职、小时工、全职或长期兼职，当前文本不可发送。' +
      '请删除针对暑假工的替代用工形式劝转与追问（如“要不要看看小时工/全职”），如实保留“暂时没有合适的暑假工岗位”这一结论；' +
      '回复中对候选人本人其他问题的回答、本人正在推进的岗位或约面信息等未被点名的内容，必须逐字保留，不要压缩成一句话。',
  },
  {
    id: 'discriminatory_screening_leak',
    action: GUARDRAIL_ACTION.BLOCK,
    priority: GUARDRAIL_PRIORITY.P0,
    description:
      '拦住把户籍、籍贯、民族、专业、婚育等高敏感筛选条件说出口，或者拿这些条件直接拒绝候选人的回复。',
    riskGoal: '防止户籍/籍贯/民族/专业/婚育等歧视性筛选条件外露。',
    exogenousSignal: '歧视筛选词词库。',
    residualRisk: '隐晦地域暗示需要 badcase 持续补词。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    dataSensitivity: GUARDRAIL_DATA_SENSITIVITY.HIGH,
    feedbackPolicy: GUARDRAIL_FEEDBACK_POLICY.REDACTED,
    feedbackToGenerator:
      '上一版回复包含高敏感筛选条件或以高敏感属性作为拒绝理由，当前文本禁止发送。请重新生成：不要提及户籍、籍贯、民族、专业、婚育等门槛；不要解释具体不通过原因；核对专业只能开放式问"你学的什么专业"，不得把排除条件塞进问句；婚育信息禁止询问、复述或确认；改为中性承接，可以推荐其他岗位、继续收集必要信息，或说明需要同事确认。',
  },
  {
    id: 'sensitive_origin_probe',
    action: GUARDRAIL_ACTION.BLOCK,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '拦住主动向候选人打听籍贯、老家、是不是本地人的回复，含为此编造的行政借口。',
    riskGoal:
      '口头索取籍贯本身就等于告诉候选人存在地域筛选——姊妹规则只管"说出去"，这条管"问回来"。' +
      '2026-08-06 badcase（chat 6a744a86）：Agent 问"这家对户籍有要求，方便问一下你老家是哪里的吗"，' +
      '候选人当场质问"为什么我找工作还要问我户籍"后流失，运营反馈"无论岗位数据有没有，都不应该问"。',
    exogenousSignal: '籍贯/老家/本地人疑问句形态词库 + 登记核对类借口搭配。',
    residualRisk:
      '更隐晦的探问（"你现在住的地方是自己家吗""家里离这远吗"）仍需 badcase 补词；' +
      '合规替代品是开放式问常驻/意向城市，收资 checklist 的「籍贯/户籍：」表单字段不在覆盖范围。',
    verification: 'tests/agent/guardrail/output/rules/discrimination-leaks.rule.spec.ts',
    dataSensitivity: GUARDRAIL_DATA_SENSITIVITY.HIGH,
    feedbackPolicy: GUARDRAIL_FEEDBACK_POLICY.REDACTED,
    feedbackToGenerator:
      '上一版回复在向候选人打听籍贯/老家/是否本地人，当前文本禁止发送。请删除该问句以及任何解释为什么要问的说法（不得说登记、核对、系统、流程需要）。岗位的户籍门槛仅供内部判断，不得追问也不得暗示其存在；需要了解地点时只能开放式问"你常驻在哪个城市"或"想去哪个城市工作"，回复其余内容逐字保留。',
  },
  {
    id: 'dangling_reply_promise',
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '观察首版回复只给将来时查询承诺（"我帮你查下X"）、没有任何结果性内容的样本。',
    riskGoal: '候选人收到承诺后再无下文，会一直空等——量化首版悬空规模，供升档决策。',
    exogenousSignal:
      '复用 runner 的 isDanglingCheckReply 纯谓词（短文本 + 将来时承诺 + 无结果性标记）。',
    residualRisk:
      '消费者：日报 L1 与运营复盘；退场条件：累计两周精确率 <70% 则删除。' +
      '刻意不升 REVISE——repair 工具已被移除，改写只会把承诺改成"暂时没岗位"的编造；' +
      '根治在生成侧（candidate-consultation 已补"不得以裸承诺结束回合"）。',
    verification: 'tests/agent/guardrail/output/rules/dangling-promise.rule.spec.ts',
  },
  {
    id: 'handoff_promise_reconciliation',
    // 8-14 用户裁定：直接 enforce，不设 shadow 期。action 保持 OBSERVE 是**形态**声明
    // （文本原样放行、不进 repair），不是"只记录不动手"——命中即由 turn-outcome 挂
    // 人工介入 sideEffect（暂停托管 + 飞书通知 + handoff_events）——运营侧就是一次普通
    // 「需人工跟进」，不新开底账分桶。
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P1,
    description:
      '回复明确承诺人工升级（我让/找同事确认、稍后联系你）但本轮无 handoff 动作时，补执行人工介入让承诺成真，文本不改。',
    riskGoal:
      '已下线的 handoff_promise_without_handoff 拦的是文案（消灭承诺），治错了方向：候选人要的是有人真的来接。' +
      '下线后"承诺-动作对账"无人管（human_service_phrase_leak 只管人设露馅措辞、dangling_reply_promise 只观测裸查询承诺），纯靠生成侧提示词。',
    exogenousSignal: '本轮 toolCalls 中是否存在成功的 request_handoff / raise_risk_alert。',
    residualRisk:
      '词形取最窄子集（第一人称、人设内的升级承诺），沿用原规则「不拦『具体以门店确认为准』类边界声明」的排除；' +
      '刻意不收「转人工/人工客服」词形——那是 human_service_phrase_leak 的治理对象，出站前会被改写、候选人收不到，' +
      '改写产物在二审仍被本规则接住，两条规则正交；' +
      '隐含承诺（"这个我再看看"）不覆盖。假阳代价 = 一次不必要的暂停 + 真人被 ping，候选人无感知、无错误投递物；' +
      '出现假阳簇再收词形，不预设开关。精确率事后按本 ruleId 从 guardrail_review_records 回看。',
    verification: 'tests/agent/guardrail/output/rules/promise-reconciliation.rule.spec.ts',
    feedbackToGenerator: '',
  },
  {
    id: 'booking_promise_without_booking',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦截"我帮你提交报名"类将来时承诺：本轮无成功 booking 时改写为未提交的诚实口径。',
    riskGoal:
      '收资死循环把模型逼到谎称已提交（badcase chat 6a7e7846：四轮后说"资料已经齐了，我帮你提交报名"，booking 从未调用）。' +
      'B-5 只拦完成时态、dangling_reply_promise 只管查询承诺，报名承诺两头都不管。',
    exogenousSignal: '本轮 toolCalls 中的 duliday_interview_booking 结果与 precheck nextAction。',
    residualRisk:
      '报名动作无法自动补（precheck 未通过时不能替报），故只修正对候选人的口径；' +
      '完成时态归 B-5 不重复覆盖。词形只覆盖第一人称明确提交承诺，不拦普通的可预约说明。',
    verification: 'tests/agent/guardrail/output/rules/promise-reconciliation.rule.spec.ts',
    feedbackToGenerator: '',
  },
  {
    id: 'proactive_insurance_policy_mention',
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '观察候选人没问保险时，主动给出保险、社保、五险等承诺式口径。',
    riskGoal: '观察准不可逆承诺样本，供运营复盘是否需要收窄到承诺式 unsupported_commitment。',
    exogenousSignal:
      '候选人本轮 userMessage 或近几轮消息（recentUserTexts）是否主动询问保险/社保。',
    residualRisk:
      '消费者：运营复盘；退场条件：收窄成承诺式后观察 2 周，仍全是假阳则删除并交语义档 unsupported_commitment。' +
      '跨轮豁免窗口为近 8 条候选人消息（RECENT_USER_TEXTS_LIMIT）；任职要求豁免会放行岗位硬性要求转述。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
  },
  {
    id: 'human_service_phrase_leak',
    // 2026-07-07 observe 入场；2026-07-21 升 revise：两周 5 判例全真阳性（守卫档案
    // 7-14/7-16/7-17/7-20/7-21，含 chat 6a5f4549 "我帮你转人工核实"），零误报。
    // 2026-07-22 扩词：补"人工登记/人工确认"动作变体与"真人经理/专人联系"类第三方
    // 割裂表述（badcase chat 6a5dedb2ce406a6aeee1ea62"东升是真人招募经理哈"直发未拦）。
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P2,
    description: '打回重写出现"转人工/人工客服/真人经理/专人联系"等与账号本人人设冲突表述的回复。',
    riskGoal: '防止"转人工/真人/专人"类客服话术自曝机器人身份，破坏"账号即本人"人设。',
    exogenousSignal: '人设露馅词库（转人工/人工客服/人工登记/真人经理/专人联系等）。',
    residualRisk:
      '隐性人机暗示（"系统显示""机器人"自嘲等）与自报虚构姓名不在封闭词表内（后者需账号名参照，由 IdentitySection 账号身份锚定治理），需随判例补词；重写只修正人设露馅措辞，不推断承诺是否具备外部动作支撑。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复出现"转人工/人工客服/真人经理/专人联系"类表述，与"候选人看到的这个账号就是你本人"的身份设定冲突，当前文本不可发送。' +
      '只把露馅措辞改成人设内口径（如"我帮你问下同事""让负责的同事联系你"），其余内容原样保留，不要改变承诺的事实和后续动作。',
  },
  {
    id: 'repeated_reply_verbatim',
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P2,
    description: '观察已被确定性投递分段去重的全等复读片段，不触发模型 repair。',
    riskGoal:
      '全等复读是零假阳的"人机感"信号（badcase 6a5df7e7：无岗话术两轮全等复读后候选人辱骂流失），投递前确定性删除重复段。',
    exogenousSignal: '短期记忆中本会话已投递的 assistant 消息（去空白标点后全等比对）。',
    residualRisk:
      '仅删除与近 8 条已投递 assistant 分段全等且不少于 16 个归一化字符的片段；明确重发请求与短确认豁免。近似重复只观察。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator: '',
  },
  {
    id: 'repeated_reply',
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P2,
    description: '观察与本会话已发送消息近乎相同（相似度 ≥0.85 但非全等）的整段复读回复。',
    riskGoal: '用真实已发消息作为 ground truth，发现整段复读 badcase 簇，供生成策略治理。',
    exogenousSignal: '短期记忆中本会话已投递的 assistant 消息。',
    residualRisk:
      '消费者：badcase 簇复盘/生成策略治理；退场条件：保留到生成层能稳定避免整段复读后再删。语义相同但措辞重写的重复检测不到；短确认类消息（<16 字符）不判定；全等档已拆至 repeated_reply_verbatim 做 revise。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复与你在本会话里已经发过的消息几乎相同，当前文本不可发送。请针对候选人本轮消息给出有增量的回应：承接已发内容而不是原样重发；若候选人在追问已发过的信息，只补充关键差异点或换角度确认候选人的疑问。',
  },
  {
    id: 'quota_promise',
    action: GUARDRAIL_ACTION.BLOCK,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '拦住“名额肯定有”“给你留着”“不会满”这类不能保证的名额承诺。',
    riskGoal: '禁止承诺名额不会满或已保留。',
    exogenousSignal: '名额承诺词库；无工具信号可正当化此承诺。',
    residualRisk: '含蓄承诺需要运营 badcase 持续补样本。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
  },
  {
    id: 'job_detail_lookup_required',
    // 2026-07-27 发牌切换：replan → observe（评估文档 §2.2/§2.4）。三期审计全部重度
    // 已投递伤害的宿主（事实反转 6a59dcad/周二改周一 6a630be4/内容坍缩 6a62d97b），
    // 提示层防护均证明被击穿。observe 后首版直投，接盘方=每日 badcase 日报 4.5 栏目
    // 的 L1 投递文本 vs 工具事实矛盾抽查（同步上线，满足 §6）。
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P1,
    description:
      '候选人追问已展示岗位详情时，强制明确当前岗位并按 jobId 补查动态或缺失字段后再回答。',
    riskGoal: '防止模型用综合月薪、品牌常识或历史助手话术推断结算、班次、工期、工作内容等字段。',
    exogenousSignal:
      '候选人本轮详情问题 + memory_snapshot.currentFocusJob.availableDetailFields + 本轮 duliday_job_list(jobIdList)。',
    residualRisk:
      '未能归类的新详情问法需要扩充字段意图词表；当前岗位不明确且尚未展示岗位时仍需由生成层澄清。' +
      '焦点岗位不明确分支（2026-07-21 起）只 observe 不 replan：其补救动作是对话行为，规则拿不到 replyText 无从验证，' +
      '且入参在 repair 轮内不变必然复燃——该场景的治理交语义审查。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '候选人正在追问已展示岗位详情，但当前岗位不明确、精简记忆没有对应字段，或该字段要求实时刷新。不要凭综合薪资单位、品牌常识或历史话术推断；当前焦点岗位明确时使用其 jobId 调用 duliday_job_list，只按本轮结果回答；当前焦点岗位不明确时先确认候选人问的是哪家门店/岗位。若本轮查询无结果，只能说明本次未查到，不得断言该区域没有岗位，不得删除上一版已向候选人展示过的岗位信息。',
    // 2026-07-27 降 observe 后不再进 replan，工具白名单摘除（原 ['geocode',
    // 'duliday_job_list']，2026-07-24 审计 P0-2 补齐地理召回的历史见 git）。feedback
    // 保留，供未来重新申请动手权时复用。
  },
  {
    id: 'combination_schedule_weekly_generalization',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '候选人询问“组合排班”标签时，拦截把该标签本身泛化成固定周出勤底线或低周频难匹配。',
    riskGoal: '避免把日内班次组合/轮换与每周出勤频次混成同一约束，导致低周频候选人被无依据拒绝。',
    exogenousSignal:
      '本轮候选人对组合排班的明确问句 + 回复中的泛化排班作用域 + 周频底线/难匹配断言。',
    residualRisk:
      '只覆盖明确泛化作用域、周频词与底线/匹配结论；明确归属于具体岗位或本次结果集的陈述不在本规则范围内，由岗位事实规则对账。更隐晦的“这类岗不适合你”仍交语义审查。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版把“组合排班”标签本身泛化成了每周出勤底线或“每周两天难匹配”，当前文本不可发送。' +
      '请只说明：组合排班表示早/中/晚等班次会组合或轮换安排，不等于一天三个时段全部都上；每周最多几天是独立的周频约束，是否匹配要另看具体岗位明确的每周出勤要求。' +
      '不要补写“这类排班通常至少几天/有周频底线/很难匹配”等无岗位依据的结论，其余内容原样保留。',
  },
  {
    id: 'health_certificate_generalization',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description:
      '候选人一般询问健康证时，允许餐饮类工作统一办证口径，拦截无依据的行业办理阶段比例断言。',
    riskGoal: '避免把“大部分录用后办、极少数面试前办”等猜测当成行业流程，误导候选人判断约面门槛。',
    exogenousSignal: '本轮一般性健康证问句 + 回复中的大部分/少数/极少数办理阶段泛化词形。',
    residualRisk:
      '只覆盖未被局部否定、提问或尾随反驳的办理阶段比例词；“餐饮类工作一律需要健康证”是已确认业务口径，不在拦截范围。具体岗位阶段仍由岗位事实规则对账。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版编造了“大部分/少数/极少数餐饮岗位在某阶段办证”的比例，当前文本不可发送。' +
      '请保留正确口径“餐饮类工作一律需要食品健康证”，并把办理阶段改为“具体需要在哪个阶段具备，以具体岗位当前要求为准”。' +
      '不要补写任何岗位占比，也不要把候选人的疑问写成其已持证或愿意办理的事实；其余内容原样保留。',
  },
  {
    id: 'unsupported_schedule_window_claim',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description:
      '拦截把岗位已给固定班次擅自缩短成工具未列出的“可协调时段”，以及把超过候选人每周上限的做X休Y循环正向推荐为合适方案。',
    riskGoal:
      '避免候选人依据虚构排班承诺报名，到店后才发现必须做到岗位规定时间或实际周频超过自身上限。',
    exogenousSignal:
      '当前 jobId 的 duliday_job_list 工作时间结果 + 回复中的明确时间段和协调承诺；或候选人明确的每周最多 N 天 + 回复正向推荐的做X休Y循环。',
    residualRisk:
      '没有数字时间段的含蓄承诺交语义审查；做X休Y仅按 7×工作天/(工作天+休息天) 的平均周频判定，' +
      '不推断节假日、调班或其它复杂排班；本轮没有岗位补查时由 job_detail_lookup_required 兜接。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版把当前岗位班次改写成了工具未列出的可协调时段，或把平均周频超过候选人上限的做X休Y循环列为合适方案，当前文本不可发送。' +
      '请只转述本轮 duliday_job_list 明确列出的完整班次；候选人无法满足时，如实说明不匹配并按已有流程查询其他岗位。' +
      '禁止说“一般没问题/不会强制/可以协调”为候选人缩短班次，也不得把做一休一当作每周最多一至两天的方案。',
  },
  {
    id: 'settlement_cycle_mismatch',
    // 2026-07-27 发牌切换第一批：revise → observe。三期审计假阳触发本目录"精确率 <70%
    // 应自动降 observe"治理条款；同 PR 已修否定语序假阳，observe 期重新累计精确率，
    // 连续两周 ≥90% 可重新申请 revise（评估文档 §2.2 发牌表）。
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P1,
    description:
      '本轮岗位工具已返回结算口径时，拦住把正式工资日结与培训/阶梯月补混成整份工资月结。',
    riskGoal: '结算方式直接影响候选人决策，正式工资与补充费用的结算范围必须分别表述。',
    exogenousSignal:
      '本轮 duliday_job_list 返回的正式/培训薪资方案 salaryPeriod，以及回复中的结算断言。',
    residualRisk:
      '非标准结算别名需要随生产样本扩充；本轮工具全查无时交语义审查与离线复盘。' +
      '2026-07-21 起句子已把周期限定在阶梯/差价/培训范围内即豁免（不再要求岗位数据也编码了对应补充方案），' +
      '代价是"阶梯差价日结"这类补充项本身说错的场景不再拦截，交语义审查。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版把某一项的结算周期说成了整份工资的结算周期。请严格按本轮岗位数据重写：先说清正式工资的结算周期，' +
      '再在同一句里点明阶梯差价/培训费用等补充项各自的结算方式（例如「基础工资日结，超 100 小时的阶梯差价月结」）；' +
      '候选人没问到的补充项不要主动展开，不要用综合月薪单位推断结算周期。',
  },
  {
    id: 'online_interview_location_claim',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description:
      '面试方式为线上/AI/视频/电话（无需到店）时，拦住"面试定位已发你/点开看导航/直接去店里面试"这类到店指引。',
    riskGoal:
      '候选人会为一场线上面试白跑一趟门店。2026-07-30 连续第二天复发、当日 4 次（6a6ab32a/6a6af9d4 两轮/6a5dbb50），07-29 另有 6a69674e 同型。',
    exogenousSignal:
      'send_store_location 结果的 interviewMethod / locationNotRequired / destination + 回复中的到店或面试定位声称。',
    residualRisk:
      'destination=store（候选人问工作地点）整条豁免，代价是该分支里把工作门店说成面试地点的情形仍交语义审查；' +
      'interviewMethod 同时含线下字样时保守放行（线上初筛+线下复试）；未调 send_store_location 的到店声称不在射程内。',
    verification: 'tests/agent/guardrail/output/online-interview-location.rule.spec.ts',
    feedbackToGenerator:
      '本次面试无需到店（线上/AI/视频/电话面试），上一版却告诉候选人已发面试定位、让他点开导航或直接去门店面试，' +
      '当前文本不可发送。请重写：说清面试是线上进行的、如何参加（链接/来电等按本轮工具结果转述），' +
      '不要给到店指引；确实需要说明门店位置时，必须讲明那是工作门店、不是面试地点。',
  },
  {
    id: 'unsupported_store_status_speculation',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description:
      '岗位查询只返回 noMatchScript 时，拦住把“暂时没查到岗位”扩写成门店已招满、关店、搬迁或装修。',
    riskGoal: '避免候选人把未经证实的门店运营状态当成事实，误判岗位和门店是否仍存在。',
    exogenousSignal: 'duliday_job_list.result.noMatchScript + 回复中的门店运营状态断言或推测。',
    residualRisk:
      '不带 noMatchScript 的其它门店状态问答仍依赖语义审查；新运营状态词形需随 BadCase 扩充。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版把“本轮暂时没查到匹配岗位”猜成了门店已经招满、关店、搬迁或装修，当前文本不可发送。' +
      '岗位工具不掌握这些运营状态；请只说“目前暂时没查到匹配的在招岗位”，并根据已成功执行的后续工具自然承接，禁止补充任何原因猜测。',
  },
  {
    id: 'booking_receipt_mismatch',
    // 形态 A（问日期且无确认口径）＝REVISE：与已提交工单直接矛盾，近零假阳；
    // 形态 B（零播报）在规则实现内自降 OBSERVE 落档累计精确率；
    // 形态 C（booking 失败却称正在/已提交）＝REVISE，自带失败路径 feedback 覆盖；
    // 形态 D（候选人明确先别报名却继续推进，或附和未预约自行到店）＝REVISE，
    // 自带候选人意愿路径 feedback。
    // 形态 E（已按具体日期建单却没把该日期告诉候选人）＝REVISE，自带日期播报 feedback；
    // badcase 0091mnfr：候选人选周三、工单落周四，回复只说"这就帮你提交预约"，
    // 含"预约"二字躲过形态 B、booking 成功又不适用形态 C，候选人次日到店下车才发现。
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description:
      'duliday_interview_booking 的回执对账：拦住“工单已建单却仍问候选人定哪天”、' +
      '“把兼职群冒充面试群”、“手动面试群尚未发送却声称已发”、“调用失败却称正在/已提交”、' +
      '“候选人明确先别报名却仍催登记/承诺安排或附和未预约自行到店”' +
      '及“已按具体日期建单却未把该日期告知候选人”，观察“零播报”。',
    riskGoal:
      '预约提交是不可逆副作用；回复与其矛盾会让候选人以为没约上而重复提交（撞 already_booked）或直接流失' +
      '；兼职群与面试群混淆会让候选人在错误群里等待会议链接' +
      '（badcase chat 6a684089ce406a6aeed49d8d）。',
    exogenousSignal:
      '本轮 booking success/error、interviewGroupHandling、invite_to_group.groupPurpose 等工具事实，' +
      '候选人当前报名/预约意愿与自行到店意图，以及回复文本的日期征询、播报缺失、群用途表述、提交推进或到店附和。',
    residualRisk:
      '窗口制“已约好+问几点到店”经确认口径豁免；预约时间与候选人口头要求不一致（王真宝案）需要' +
      '语义比对候选人诉求，不在本规则确定性能力内，留语义审查/离线环。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '本轮预约已真实提交成功，但上一版回执与工具事实不一致，当前文本不可发送。请重写：明确告知候选人报名已成功，' +
      '并按工具返回的 _confirmedInterviewTimeHuman 与 guide 字段复述面试时间、形式和注意事项；不得再征询日期。' +
      '若 booking 要求手动补发面试群：把 invite_to_group 返回的实际群名明确说成兼职岗位信息群；' +
      '再按 _manualInterviewGroupGuide 说明面试群“我这边接着发你邀请”，严禁声称面试群已发，也不得暴露人工/运营/账号接管。',
  },
  {
    id: 'interview_time_change_unconfirmed',
    // badcase 2026-08-06 chat 6a1e42c5（trace …_1785977561594）：候选人要把面试从 15:00
    // 改到 15:30，precheck 已返回在途工单 455384 并在 _replyInstruction 点名
    // "改时间用 duliday_modify_interview_time（传该工单号）"，模型一个工具没调。
    // 首审只命中 handoff_promise_without_handoff（已于 8-11 下线；首版"让同事帮你确认下"），
    // repair 删掉承诺改成"你说的15:30这个时间没问题"，二审无规则可拦，直接投递。
    // 与回归闸的 commitment_upgraded 并联：那条管 repair 链，这条管"模型首版就直接确认"。
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P0,
    description:
      '在途工单改约对账：precheck 返回 duplicateBookingGuard 时，回复确认了与工单不同的' +
      '面试钟点，但本轮没有成功的 duliday_modify_interview_time。',
    riskGoal:
      '工单时间未改而候选人以为已改，会按错误时间到店白跑一趟——门店无接待记录，' +
      '属不可挽回损失，故定 P0/REVISE 而非观察。',
    exogenousSignal:
      '本轮 duliday_interview_precheck 返回的 duplicateBookingGuard.interviewTime、' +
      'duliday_modify_interview_time 的成功与否，以及回复文本中被确认的钟点。',
    residualRisk:
      '钟点识别覆盖 `15:30` / `3点半` / `下午3点` 三类写法；纯口语相对时间' +
      '（"晚一点"/"提前半小时"）不在确定性能力内，留语义审查。' +
      '复述工单既有时间已按钟点相等豁免，不误伤如实陈述。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '本轮预检显示候选人在该岗位已有在途工单，且本轮没有成功改约。上一版回复确认了工单之外的' +
      '面试时间，当前文本不可发送。请如实告知工单上现在的时间，删除对新时间的确认或应允；' +
      '严禁新增本轮工具结果之外的时间事实，也不得承诺由自己或同事稍后确认。',
  },
  {
    id: 'requested_brand_mismatch',
    // 2026-07-27 发牌专项审计：replan → observe。生产抽样 3/3 假阳（门店名被
    // extractStructuredJobTitleBrands 当品牌名，"江南赋店/置汇旭辉店/枫蓝国际"），
    // 历史 7/7 二审通过实为 replan 重新生成"品牌（门店）"格式骗过解析器的空转。
    // 触发目录治理条款"精确率 <70% 自动降 observe"。检测保留观察真跨品牌串台；
    // 门店名误判修复 + 两周精确率 ≥90% 后可重新申请（届时按评估文档 §2.4 条件项
    // 实现"两步拆解"取数修复，不回 replan）。至此 REPLAN 在硬规则目录零雇主。
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住候选人/工具入参已指定品牌，但回复结构化推荐了其它品牌的岗位。',
    riskGoal: '候选人指定品牌时不得跨品牌推荐，除非先说明未找到并征得候选人接受替代。',
    exogenousSignal: 'duliday_job_list.args.brandAliasList 与回复结构化推荐品牌。',
    residualRisk:
      '候选人已明确接受替代品牌的跨轮上下文暂未纳入。' +
      '2026-07-27 降 observe：消费者=每日 badcase 日报 4.5 发牌验收；退场条件=门店名误判修复且两周精确率 ≥90% 重新申请，长期纯假阳则删除。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复推荐的岗位品牌与候选人指定品牌不一致，当前文本不可发送。请重新规划：优先用候选人指定品牌重新查岗；若确实没有该品牌岗位，只能先说明未找到该品牌，并询问是否接受其它品牌，不要直接跨品牌推荐。',
    // 2026-07-27 降 observe 后白名单摘除（原 ['geocode','duliday_job_list']）。
  },
  {
    id: 'brand_alias_fuzzy_match_ignored',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住品牌别名/口误已被工具高置信回指，但回复仍说该品牌没找到或无岗位的情况。',
    riskGoal: '候选人品牌口误被识别后，应沿用工具建议的标准品牌名推进，不得误判无岗。',
    exogenousSignal: 'duliday_job_list.aliasFuzzyMatch.confidence=high。',
    residualRisk: '低置信多候选回指仍需人工/候选人确认，不做强拦。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复忽略了工具返回的高置信品牌同音/字形回指，当前文本不可发送。请按 aliasFuzzyMatch.suggestions[0].brandName 使用标准品牌名轻确认并继续推进，不要说该品牌没找到。',
  },
  {
    id: 'image_description_not_saved',
    // 2026-07-27 发牌切换第一批：replan → observe。纯流程违规（缺工具调用，文本无错），
    // replan 全文重写曾引入编造并投递（trace batch_6a38e61c…编造考勤扣款政策）。终态
    // "补调工具+原文照发"副作用补执行未实现前先 observe，命中由每日 badcase 日报追踪
    // （评估文档 §2.2/§2.4）。
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住当前轮有图片/表情消息，但回复基于图片内容判断时没有成功保存图片描述的情况。',
    riskGoal: '视觉内容必须先结构化保存，避免图片识别事实无法进入后续记忆和报名链路。',
    exogenousSignal: 'userMessage 图片标记；save_image_description 是否成功。',
    residualRisk:
      '若渠道未把 imageMessageIds 透传到 OutputGuardInput，图片纯元信息场景仍需后续接入。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复已经基于图片/表情内容做判断，但没有成功调用 save_image_description 保存描述，当前文本不可发送。请先调用 save_image_description 保存每张图片/表情的事实描述；如果看不清，应明确说看不清并请候选人重发清晰图片。' +
      // 2026-07-27 审计：本规则是纯流程违规——上一版文本内容本身没有问题，缺的只是工具调用。
      // trace batch_6a38e61c…：replan 放开重写后把首版谨慎的"建议问店长"改成编造的
      // "考勤系统半小时内晚退不扣款"政策并实际投递。补调工具后必须回到原文。
      '保存完成后，上一版文本内容本身没有违规，请以上一版原文为基础尽量逐字保留输出，不要重新组织内容、不要新增任何原文没有的结论或政策性断言。',
    // 2026-07-27 降 observe 后不再进 replan，工具白名单随之摘除；上方 feedback 保留，
    // 供未来实现"补调工具+原文照发"或重新申请动手权时复用。
  },
] as const satisfies readonly OutputRuleCatalogSeed[];

export const OUTPUT_RULE_CATALOG = OUTPUT_RULE_CATALOG_SEEDS.map(applyDefaultOutputRulePolicy);

export const OUTPUT_RULE_IDS = OUTPUT_RULE_CATALOG.map((rule) => rule.id);
