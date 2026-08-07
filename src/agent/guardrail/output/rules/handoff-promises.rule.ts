import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { asRecord, type RuleContradiction } from '../output-rule.types';

/**
 * “同事/负责人后续处理”是可验证的外部动作承诺，不能只靠一句话成立。
 *
 * 这条规则刻意不拦“具体以门店/同事确认为准”一类边界声明；只有 Agent 明确声称自己
 * 已经或将要联系某个人继续确认、处理、回复时，才要求本轮存在成功的人工升级动作
 * （request_handoff 或 raise_risk_alert）。
 */
const HANDOFF_PROMISE_PATTERNS: RegExp[] = [
  /我(?:们)?(?:这边)?(?:已经|会|来|先|马上|尽快)?(?:帮你)?(?:让|请|找|问|联系|反馈给|转给)[^。！？\n]{0,16}(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,24}(?:确认|核实|处理|跟进|联系|回复|答复|发送|发(?:给|你|下|一份|过来|资料|清单|文件|链接|地址|定位|截图|消息)|提供)/,
  /我(?:们)?(?:这边)?(?:已经|会|来|先|马上|尽快)?帮你(?:转给|转达给|反馈给|联系)[^。！？\n]{0,16}(?:同事|负责人|店长|门店|招聘经理)/,
  /(?:稍后|晚点|随后|之后)[^。！？\n]{0,16}(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,24}(?:联系|回复|答复|跟进|处理|发送|发(?:给|你|下|一份|过来|资料|清单|文件|链接|地址|定位|截图|消息)|提供)/,
  /(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,12}(?:稍后|晚点|随后|之后)[^。！？\n]{0,24}(?:联系|回复|答复|跟进|处理|发送|发(?:给|你|下|一份|过来|资料|清单|文件|链接|地址|定位|截图|消息)|提供)/,
  // "转人工"式承诺（badcase chat 6a5f4549："我帮你转人工核实下具体原因"当轮没落
  // handoff，下一轮才补）。措辞本身另由 human_service_phrase_leak(revise) 治理人设
  // 露馅；本词形管的是承诺与动作对账，两规则叠加时同为 revise，一并进入受控重写。
  /(?:帮|给)你转(?:接)?人工|转(?:接)?人工[^。！？\n]{0,16}(?:核实|确认|处理|跟进|登记|申请)/,
];

// 自我跟进不再用整句词形模板绑定。先提取最终的“发送 / 告知”动作，
// 再分别解析收件人、时态和结果条件。这样“之后的材料”不会因为单个“之后”
// 被当成未来承诺，“给你发同事整理的资料”也能按动作语序确认你才是收件人。
const SELF_RECIPIENT_ACTION_PATTERN =
  /(?:给你(?:发|发送)|(?:发|发送)(?:(?:一|这|那)份|一版|一条|一下|过去|过来)?给你|发你|告诉你|通知你|回复你|跟你说|说明给你|同步给你)/gu;
const SELF_RECIPIENT_RESULT_PATTERN = /你(?:会|将)收到我(?:这边)?(?:发|发送)(?:给你)?的/gu;
const SELF_MATERIAL_OR_RESULT_PATTERN =
  /(?:清单|材料|资料|文件|链接|结果|消息|回复|答复|体检点|办理地点|认可机构)/u;
const SELF_FUTURE_TIME_PATTERN = /(?:到时候|稍后|晚点|之后(?!的)|回头(?!看))/u;
const SELF_PAST_TIME_PATTERN = /(?:昨天|昨晚|上周|前天|此前|先前|上次)/u;
const SELF_ACTION_FUTURE_MODAL_PATTERN =
  /(?:^|我(?:这边)?(?:也)?)(?:会|要|再|马上|立即|尽快)[^，,；;]{0,24}$/u;
const SELF_FRONTED_MATERIAL_FUTURE_MODAL_PATTERN =
  /(?:清单|材料|资料|文件|链接|结果|体检点|办理地点|认可机构)(?:也|都)?(?:会|将|要|再|马上|立即|尽快)[^，,；;]{0,8}$/u;
const SELF_RESULT_ACQUISITION_PATTERN =
  /(?:拿到|收到|查到|问到|确认到)[^，,；;]{0,20}(?:后|以后|就|马上|立即)[^，,；;]{0,12}$/u;
const SELF_EXTERNAL_LOOKUP_COMPLETION_PATTERN =
  /(?:查|问|核实)(?:好|清楚|完)(?:了)?(?:后|以后|就|再)?[^，,；;]{0,12}$/u;
const SELF_CONFIRMATION_THEN_FOLLOW_UP_PATTERN =
  /(?:确认|核实|查|问)(?:(?:好|清楚|完)(?:了)?)?(?:后|以后|就|再)[^，,；;]{0,12}$/u;
const SELF_SEND_CONFIRMATION_COMPLETION_PATTERN =
  /确认(?:好|清楚|完)(?:了)?(?:后|以后|就|再)?[^，,；;]{0,12}$/u;
const SELF_RESULT_AVAILABLE_PATTERN =
  /(?:(?:等(?:我)?|我(?:这边)?|一)?有了?(?:清单|材料|资料|文件|链接|结果|消息|回复|答复)|(?:等(?:我)?|我(?:这边)?|一)?有(?:清单|材料|资料|文件|链接|结果|消息|回复|答复)(?:了|的话)|(?:清单|材料|资料|文件|链接|结果|消息|回复|答复)(?:出来(?:了)?|有了|到了))(?:后|就|再)?[^，,；;]{0,12}$/u;
const SELF_LOOKUP_AVAILABLE_CONTINUATION_PATTERN =
  /(?:确认|核实|查|看|问)[^。！？\n]{0,24}(?:清单|材料|资料|文件|链接|结果)[^。！？\n]{0,8}[，,]有的话[^，,；;]{0,8}$/u;
const SELF_PROMISE_DENIAL_PREFIX_PATTERN =
  /(?:(?:不|不会|不能|无法|没法)(?:再|继续|轻易)?(?:承诺|保证)|(?:不能|不要|别|不得|不应|不可|不可以|无法)(?:再|继续|轻易)?指望(?:我)?)[^，,；;]*$/u;
const SELF_PROMISE_DENIAL_SUFFIX_PATTERN =
  /^[”」』"'’\s]*(?:(?:这|那)(?:句|种|个)?(?:话|说法|承诺))?(?:不能说|不要说|别说|不成立|不可信|不能信|不可发送|是空头承诺)/u;

const NEGATED_HANDOFF_ACTION_PATTERN =
  /(?:不会|不能|无法|不要|别|无需|不用|不必|不需要|不打算|不再|未|没有|没)[^，,；;。！？\n]{0,16}(?:确认|核实|处理|跟进|联系|回复|答复|发送|发(?:给|你|下|一份|过来|资料|清单|文件|链接|地址|定位|截图|消息)|提供)/u;
const AFFIRMATIVE_NON_OMISSION_SELF_ACTION_PREFIX_PATTERN =
  /不会(?:(?:忘记|忘了)(?:再)?(?:把|将)?(?:这|那|相关|上述|这些|该|门店认可的|对应的|确认好的)?(?:清单|材料|资料|文件|链接)?|漏(?:掉)?(?:把|将)?(?:这|那|相关|上述|这些|该|门店认可的|对应的|确认好的)?(?:清单|材料|资料|文件|链接)?)(?:再|及时)?$/u;
const THIRD_PARTY_RECIPIENT_SUFFIX_PATTERN =
  /^(?:的(?!是)|朋友|同事|家人|家长|爱人|老师|主管|店长|领导|面试官|负责人|室友|同学|亲戚|对象|父母|爸妈|哥哥|姐姐|弟弟|妹妹|客户|候选人)/u;
const THIRD_PARTY_FOLLOW_UP_ACTOR_PREFIX_PATTERN =
  /^(?:(?:稍后|晚点|之后|随后)[^，,；;]{0,6})?(?:由)?(?:同事|负责人|店长|门店|招聘经理|面试官|平台|系统)[^，,；;]{0,32}$/u;
const DIRECTLY_NEGATED_SELF_ACTION_PREFIX_PATTERN =
  /(?:(?:可能|也许|恐怕)?(?:不会|不能|无法|没法|没办法)|未必(?:会|能)?|不一定(?:会|能)?|不见得(?:会|能)?|不(?:保证|承诺)(?:会|能)?|不要|别|无需|不用|不必|不需要|不打算|不再|未|没有|没|不)(?:再|继续|及时)?(?:会|能|可以)?(?:把|将)?(?:这|那|相关|上述|这些|该|门店认可的|对应的|确认好的)?(?:清单|材料|资料|文件|链接|结果|体检点|办理地点|认可机构)?(?:也|都)?$/u;
const DIRECTLY_UNCERTAIN_SELF_ACTION_PREFIX_PATTERN =
  /(?:(?:可能|也许|或许|大概)(?:再|稍后|晚点)?(?:会|能|可以)?(?:把|将)?(?:这|那|相关|上述|这些|该|门店认可的|对应的|确认好的)?(?:清单|材料|资料|文件|链接|结果|体检点|办理地点|认可机构)?|(?:清单|材料|资料|文件|链接|结果|体检点|办理地点|认可机构)(?:也|都)?(?:可能|也许|或许|大概)(?:会|能|可以)?)(?:也|都)?$/u;
const DOUBLE_NEGATED_SELF_ACTION_PREFIX_PATTERN =
  /(?:不能|不得|不会)不(?:再|继续)?(?:会|能|可以)?(?:把|将)?(?:这|那|相关|上述|这些|该|门店认可的|对应的|确认好的)?(?:清单|材料|资料|文件|链接|体检点|办理地点|认可机构)?(?:也|都)?$/u;
const TIGHT_COMPLETED_SELF_ACTION_PREFIX_PATTERN =
  /(?:(?:我(?:这边)?)?(?:已经|早已)|(?:我(?:这边)?)?(?:刚刚|刚才|之前)(?:已经)?)(?:把|将)?(?:这|那|相关|上述|这些|该|门店认可的)?(?:清单|材料|资料|文件|链接)?(?:都|也)?$/u;

interface SelfRecipientAction {
  index: number;
  end: number;
  text: string;
  recipientPrecedesVerb: boolean;
  isSendAction: boolean;
  isRecipientResult: boolean;
}

const DELEGATED_HUMAN_CONTEXT_PATTERN =
  /我(?:们)?(?:这边)?(?:已经|会|来|先|马上|尽快)?(?:帮你)?(?:让|请|找|问|联系|反馈给|转给)[^。！？\n]{0,16}(?:同事|负责人|店长|门店|招聘经理)/u;
const TIMED_HUMAN_CONTEXT_PATTERN =
  /(?:(?:稍后|晚点|随后|之后)[^。！？\n]{0,16}(?:同事|负责人|店长|门店|招聘经理)|(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,12}(?:稍后|晚点|随后|之后))/u;
const IMPLICIT_CLAUSE_LEAD_PATTERN = /^(?:但|不过|只是|而是)\s*/u;
const IMPLICIT_ACTION_CONNECTOR_PATTERN =
  /^(?:(?:直接|改成|改为|再|然后|随后|稍后|晚点|之后|会|马上|尽快|继续|转而)\s*)+/u;
const IMPLICIT_ACTION_PREFIX_PATTERN =
  /^(?:帮你|给你)?\s*(?:确认(?!结果|状态)|核实(?!结果)|处理(?!结果|方式)|跟进(?!记录|结果)|联系(?!方式|记录)|回复(?!记录|内容)|答复(?!记录|内容)|发送(?!记录|状态)|发(?:给|你|下|一份|过来|资料|清单|文件|链接|地址|定位|截图|消息)|提供(?!的(?:信息|内容)|信息))/u;
const IMPLICIT_FRONTED_SEND_PATTERN =
  /^(?:把|将)[^，,；;。！？\n]{0,12}(?:发送(?:给你)?|发(?:给你|你|下|过来)|提供给你)/u;
const IMPLICIT_STRONG_BARE_ACTION_PATTERN =
  /^(?:联系你|回复你|答复你|跟进你|发送给你|发(?:给你|你|一份|资料|清单|文件|链接|地址|定位|截图|消息)|提供给你)/u;

function isImplicitPositiveHandoffClause(clause: string): boolean {
  let body = clause.replace(IMPLICIT_CLAUSE_LEAD_PATTERN, '').trim();
  const connector = body.match(IMPLICIT_ACTION_CONNECTOR_PATTERN);
  if (connector) body = body.slice(connector[0].length).trim();

  if (IMPLICIT_FRONTED_SEND_PATTERN.test(body)) return true;
  if (connector) return IMPLICIT_ACTION_PREFIX_PATTERN.test(body);
  // 无连接词时只认带明确宾语/收件人的强动作，避免把“回复已收到”“联系已中断”
  // 这类名词或状态描述继承为同事的后续承诺。
  return IMPLICIT_STRONG_BARE_ACTION_PATTERN.test(body);
}

function containsPositiveImplicitHandoffAction(sentence: string): boolean {
  const clauses = sentence
    .split(/[，,；;]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  for (let index = 1; index < clauses.length; index += 1) {
    const priorContext = clauses.slice(0, index).join('，');
    if (
      !DELEGATED_HUMAN_CONTEXT_PATTERN.test(priorContext) &&
      !TIMED_HUMAN_CONTEXT_PATTERN.test(priorContext)
    ) {
      continue;
    }
    // 只让“直接/改成/再/会…”等动作型子句继承前文人工主体；“我自己回复”、
    // “现有资料提供的信息”等新主语或名词短语不会被当成人工后续承诺。
    if (isImplicitPositiveHandoffClause(clauses[index])) return true;
  }
  return false;
}

function containsPositiveHandoffPromise(content: string): boolean {
  const sentences = content
    .split(/[。！？!?\n]+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const containsPromise = (text: string): boolean =>
    HANDOFF_PROMISE_PATTERNS.some((pattern) => {
      const matcher = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
      for (const match of text.matchAll(matcher)) {
        if (!NEGATED_HANDOFF_ACTION_PATTERN.test(match[0])) return true;
      }
      return false;
    });

  return sentences.some((sentence) => {
    // 保留整句检查，兼容“我让同事确认下，有消息告诉你”这类跨逗号主谓；同时逐个
    // 逗号/分号子句再查一次，防止前半句的否定动作被贪婪匹配吞掉后半句的正向承诺。
    const candidates = [sentence, ...sentence.split(/[，,；;]+/u)];
    return (
      candidates.some((candidate) => containsPromise(candidate.trim())) ||
      containsPositiveImplicitHandoffAction(sentence)
    );
  });
}

function clausePrefixBefore(text: string, index: number, maxLength: number): string {
  const window = text.slice(Math.max(0, index - maxLength), index);
  const boundary = Math.max(
    window.lastIndexOf('，'),
    window.lastIndexOf(','),
    window.lastIndexOf('；'),
    window.lastIndexOf(';'),
  );
  return window.slice(boundary + 1);
}

function extractSelfRecipientActions(sentence: string): SelfRecipientAction[] {
  const directActions = Array.from(sentence.matchAll(SELF_RECIPIENT_ACTION_PATTERN), (match) => {
    const index = match.index ?? 0;
    return {
      index,
      end: index + match[0].length,
      text: match[0],
      recipientPrecedesVerb: match[0].startsWith('给你'),
      isSendAction: match[0].includes('发'),
      isRecipientResult: false,
    };
  });
  const recipientResults = Array.from(sentence.matchAll(SELF_RECIPIENT_RESULT_PATTERN), (match) => {
    const index = match.index ?? 0;
    return {
      index,
      end: index + match[0].length,
      text: match[0],
      recipientPrecedesVerb: true,
      isSendAction: true,
      isRecipientResult: true,
    };
  });
  return [...directActions, ...recipientResults].sort((left, right) => left.index - right.index);
}

function isDirectCandidateRecipient(sentence: string, action: SelfRecipientAction): boolean {
  // “给你发……”的收件人在动词前，动词后的“同事整理的资料”是宾语；
  // “发给你家长 / 回复你的主管”的收件人在动词后，是第三方。
  if (action.recipientPrecedesVerb) return true;
  return !THIRD_PARTY_RECIPIENT_SUFFIX_PATTERN.test(sentence.slice(action.end, action.end + 8));
}

function isAffirmativeNonOmissionOrDoubleNegation(actionPrefix: string): boolean {
  return (
    AFFIRMATIVE_NON_OMISSION_SELF_ACTION_PREFIX_PATTERN.test(actionPrefix) ||
    DOUBLE_NEGATED_SELF_ACTION_PREFIX_PATTERN.test(actionPrefix)
  );
}

function isNegatedOrUncertainSelfAction(actionPrefix: string): boolean {
  if (DIRECTLY_UNCERTAIN_SELF_ACTION_PREFIX_PATTERN.test(actionPrefix)) return true;
  const denial = actionPrefix.match(DIRECTLY_NEGATED_SELF_ACTION_PREFIX_PATTERN);
  if (!denial) return false;
  const beforeDenial = actionPrefix.slice(0, denial.index ?? 0).trim();
  return !/(?:不是|并非)$/u.test(beforeDenial);
}

function isCompletedSelfAction(
  sentence: string,
  action: SelfRecipientAction,
  actionPrefix: string,
): boolean {
  const suffix = sentence.slice(action.end, action.end + 8);
  if (/^[了过]/u.test(suffix)) return true;
  if (TIGHT_COMPLETED_SELF_ACTION_PREFIX_PATTERN.test(actionPrefix)) return true;

  // “之后的材料上周发给你”和“回头看，昨晚发给你”即使省略“了”，
  // 过去时间仍直接支配发送动作。真正的未来标记可以覆盖宾语里的过去定语，
  // 如“稍后把刚才整理的资料发你”。
  const sentencePrefix = sentence.slice(0, action.index);
  return (
    SELF_PAST_TIME_PATTERN.test(actionPrefix) &&
    !SELF_FUTURE_TIME_PATTERN.test(sentencePrefix) &&
    !SELF_ACTION_FUTURE_MODAL_PATTERN.test(actionPrefix)
  );
}

function hasSelfFollowUpTrigger(
  sentence: string,
  action: SelfRecipientAction,
  actionPrefix: string,
): boolean {
  const sentencePrefix = sentence.slice(Math.max(0, action.index - 72), action.index);
  const actionContext = `${sentence.slice(Math.max(0, action.index - 32), action.index)}${sentence.slice(
    action.end,
    action.end + 24,
  )}`;
  const hasMaterialOrResult = SELF_MATERIAL_OR_RESULT_PATTERN.test(actionContext);

  if (isAffirmativeNonOmissionOrDoubleNegation(actionPrefix)) return true;
  if (
    SELF_RESULT_ACQUISITION_PATTERN.test(actionPrefix) ||
    SELF_EXTERNAL_LOOKUP_COMPLETION_PATTERN.test(actionPrefix) ||
    SELF_CONFIRMATION_THEN_FOLLOW_UP_PATTERN.test(actionPrefix) ||
    (action.isSendAction && SELF_SEND_CONFIRMATION_COMPLETION_PATTERN.test(actionPrefix)) ||
    SELF_RESULT_AVAILABLE_PATTERN.test(actionPrefix) ||
    SELF_LOOKUP_AVAILABLE_CONTINUATION_PATTERN.test(sentencePrefix)
  ) {
    return true;
  }

  if (!hasMaterialOrResult) return false;
  if (action.isRecipientResult) return true;
  return (
    SELF_FUTURE_TIME_PATTERN.test(sentencePrefix) ||
    SELF_ACTION_FUTURE_MODAL_PATTERN.test(actionPrefix) ||
    SELF_FRONTED_MATERIAL_FUTURE_MODAL_PATTERN.test(actionPrefix)
  );
}

function isPositiveSelfFollowUpAction(sentence: string, action: SelfRecipientAction): boolean {
  if (!isDirectCandidateRecipient(sentence, action)) return false;

  const actionPrefix = clausePrefixBefore(sentence, action.index, 72).trim();
  const sentencePrefix = sentence.slice(0, action.index);
  const actionSuffix = sentence.slice(action.end, action.end + 24);

  // 逗号切断否认辖域：“不能承诺具体时间，但到时候会发你”仍是真承诺。
  if (SELF_PROMISE_DENIAL_PREFIX_PATTERN.test(actionPrefix)) return false;
  if (SELF_PROMISE_DENIAL_SUFFIX_PATTERN.test(actionSuffix)) return false;
  if (isAffirmativeNonOmissionOrDoubleNegation(actionPrefix)) return true;
  if (isNegatedOrUncertainSelfAction(actionPrefix)) return false;
  if (isCompletedSelfAction(sentence, action, actionPrefix)) return false;
  // “门店确认后回复你”是第三方未来动作的客观边界，不是 Agent 承诺自己跟进；
  // 一旦动作前重新出现“我”，仍按自我承诺处理（如“等门店确认后我回复你”）。
  if (
    THIRD_PARTY_FOLLOW_UP_ACTOR_PREFIX_PATTERN.test(actionPrefix) &&
    !/我(?:们|这边)?/u.test(actionPrefix)
  ) {
    return false;
  }

  // 引号前的整段否认可能位于未来状语之前，动作分句内再做一次语义对账。
  const denial = sentencePrefix.match(SELF_PROMISE_DENIAL_PREFIX_PATTERN);
  if (denial && !/(?:不是|并非)$/u.test(sentencePrefix.slice(0, denial.index ?? 0).trim())) {
    return false;
  }
  return hasSelfFollowUpTrigger(sentence, action, actionPrefix);
}

function containsPositiveSelfFollowUpPromise(content: string): boolean {
  const sentences = content
    .split(/[。！？!?\n]+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  return sentences.some((sentence) =>
    extractSelfRecipientActions(sentence).some((action) =>
      isPositiveSelfFollowUpAction(sentence, action),
    ),
  );
}

function containsPositiveFollowUpPromise(content: string): boolean {
  return containsPositiveHandoffPromise(content) || containsPositiveSelfFollowUpPromise(content);
}

/**
 * 本轮已提交的真实人工升级动作：request_handoff（dispatched=true）、
 * raise_risk_alert（accepted=true），或 duliday_interview_booking 失败自动暂停
 * （hostingPaused=true）。三者的副作用同样收敛为「暂停托管 + 飞书告警 +
 * 下一轮人工接手」，都能兑现"让同事/负责人跟进"的承诺；差别只在
 * raise_risk_alert 本轮仍要输出安抚话术——恰恰是这条路径会走到出站守卫
 * （badcase batch_6a66f559…：面试官缺席，Agent 正确升级 raise_risk_alert 并
 * 承诺"让同事确认"，却被判 P0 空头承诺，无工具 rewrite 把当天 15:00 的真实
 * 约面复述成"明天…不用一直等"，劝退了正在等面的候选人）。
 *
 * booking 分支（2026-08-04 守卫审计 …740343589/…748484273）：预约失败时工具
 * 自己 pauseUserHostingAsync 暂停托管并告警真人接管，且其 replyInstruction 明确
 * 指示模型说"我让同事确认一下，稍等"——规则若不认这第三种升级副作用，就是把
 * 工具亲自教的如实话术判成 P0 空头承诺，逼 rewrite 编出"那就给你约明天…"类
 * 完成暗示（假阳 × 有害重写，与 8ac0c1e4 修的 raise_risk_alert 假阳同构）。
 * 对账走工具结果里的显式 `hostingPaused` 打标，不用 errorType 推断——
 * BOOKING_REJECTED 也被不暂停的 precheck 早退分支复用，推断会把早退误判为已升级。
 */
export function hasCommittedHumanEscalation(toolCalls: AgentToolCall[]): boolean {
  return toolCalls.some((call) => {
    const result = asRecord(call.result);
    if (call.toolName === 'request_handoff') return result?.dispatched === true;
    if (call.toolName === 'raise_risk_alert') return result?.accepted === true;
    if (call.toolName === 'duliday_interview_booking') return result?.hostingPaused === true;
    return false;
  });
}

/**
 * 整条回复剥掉承诺句后是否已无实质内容（2026-08-04 审计 P0-1）。
 *
 * "删除跟进承诺、其余逐字保留"的修复指令在首版整条只有那句承诺时保留的是空集
 * ——rewrite 被逼成自由创作，生产 4 例全部编出无出处事实（"衣服方面店里没有特殊
 * 要求""已经拉你进上海的餐饮群了""那就给你约明天下午1点半"），其中 2 例投递。
 * 该形态由 runner 直接收敛为静默（handoff_promise_only_reply_silenced），不进 rewrite：
 * 没有事实可依时，沉默好于编造（与 tool_call_artifact_silenced 同一裁定）。
 *
 * 句切分只用句末标点/换行、刻意不切逗号："衣服要求我让同事确认下，有消息告诉你"
 * 的后半是同一承诺的尾巴，跟着整句一起剥。剥后残文少于 4 个汉字（"好的"类寒暄）
 * 视为无实质内容。
 */
export function isHandoffPromiseOnlyReply(content: string): boolean {
  const text = content?.trim() ?? '';
  if (!text) return false;
  if (!containsPositiveFollowUpPromise(text)) return false;
  const residue = text
    .split(/[。！？!?\n]+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) => !containsPositiveFollowUpPromise(sentence))
    .join('\n');
  return (residue.match(/\p{Script=Han}/gu)?.length ?? 0) < 4;
}

export function detectHandoffPromiseWithoutHandoff(
  content: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  if (!content || !containsPositiveFollowUpPromise(content)) return null;
  if (hasCommittedHumanEscalation(toolCalls)) return null;

  return {
    ruleId: 'handoff_promise_without_handoff',
    label:
      '回复承诺由自己或同事/负责人在本轮之后继续确认、联系或发送资料，但本轮没有成功的人工升级动作（request_handoff / raise_risk_alert / 预约失败自动暂停），属于无真实动作支撑的跟进承诺',
    // 2026-07-27 发牌收尾：replan → revise（评估文档 §2.2/§2.4）。replan 作为修复
    // 机制已整体退役；本规则检测是过程判据（承诺词形+dispatched 对账）、rewrite 下
    // 修法唯一（删除完成时态承诺、只陈述已确认事实），符合白名单准入三条件，且 P0
    // 收敛保证 rewrite 失败即 block——假承诺不会出门。"真正补执行 request_handoff"
    // 的保文补参式修复是条件项（评估文档 §2.4），届时走两步拆解不回 replan。
    action: GUARDRAIL_ACTION.REVISE,
  };
}
