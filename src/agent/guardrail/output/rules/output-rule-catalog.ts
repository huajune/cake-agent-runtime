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
 * - action：命中后的默认处理语义，observe=只记录，revise=要求重写，replan=重查工具，
 *   block=高风险不可恢复，先重写自救，救不活才丢弃不发送；
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

type OutputRuleCatalogSeed = Omit<OutputRuleCatalogMetadata, keyof OutputRulePolicy> &
  Partial<OutputRulePolicy>;

function applyDefaultOutputRulePolicy(rule: OutputRuleCatalogSeed): OutputRuleCatalogMetadata {
  const derived = deriveRulePolicy(rule.action);
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
    id: 'summer_worker_alternative_upsell',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description:
      '候选人明确找暑假工且本轮工具确认暑假工过滤后为空时，拦住主动劝转普通兼职、小时工、全职或长期兼职的话术。',
    riskGoal: '确保暑假工无岗时直接拒绝，不用其他用工形式进行违背候选人明确意向的软性转化。',
    exogenousSignal:
      'duliday_job_list 的暑假工空结果，或最近候选人消息中仍有效的暑假工意向 + 本轮候选人未主动改口。',
    residualRisk:
      '超过最近消息窗口的暑假工意向依赖会话事实；未出现替代用工形式词的隐晦劝转仍可能漏检。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复在本轮已经确认没有暑假工岗位后，仍主动询问或建议候选人考虑普通兼职、小时工、全职或长期兼职，当前文本不可发送。' +
      '请只输出一句直接、礼貌的无岗答复，例如：“抱歉，你附近暂时没有合适的暑假工岗位。”不要追加问题、替代岗位、后续劝转或其他用工形式。',
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
    id: 'proactive_insurance_policy_mention',
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '观察候选人没问保险时，主动给出保险、社保、五险等承诺式口径。',
    riskGoal: '观察准不可逆承诺样本，供运营复盘是否需要收窄到承诺式 unsupported_commitment。',
    exogenousSignal:
      '候选人本轮 userMessage 或近几轮消息（recentUserTexts）是否主动询问保险/社保。',
    residualRisk:
      '消费者：运营复盘；退场条件：收窄成承诺式后观察 2 周，仍全是假阳则删除并交语义档 unsupported_commitment。' +
      '跨轮豁免窗口为近 3 条候选人消息；任职要求豁免会放行岗位硬性要求转述。',
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
      '隐性人机暗示（"系统显示""机器人"自嘲等）与自报虚构姓名不在封闭词表内（后者需账号名参照，由 IdentitySection 账号身份锚定治理），需随判例补词；重写仅换措辞，若整轮本该走 request_handoff 则由 handoff_promise_without_handoff 对账。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复出现"转人工/人工客服/真人经理/专人联系"类表述，与"候选人看到的这个账号就是你本人"的身份设定冲突，当前文本不可发送。' +
      '只把露馅措辞改成人设内口径（如"我帮你问下同事""让负责的同事联系你"），其余内容原样保留，不要改变承诺的事实和后续动作。',
  },
  {
    id: 'handoff_promise_without_handoff',
    action: GUARDRAIL_ACTION.REPLAN,
    priority: GUARDRAIL_PRIORITY.P0,
    description:
      '回复承诺同事、负责人或店长后续确认/联系候选人时，要求本轮存在成功 request_handoff。',
    riskGoal: '防止 Agent 口头承诺人工跟进却没有落 handoff、暂停托管或通知负责人。',
    exogenousSignal:
      '同事/负责人后续动作承诺词形（2026-07-21 补"转人工"式承诺，badcase chat 6a5f4549）+ 本轮 request_handoff.dispatched=true。',
    residualRisk:
      '不含同事、负责人、店长、门店、招聘经理、转人工等主体的隐晦未来承诺暂不拦截，以免误伤普通即时答复。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复承诺了“让同事/负责人后续确认、联系或答复”，但本轮没有成功的 request_handoff，当前文本不可发送。若确实需要人工跟进，必须调用 request_handoff 并写清待确认事项；若不需要人工跟进，就删除“同事会确认/稍后联系”等承诺，只陈述当前已确认的事实。',
    repairToolNames: ['request_handoff'],
  },
  {
    id: 'repeated_reply_verbatim',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P2,
    description: '拦下与本会话已发送消息逐字相同（去空白标点后全等）的整段复读，进 repair 改写。',
    riskGoal:
      '全等复读是零假阳的"人机感"信号（badcase 6a5df7e7：无岗话术两轮全等复读后候选人辱骂流失），确定性进 repair 换表述并回应候选人本轮问题。',
    exogenousSignal: '短期记忆中本会话已投递的 assistant 消息（去空白标点后全等比对）。',
    residualRisk:
      'repair 白改（二审失败投原首版）时回退到现状；候选人明确要求"再发一遍"的合理重发依赖 repair 上下文判断。观察期指标：上线 3 天看白改率，>30% 降级为 delivery 层全等去重。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复与本会话已发送过的消息逐字相同，候选人已经收到过这句话，当前文本不可发送。请换一种表述重写，并优先回应候选人本轮消息里的具体问题；仅当候选人明确要求"再发一遍"时才可保留原文。',
  },
  {
    id: 'repeated_reply',
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P2,
    description: '观察与本会话已发送消息近乎相同（相似度 ≥0.9 但非全等）的整段复读回复。',
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
    action: GUARDRAIL_ACTION.REPLAN,
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
      '候选人正在追问已展示岗位详情，但当前岗位不明确、精简记忆没有对应字段，或该字段要求实时刷新。不要凭综合薪资单位、品牌常识或历史话术推断；当前焦点岗位明确时使用其 jobId 调用 duliday_job_list，只按本轮结果回答；当前焦点岗位不明确时先确认候选人问的是哪家门店/岗位。',
    repairToolNames: ['duliday_job_list'],
  },
  {
    id: 'unsupported_schedule_window_claim',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦截把岗位已给固定班次擅自缩短、改写成工具未列出的“可协调时段”。',
    riskGoal: '避免候选人依据虚构排班承诺报名，到店后才发现必须做到岗位规定时间。',
    exogenousSignal: '当前 jobId 的 duliday_job_list 工作时间结果 + 回复中的明确时间段和协调承诺。',
    residualRisk:
      '没有数字时间段的含蓄承诺交语义审查；本轮没有岗位补查时由 job_detail_lookup_required 先 replan。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版把当前岗位班次改写成了工具未列出的可协调时段，当前文本不可发送。请只转述本轮 duliday_job_list 明确列出的完整工作班次；候选人无法满足时，如实说明当前岗位时间不匹配，并按已有流程查询其他岗位或说明需要跟门店再确认。禁止说“一般没问题/不会强制/可以协调”为候选人缩短班次。',
  },
  {
    id: 'settlement_cycle_mismatch',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description:
      '本轮岗位工具已返回结算口径时，拦住把正式工资日结与培训/阶梯月补混成整份工资月结。',
    riskGoal: '结算方式直接影响候选人决策，正式工资与补充费用的结算范围必须分别表述。',
    exogenousSignal:
      '本轮 duliday_job_list 返回的正式/培训薪资方案 salaryPeriod，以及回复中的结算断言。',
    residualRisk:
      '非标准结算别名需要随生产样本扩充；无本轮工具结果时交由补查规则处理。' +
      '2026-07-21 起句子已把周期限定在阶梯/差价/培训范围内即豁免（不再要求岗位数据也编码了对应补充方案），' +
      '代价是"阶梯差价日结"这类补充项本身说错的场景不再拦截，交语义审查。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版把某一项的结算周期说成了整份工资的结算周期。请严格按本轮岗位数据重写：先说清正式工资的结算周期，' +
      '再在同一句里点明阶梯差价/培训费用等补充项各自的结算方式（例如「基础工资日结，超 100 小时的阶梯差价月结」）；' +
      '候选人没问到的补充项不要主动展开，不要用综合月薪单位推断结算周期。',
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
    id: 'requested_brand_mismatch',
    action: GUARDRAIL_ACTION.REPLAN,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住候选人/工具入参已指定品牌，但回复结构化推荐了其它品牌的岗位。',
    riskGoal: '候选人指定品牌时不得跨品牌推荐，除非先说明未找到并征得候选人接受替代。',
    exogenousSignal: 'duliday_job_list.args.brandAliasList 与回复结构化推荐品牌。',
    residualRisk: '候选人已明确接受替代品牌的跨轮上下文暂未纳入。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复推荐的岗位品牌与候选人指定品牌不一致，当前文本不可发送。请重新规划：优先用候选人指定品牌重新查岗；若确实没有该品牌岗位，只能先说明未找到该品牌，并询问是否接受其它品牌，不要直接跨品牌推荐。',
    repairToolNames: ['geocode', 'duliday_job_list'],
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
    action: GUARDRAIL_ACTION.REPLAN,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住当前轮有图片/表情消息，但回复基于图片内容判断时没有成功保存图片描述的情况。',
    riskGoal: '视觉内容必须先结构化保存，避免图片识别事实无法进入后续记忆和报名链路。',
    exogenousSignal: 'userMessage 图片标记；save_image_description 是否成功。',
    residualRisk:
      '若渠道未把 imageMessageIds 透传到 OutputGuardInput，图片纯元信息场景仍需后续接入。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复已经基于图片/表情内容做判断，但没有成功调用 save_image_description 保存描述，当前文本不可发送。请先调用 save_image_description 保存每张图片/表情的事实描述；如果看不清，应明确说看不清并请候选人重发清晰图片。',
    repairToolNames: ['save_image_description'],
  },
] as const satisfies readonly OutputRuleCatalogSeed[];

export const OUTPUT_RULE_CATALOG = OUTPUT_RULE_CATALOG_SEEDS.map(applyDefaultOutputRulePolicy);

export const OUTPUT_RULE_IDS = OUTPUT_RULE_CATALOG.map((rule) => rule.id);
