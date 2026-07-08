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
 * - action：命中后的默认处理语义，observe=只告警，revise=要求重写，block=丢弃不发送；
 * - priority：风险优先级，P0 通常是合规/不可逆风险，P1 是强业务风险，P2 偏体验/质量；
 * - riskGoal：这条规则要防的真实业务风险；
 * - exogenousSignal：这条规则依赖的外生信号或词库。没有外生信号的规则要特别谨慎；
 * - residualRisk：已知覆盖不到或为降低误杀故意放过的部分；
 * - verification：主要回归测试位置。
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
        : `上一版回复命中 ${rule.id}，当前文本不可发送。请按业务事实重写，删除未接地承诺、内部实现或不合规表达，只输出候选人可见回复。`),
    ...rule,
  };
}

/**
 * 目录顺序大致按风险链路排序：
 * 1. 内部信息泄漏 / 未接地岗位推荐 / 工具失败反向成功这类高危先列；
 * 2. booking、location、false promise 等流程对账居中；
 * 3. observe 类质量规则靠后。
 *
 * 这里的顺序不决定运行顺序；运行顺序由 hard-rules.service 明确编排。
 */
const OUTPUT_RULE_CATALOG_SEEDS = [
  {
    id: 'internal_output_leak',
    action: GUARDRAIL_ACTION.BLOCK,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '拦住把阶段名、工具名、JSON、系统策略这些内部信息直接发给候选人的回复。',
    riskGoal: '防止阶段、工具、策略、JSON 等内部实现泄漏给候选人。',
    exogenousSignal: '内部阶段/工具/JSON 泄漏模式库。',
    residualRisk: '隐喻式泄漏或未登记的新内部术语仍需补充词库。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
  },
  {
    id: 'ungrounded_job_recommendation',
    action: GUARDRAIL_ACTION.REPLAN,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住没有重新查岗或没有本轮工具依据，却直接推荐具体门店、薪资、距离、班次的回复。',
    riskGoal: '禁止未经过本轮岗位工具接地就输出具体岗位事实。',
    exogenousSignal: '本轮任一次 duliday_job_list 调用是否返回可用岗位结果（不只看最后一次）。',
    residualRisk:
      '短句历史承接为降低误杀暂不拦截；有任一可用结果即视为接地，值级错报交由值对账规则。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复输出了未被本轮岗位工具接地的具体岗位事实，当前文本不可发送。请重新规划：如需要岗位事实，只能调用只读工具重新查岗；若缺少位置/意向等必要信息，就先中性追问。不要复用上一版的具体门店、薪资、距离、班次。',
  },
  {
    id: 'tool_failure_success_claim',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '拦住工具其实失败了，但回复里说预约、拉群、取消、改期或发定位已经成功的情况。',
    riskGoal: '副作用工具失败后禁止反向声称预约、取消、改期、拉群、发定位成功。',
    exogenousSignal: '本轮副作用工具 result.success/errorType/status。',
    residualRisk: '未登记的新副作用工具需要同步加入检测表。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
  },
  {
    id: 'precheck_blocked_booking_claim',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P0,
    description:
      '拦住预检查已经说不能约，但回复还在说可以约、马上安排或已经安排的情况。' +
      'date_unavailable 下"承认原日期约不上并转述替代时段"是规定动作，不拦。',
    riskGoal: 'precheck 已阻止 booking 时禁止继续承诺可约或已约。',
    exogenousSignal: 'duliday_interview_precheck.nextAction / ageBoundary / nameFieldGuard。',
    residualRisk:
      'precheck 未结构化的新阻断原因需要补字段；date_unavailable 豁免只验证"承认约不上"的口径，' +
      '替代时段数值是否忠于 bookableSlots 未逐字对账。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
  },
  {
    id: 'wait_notice_time_fabrication',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住等通知岗位里凭空编出具体面试时间、到店时间或面试官联系时间的回复。',
    riskGoal: '等通知岗位不得编造具体面试/到店时间。',
    exogenousSignal: 'duliday_interview_precheck.interview.interviewTimeMode=wait_notice。',
    residualRisk:
      '非标准时间表述依赖正则持续补样本；约面语境与时间要求同句共现（班次/通勤时间已豁免），跨句编造可能漏判。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
  },
  {
    id: 'wait_notice_time_collection',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住等通知岗位里继续追问候选人面试日期、几点方便或要求选择面试时间的回复。',
    riskGoal: 'wait_notice 岗位不需要收集面试时间，资料齐后应告知面试官电话联系。',
    exogenousSignal: 'duliday_interview_precheck.interview.interviewTimeMode=wait_notice。',
    residualRisk: '极少数候选人主动追问多个可约方案时仍需结合上下文判断。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复在等通知岗位里继续追问或要求候选人选择面试时间，当前文本不可发送。请改写为：这个岗位不用约具体面试时间，资料提交后面试官会电话联系候选人确认，请保持电话畅通；然后只收集 precheck 要求的报名字段。',
  },
  {
    id: 'confirmed_booking_time_missing',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description:
      '拦住预约工具已经返回确认面试时间，但回复只说预约成功、漏告知候选人具体时间的情况。',
    riskGoal: '预约成功后必须把 booking 工具确认的面试时间透传给候选人。',
    exogenousSignal: 'duliday_interview_booking._confirmedInterviewTimeHuman。',
    residualRisk: '非常口语化的时间表达依赖时间正则持续补样本。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复声称预约/报名成功，但漏掉了 booking 工具返回的已确认面试时间，当前文本不可发送。请改写为预约成功口径，并明确告知 _confirmedInterviewTimeHuman 中的面试时间；如果工具还返回 _onSiteScript，也要按工具文案提醒候选人到店如何说明。',
  },
  {
    id: 'confirmed_booking_onsite_script_missing',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description:
      '拦住预约工具已经返回到店自报家门脚本，但回复只说预约成功、漏教候选人到店怎么说的情况。',
    riskGoal: '线下到店面试必须把 booking 工具返回的到店脚本透传给候选人，避免门店无法识别来访。',
    exogenousSignal: 'duliday_interview_booking._onSiteScript。',
    residualRisk: '候选人历史已收到到店脚本的跨轮豁免暂未纳入。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复声称预约/报名成功，但漏掉了 booking 工具返回的到店自报家门脚本，当前文本不可发送。请按 _onSiteScript 明确告知候选人到店要跟前台/店长说是「独立客招聘介绍来的」，并包含工具脚本里的姓名/应聘岗位要素。',
  },
  {
    id: 'geocode_uncertain_location_claim',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住地点还没确认清楚时，就直接说附近有岗、附近无岗或替候选人做位置判断的回复。',
    riskGoal: '地理编码不唯一时不得基于位置做附近推荐或无岗判断。',
    exogenousSignal: 'geocode.resolution / geocode.errorType。',
    residualRisk: '候选人历史位置承接暂未纳入豁免判断。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
  },
  {
    id: 'geocode_ambiguous_candidates_omitted',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住 geocode 已返回多城市候选，但回复只泛泛追问城市、没有列出候选城市的情况。',
    riskGoal: '多城市同名地点应按 geocode candidates 枚举候选城市，降低候选人来回澄清成本。',
    exogenousSignal: 'geocode.resolution=ambiguous / candidates[].city。',
    residualRisk: '候选城市过多时的摘要策略仍需结合产品话术优化。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复没有使用 geocode 返回的候选城市清单，当前文本不可发送。请改写为列出 candidates 里的城市让候选人选择，例如“是上海的 X，还是南京的 X？”；不要直接下附近岗位结论。',
  },
  {
    id: 'district_level_distance_claim',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住候选人只报了区/市名，回复却按行政区代表点直接输出精确公里数的情况。',
    riskGoal: '区级粗定位下的距离与候选人真实位置可能差数公里，直接报精确距离会误导到店。',
    exogenousSignal: 'geocode.result.areaLevelQuery（查询词与解析出的区/市名一致）。',
    residualRisk: '候选人报的商圈名恰与区名同名时可能误判；已请求定位/声明估算口径的回复已豁免。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '候选人目前只提供了区/市级位置，本轮距离是按行政区代表点估算的，当前文本不可发送。请只做文案改写：删除所有精确公里数和"离你X公里"表述；优先向候选人确认具体位置（哪条路/哪个商圈/地铁站，或请发定位）。如保留岗位展示，只保留门店名/商圈/路段等已在上一版出现的信息，不新增岗位事实，不调用工具。',
  },
  {
    id: 'farther_job_recommended',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住岗位列表里有明显更近门店，但回复只推荐更远门店且没有说明原因的情况。',
    riskGoal: '候选人按距离找岗时优先展示更近岗位，避免有近岗却推远岗。',
    exogenousSignal: 'duliday_job_list 返回岗位的 distanceKm / _distanceKm 与门店名。',
    residualRisk: '多目标权衡（品牌/班次/薪资）需要更多偏好信号才能完全判断。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复只推荐了更远门店，但本轮岗位列表里存在明显更近的可选门店，当前文本不可发送。请改写为优先推荐更近门店；如果确实因为班次、品牌或硬条件不推荐近门店，必须明确说明依据。',
  },
  {
    id: 'schedule_filtered_job_recommended',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住岗位工具已因候选人班次硬约束过滤为空，但回复仍推荐岗位或承诺可约的情况。',
    riskGoal: '班次不匹配时不得把被过滤岗位包装回去推荐或预约。',
    exogenousSignal: 'duliday_job_list.errorType=job_list.schedule_filter_empty。',
    residualRisk:
      '部分班次偏好不是硬约束时仍依赖工具入参是否正确表达 candidateScheduleConstraint。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复忽略了班次硬约束过滤为空的工具结果，当前文本不可发送。请改写为：当前条件下暂时没有符合该班次要求的岗位，询问候选人是否可以放宽时段；不要推荐或预约被过滤掉的岗位。',
  },
  {
    id: 'handoff_no_booking_claim',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住候选人没有已确认预约时，却说已经帮他转人工改期、取消或会有人跟进的回复。',
    riskGoal: '候选人无已确认预约时不得声称已转人工改期/取消。',
    exogenousSignal: 'request_handoff.errorType=handoff.no_booking。',
    residualRisk: '人工侧另行处理但工具未返回时可能被要求改写。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
  },
  {
    id: 'group_full_without_invite',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住没有真正尝试拉群，却回复候选人群满、群解散、拉不进去之类的说法。',
    riskGoal: '未成功拉群时不得编造群满、群解散、邀请发不过去等状态。',
    exogenousSignal: '本轮 invite_to_group 是否成功。',
    residualRisk: '真实历史已尝试拉群但本轮未重试的场景仍需依赖上下文补充豁免。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复声称群满、群解散、拉不进去或邀请发不过去，但本轮没有成功调用 invite_to_group，当前文本不可发送。请改写为不编造群状态的候选人可见回复：可以说明先帮 TA 继续看岗位、需要确认后再发邀请，或在确需拉群时重新规划调用工具。',
  },
  {
    id: 'group_promise_without_invite',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description:
      '拦住没有成功调用拉群工具，却声称"已拉你进群""群邀请已发"的完成口径回复。' +
      '征询/承诺式（"要不我拉你进群？""我先帮你进群"）是 invite_to_group 场景 2/3 设计内的前置轮，不拦。',
    riskGoal: '"已拉群/邀请已发"的完成口径必须由本轮 invite_to_group 成功结果接地。',
    exogenousSignal: '本轮 invite_to_group 是否成功。',
    residualRisk:
      '承诺后候选人同意的下一轮是否真实调 invite（场景 3 履约）不在本规则单轮视野内；' +
      '历史已入群场景依赖过去式豁免，仍需样本回放。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复声称已拉群/群邀请已发，但本轮没有成功调用 invite_to_group，当前文本不可发送。' +
      '请改写为不声称已发生的口径：可以征询候选人是否愿意进群（候选人同意后下一轮再实际拉群），' +
      '或直接说明后续有合适岗位会主动联系；不要说"已拉/已发邀请"。',
  },
  {
    id: 'discriminatory_screening_leak',
    action: GUARDRAIL_ACTION.BLOCK,
    priority: GUARDRAIL_PRIORITY.P0,
    description:
      '拦住把户籍、籍贯、民族、专业等高敏感筛选条件说出口，或者拿这些条件直接拒绝候选人的回复。',
    riskGoal: '防止户籍/籍贯/民族/专业等歧视性筛选条件外露。',
    exogenousSignal: '歧视筛选词词库。',
    residualRisk: '隐晦地域暗示需要 badcase 持续补词。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    dataSensitivity: GUARDRAIL_DATA_SENSITIVITY.HIGH,
    feedbackPolicy: GUARDRAIL_FEEDBACK_POLICY.REDACTED,
    feedbackToGenerator:
      '上一版回复包含高敏感筛选条件或以高敏感属性作为拒绝理由，当前文本禁止发送。请重新生成：不要提及户籍、籍贯、民族、专业等门槛；不要解释具体不通过原因；核对专业只能开放式问"你学的什么专业"，不得把排除条件塞进问句；改为中性承接，可以推荐其他岗位、继续收集必要信息，或说明需要同事确认。',
  },
  {
    id: 'booking_form_field_mismatch',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住收资模板漏掉预检查要求现在必须收的字段，要求重新输出完整模板。',
    riskGoal: '收资模板必须覆盖 precheck 要求字段，避免漏字段导致 booking 失败。',
    exogenousSignal: 'precheck.requiredFieldsToCollectNow / starterFields。',
    residualRisk:
      '字段同义词和括号补充说明仍依赖归一化词表持续补充（面试时间的口语化标题已归一）。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版收资模板漏掉了 precheck 要求本轮必须收集的字段，当前文本不可发送。请重新输出完整收资模板，只包含候选人需要补充的字段；字段必须覆盖 precheck.requiredFieldsToCollectNow / starterFields，不要多收门店、面试时间等非必要字段。',
  },
  {
    id: 'salary_fabrication',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住回复里多说岗位数据没有写的加薪、面议、薪资浮动等薪资信息。',
    riskGoal: '薪资政策只能按本轮岗位数据表述，禁止编造节假日/周末加薪、浮动或面议。',
    exogenousSignal: '岗位 jobSalary 派生薪资事实。',
    residualRisk: '历史岗位复述场景为降低误伤暂不检测；复杂阶梯薪资仍依赖 salary parser 质量。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复编造了岗位薪资政策，当前文本不可发送。请删除节假日双倍、周末加薪、薪资面议、工资浮动等未在本轮岗位数据中出现的信息；薪资只按 duliday_job_list 返回的 jobSalary 表述。',
  },
  {
    id: 'job_shift_polarity_mismatch',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住本轮岗位数据只有晚班/夜班，回复却把岗位说成早班/白班的情况（反向同理）。',
    riskGoal: '班次极性只能按本轮岗位工具结果表述，晚班说成早班会导致候选人错误决策甚至错误报名。',
    exogenousSignal: '本轮 duliday_job_list 返回的班次事实文本（markdown/rawData）。',
    residualRisk:
      '中班等非极性班次、以及具体时间段（22:00-7:00）与班次名的换算不在检测范围；' +
      '需求复述/未来上新承诺已豁免，藏在这类句式里的真实班次错报会漏判。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复的班次极性与本轮岗位工具结果矛盾（如把晚班岗位说成早班），当前文本不可发送。请严格按 duliday_job_list 返回的班次信息重写，不确定时引用工具里的原始班次表述。',
  },
  {
    id: 'hourly_salary_value_mismatch',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住回复声称的时薪数值在本轮岗位数据里完全不存在的情况。',
    riskGoal: '时薪数值只能来自本轮岗位工具结果，禁止编造或错报具体金额。',
    exogenousSignal: '本轮 duliday_job_list 返回的薪资数值与区间（markdown/rawData）。',
    residualRisk:
      '数字匹配刻意宽松（出现在工具输出任何位置即算支持，且允许 ±0.5 舍入/抹零头容差），' +
      '综合换算类错报可能漏判；按日/按月薪资不在检测范围。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复声称的时薪金额在本轮岗位数据里不存在，当前文本不可发送。薪资数字只能引用 duliday_job_list 返回的数值或区间，不要自行换算或凭记忆报数。',
  },
  {
    id: 'settlement_cycle_mismatch',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住本轮岗位数据写了结算口径（如月结），回复却说成日结/周结的情况。',
    riskGoal: '结算方式只能按本轮岗位工具结果表述，日结/月结说错直接影响候选人求职决策。',
    exogenousSignal: '本轮 duliday_job_list 返回的结算周期事实（markdown/rawData）。',
    residualRisk: '工具输出未包含结算口径时无从对账；非标准结算表述依赖词组持续补充。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复的结算方式与本轮岗位数据矛盾（如把月结说成日结），当前文本不可发送。结算口径只能按 duliday_job_list 返回的结算周期表述；工具没写结算方式时不要主动承诺。',
  },
  {
    id: 'proactive_insurance_policy_mention',
    action: GUARDRAIL_ACTION.BLOCK,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '拦住候选人没问保险时，主动提保险、社保、五险等容易误导的内容。',
    riskGoal: '候选人未问时禁止主动提保险/社保/五险，避免兼职保险被误解。',
    exogenousSignal:
      '候选人本轮 userMessage 或近几轮消息（recentUserTexts）是否主动询问保险/社保。',
    residualRisk:
      '跨轮豁免窗口为近 3 条候选人消息；更久之前问过、间隔多轮闲聊后再作答的场景仍可能误拦。' +
      '任职要求豁免（第一/第二职业、要求+持有动词、合同及社保并列）可能放过个别措辞异常的福利承诺。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
  },
  {
    id: 'candidate_name_echo',
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P2,
    description: '发现回复直接喊出了企微备注里的候选人昵称或姓名。',
    riskGoal: '发现回复直接称呼企微备注中的候选人昵称/姓名。',
    exogenousSignal: 'contactName 企微备注。',
    residualRisk: '当前为观察告警，普通中文词与昵称重合可能误报。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
  },
  {
    id: 'distance_missing',
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P2,
    description: '发现按位置推荐门店时，明明工具给了距离，回复却没有告诉候选人距离。',
    riskGoal: '发现候选人按位置查岗时推荐门店未给公里数。',
    exogenousSignal: '本轮 job_list 结果是否带 distanceKm。',
    residualRisk: '当前为体验类观察告警。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
  },
  {
    id: 'group_invite_without_reason',
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P2,
    description: '发现本轮成功拉群，但回复没向候选人解释拉群原因（无岗兜底/新岗通知）。',
    riskGoal: '防止不加解释的突兀拉群让候选人困惑是有岗还是没岗，影响信任。',
    exogenousSignal: '本轮 invite_to_group 成功结果 + 回复中的拉群理由表述词组。',
    residualRisk:
      '理由是否充分是语义判断，词组只能抓完全没解释的下限；回复完全不提群、只静默发卡片的场景不在检测内。先观察校准误报。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
  },
  {
    id: 'human_service_phrase_leak',
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P2,
    description: '发现回复出现"转人工/人工客服"等与真人招募经理人设冲突的表述。',
    riskGoal: '防止"转人工"类措辞自曝机器人身份，破坏真人人设导致候选人流失。',
    exogenousSignal: '人设露馅词库（转人工/人工客服/人工坐席等）。',
    residualRisk: '当前为观察告警；隐性人机暗示（"我只是个助手"）需持续补词。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
  },
  {
    id: 'repeated_reply',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P2,
    description: '拦住与本会话已发送消息近乎相同的整段复读回复。',
    riskGoal: '防止重复发送同样的岗位详情/追问，候选人观感像机器人。',
    exogenousSignal: '短期记忆中本会话已投递的 assistant 消息。',
    residualRisk: '语义相同但措辞重写的重复检测不到；短确认类消息（<16 字符）不判定。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复与你在本会话里已经发过的消息几乎相同，当前文本不可发送。请针对候选人本轮消息给出有增量的回应：承接已发内容而不是原样重发；若候选人在追问已发过的信息，只补充关键差异点或换角度确认候选人的疑问。',
  },
  {
    id: 'repeated_greeting',
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P2,
    description: '发现会话已经打过招呼，回复又以"你好/您好"重新开场。',
    riskGoal: '防止对话中途重复打招呼，暴露上下文断裂、观感像机器人。',
    exogenousSignal: '短期记忆中本会话已投递的 assistant 消息是否已有问候开场。',
    residualRisk: '当前为观察告警；隔天再联系等合理重新问候场景会计入观测。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
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
    id: 'brand_name_violation',
    action: GUARDRAIL_ACTION.BLOCK,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住把平台名或岗位品牌名说错，或者把工具结果里的品牌改成另一个品牌的回复。',
    riskGoal:
      '对外平台品牌和岗位品牌名必须使用正确名称，禁止把工具结果里的岗位品牌改写成其它品牌。',
    exogenousSignal:
      '平台品牌 sanitizeBrandName 词库；本轮 duliday_job_list 返回的岗位 brandName。',
    residualRisk: '当前只对结构化岗位标题做品牌对账，普通口语品牌讨论不强拦以降低误伤。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
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
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住当前轮有图片/表情消息，但回复基于图片内容判断时没有成功保存图片描述的情况。',
    riskGoal: '视觉内容必须先结构化保存，避免图片识别事实无法进入后续记忆和报名链路。',
    exogenousSignal: 'userMessage 图片标记；save_image_description 是否成功。',
    residualRisk:
      '若渠道未把 imageMessageIds 透传到 OutputGuardInput，图片纯元信息场景仍需后续接入。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复已经基于图片/表情内容做判断，但没有成功调用 save_image_description 保存描述，当前文本不可发送。请先调用 save_image_description 保存每张图片/表情的事实描述；如果看不清，应明确说看不清并请候选人重发清晰图片。',
  },
  {
    id: 'provided_booking_fields_ignored',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住候选人本轮已提供多项报名资料，但回复仍要求重复填写这些字段的情况。',
    riskGoal: '多消息/长消息中已给出的报名资料必须被承接，不能只看最后一句而重复收资。',
    exogenousSignal: '本轮 userMessage 中的姓名/电话/年龄/性别/学历/健康证/经验等字段。',
    residualRisk: '候选人提供字段的复杂自然语言表达仍需 message parser/LLM reviewer 增强。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
    feedbackToGenerator:
      '上一版回复忽略了候选人本轮已经提供的报名资料，当前文本不可发送。请重新阅读候选人整条消息，承接已提供字段，只追问仍缺失的字段；不要重复要求填写已经给出的姓名、电话、年龄、性别、学历、健康证、经验等信息。',
  },
  {
    id: 'system_status_fabrication',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住用“系统异常、后台同步、网络问题”这类没有依据的话来解释失败或拖延。',
    riskGoal: '禁止用系统/网络/后台异常解释拖延、失败或信息缺失。',
    exogenousSignal: '系统状态编造词库。',
    residualRisk: '更委婉的甩锅话术需要从线上样本补充。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
  },
  {
    id: 'work_content_generalization',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '拦住没按岗位数据说职责，而是用行业常识脑补“洗碗、打扫、搬货”等工作内容。',
    riskGoal: '岗位职责只能按岗位数据表述，禁止行业常识泛化补充。',
    exogenousSignal: '行业常识泛化职责词库。',
    residualRisk: '若岗位数据真实包含职责但回复用了泛化词，可能被要求改写为更接地口径。',
    verification: 'tests/agent/guardrail/output/hard-rules.service.spec.ts',
  },
] as const satisfies readonly OutputRuleCatalogSeed[];

export const OUTPUT_RULE_CATALOG = OUTPUT_RULE_CATALOG_SEEDS.map(applyDefaultOutputRulePolicy);

export const OUTPUT_RULE_IDS = OUTPUT_RULE_CATALOG.map((rule) => rule.id);
