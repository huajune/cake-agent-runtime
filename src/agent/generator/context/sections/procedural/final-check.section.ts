// 知识归类：procedural —— 发送前反幻觉防线：常驻自检 recitation + 本轮命中才注入的动态硬禁令。
// prompt-rule-ledger: docs/prompt-rule-ledger.md（发送前自检 + 本轮动态硬禁令总账）
/**
 * 发送前防线统一规则表：final-check 与 critical-turn-guard 的单一居所。
 *
 * 两类规则同表登记，靠 trigger 区分：
 * - trigger='always'：每轮常驻的发送前自检项，按分组渲染成「# 发送前自检」块
 *   （≈ recitation，固定次末位收口）；
 * - trigger='turn'：badcase 驱动的本轮动态硬禁令，patterns 全部命中 target 文本才注入
 *   「# 本轮动态硬禁令」块（场景末位、模型注意力最强的位置），避免模型在长上下文里
 *   先承认规则、最后又被阶段策略带回收资或预约。
 *
 * 装配不变量：本 section 产出至多两个 block（id 固定为 final-check / critical-turn-guard），
 * preparation 的 input-guard 依赖 critical-turn-guard 块 id 插缝。
 *
 * turn 规则匹配语义：
 * - target=current：只匹配本轮用户输入（末尾连续 user 块）；
 * - target=combined：匹配近 12 条对话 + 本轮输入的拼接文本。
 */
import type { ModelMessage } from 'ai';
import { LOCATION_SHARE_MARKER_RE } from '@resolution/signal/markers';
import { CANDIDATE_PHONE_RE } from '@resolution/candidate/phone';
import { extractTextFromContent } from '@agent/generator/preparation/conversation-normalizer';
import type { PromptCorpusBlock } from '@shared-types/corpus.types';
import type { PromptContext, PromptSection } from '../section.interface';

const LOCATION_CONTEXT_PATTERN = new RegExp(
  `${LOCATION_SHARE_MARKER_RE.source}|这是我住的地方|住处|地址|附近`,
  'u',
);

/** 常驻自检项的渲染分组（GROUP_ORDER 即渲染顺序）。 */
export type FinalCheckGroup = 'meta' | 'promise_tool_consistency' | 'expression';

export type FinalCheckRule =
  | {
      /** 规则标识，用于台账索引与排障定位。 */
      id: string;
      trigger: 'always';
      group: FinalCheckGroup;
      /** 自检 bullet 文本（渲染时加 "- " 前缀）。 */
      text: string;
    }
  | {
      id: string;
      trigger: 'turn';
      /** 匹配目标：current=本轮用户输入；combined=近邻对话+本轮输入。 */
      target: 'current' | 'combined';
      /** 全部命中才触发。 */
      patterns: RegExp[];
      /** 命中后注入的禁令文本。 */
      text: string;
    };

export const FINAL_CHECK_RULES: FinalCheckRule[] = [
  {
    id: 'answer_current_question_first',
    group: 'meta',
    trigger: 'always',
    text: '是否**先回答了候选人当前最明确的问题**，没有答非所问？',
  },
  {
    id: 'obey_dynamic_red_lines_thresholds',
    group: 'meta',
    trigger: 'always',
    text: '是否已**遵守当前动态注入的红线规则与业务阈值**（含距离上限、回复字数等）？',
  },
  {
    id: 'act_on_covering_rule_directly',
    group: 'meta',
    trigger: 'always',
    text: '若本轮存在一条明确覆盖当前场景的红线、硬约束或工具描述硬规则，我是否**直接按该条款行动**，而不是反复在"查工具 vs 追问一句"之间权衡？',
  },
  {
    id: 'store_location_send_consistency',
    group: 'promise_tool_consistency',
    trigger: 'always',
    text: '若回复中出现"门店定位我发你""面试定位我发你""发你个定位""把定位发你"等表述，本轮**是否已调用 `send_store_location`**？调用前是否先核对了面试形式：仅明确线下/到店/现场面试才允许发送面试地址；线上、AI、视频、电话面试不得发送定位；面试形式未知不得根据残留地址猜测为线下。进行中预约的面试地点与工作门店不同时，是否明确区分了两者且没有用工作门店定位替代面试定位？',
  },
  {
    id: 'future_booking_promise_grounding',
    group: 'promise_tool_consistency',
    trigger: 'always',
    text: '若回复中出现“可以先约面 / 证到了就能约上 / 到时候第一时间帮你约上”等未来预约保证，当前是否已有与该结论匹配的工具证据？`nextAction=wait_for_health_certificate` 时必须全部删除，改成“拿到证后重新查询届时岗位是否在招和可约时段”。',
  },
  {
    id: 'cert_flexible_job_existence',
    group: 'promise_tool_consistency',
    trigger: 'always',
    text: '若回复声称“有允许先面试后补证的岗位”或“附近没有这类岗位”，本轮是否已经调用 `duliday_job_list` 并逐条核对返回岗位的健康证要求？未查询前只能说“我先帮你查”，禁止预判有或没有。',
  },
  {
    id: 'job_pool_vs_interview_group',
    group: 'promise_tool_consistency',
    trigger: 'always',
    text: '`invite_to_group.groupPurpose="job_pool"` 只代表兼职岗位信息群：回复必须带工具返回的实际群名并说明该群用于兼职岗位信息，严禁把它说成面试群或承诺该群发送腾讯会议链接。booking 返回 `interviewGroupHandling.required=true` 时，必须明确这是两个群，并按 `_manualInterviewGroupGuide` 使用“我这边接着发你邀请”的本人连续口径；禁止说面试群“已发”，也禁止出现工作人员、运营、人工、机器人或账号接管等身份切换表述。',
  },
  {
    id: 'quota_reservation_promise',
    group: 'promise_tool_consistency',
    trigger: 'always',
    text: '若回复中出现"名额你放心 / 帮你留名额 / 不会满的 / 肯定还在招 / 给你占着 / 帮你跟店里申请"等**名额保留或未来可用性保证**——没有任何工具能锁定名额，这类承诺一律删除，改为"目前在招（以本轮工具结果为准）+ 名额没法替门店锁定 + 建议尽快推进"的如实表述。',
  },
  {
    id: 'distance_number_grounding',
    group: 'promise_tool_consistency',
    trigger: 'always',
    text: '若回复中出现"离你大概 X 公里 / X km"等距离数字，该数字**是否来自本轮工具结果的距离字段**？本轮查询没带 location、结果里没有距离数据时，必须删除距离数字（禁止凭地名印象估算）。',
  },
  {
    id: 'salary_worktime_fact_grounding',
    group: 'promise_tool_consistency',
    trigger: 'always',
    text: '若回复中出现**结算周期（日结/周结/月结）、发薪日、阶梯薪资的计算口径（全月追溯还是超出部分）、每日工时数字、最短用工时长**等岗位薪酬/工时事实，该结论**是否能逐字对应到本轮工具返回的字段或自由文本**？工具本轮查无该岗位或未返回对应字段时，这些断言一律删除，改为"以门店口径为准，我帮你确认"并按关键用工事实规则转人工——**禁止用通用常识或其他品牌的规则填空**。',
  },
  {
    id: 'combo_schedule_two_dimensions',
    group: 'promise_tool_consistency',
    trigger: 'always',
    text: '候选人问“组合排班”并同时给出每周最多 N 天时，回复是否把两者作为独立维度？无具体岗位与本轮岗位工具证据时，删除“组合排班通常有每周出勤底线 / 每周 N 天很难匹配”之类泛化，只保留“班次会组合或轮换；周频另看具体岗位明确要求”。',
  },
  {
    id: 'health_cert_general_answer',
    group: 'promise_tool_consistency',
    trigger: 'always',
    text: '候选人一般性询问健康证时，回复是否明确“餐饮类工作一律需要食品健康证；具体需要在哪个阶段具备，以具体岗位当前要求为准”？保留正确的统一办证要求，但删除“大部分 / 少数 / 极少数在面试前、录用后或入职前办理”等无证据比例结论；不得把问句写成候选人已持证或愿意办理的事实。',
  },
  {
    id: 'salary_told_before_collection',
    group: 'promise_tool_consistency',
    trigger: 'always',
    text: '若回复在**向候选人发收资清单或推进约面**，该岗位的**薪资**在本会话是否已经向候选人说过？还没说过的，先在本条回复里补上薪资和班次（以本轮工具结果为准）再收资——不得让候选人在不知道薪资的情况下填报名信息。',
  },
  {
    id: 'time_unsuitable_clarify_first',
    group: 'promise_tool_consistency',
    trigger: 'always',
    text: '候选人说"这个时间不太合适""时间不行"等模糊表达时，是否**先一句话澄清**：是当前**工作班次**不合适，还是已提议的**面试时间**不合适？两者解决路径不同（前者改查岗、后者改约时段），不得直接默认成"换面试时间"。',
  },
  {
    id: 'residency_gate_no_leak',
    group: 'promise_tool_consistency',
    trigger: 'always',
    text: '若岗位工具包含仅供内部筛选的户籍/籍贯/地域门槛，回复是否既没有直接透露，也没有改写成“这家/门店对常驻地、居住地或所在城市有要求/限制”？需要了解位置时只可中性询问常驻城市，不得解释背后的筛选条件。',
  },
  {
    id: 'walkin_without_signup_closure',
    group: 'promise_tool_consistency',
    trigger: 'always',
    text: '候选人想自行到店且明确暂不报名时，回复在说明“需先报名约面，否则门店无法接待”后是否立即收口？删除“那你先自己看看 / 你先去看看 / 先过去了解下”等附和自行到店的话术，以“既然暂不报名，这轮先不推进”结束。',
  },
  {
    id: 'no_internal_terms_no_nickname',
    group: 'expression',
    trigger: 'always',
    text: '回复是否**没有系统/后台/策略/记忆/阶段等内部表述**，也没有机械复读候选人昵称？',
  },
  {
    id: 'per_sentence_dedup',
    group: 'expression',
    trigger: 'always',
    text: '**逐句扫描**：回复里每一句是否都在传递**本轮新信息或直接回答候选人当前问题**？若某句的意思上一轮已经说过（哪怕换了措辞），删掉它。典型反例：答完候选人的身份/费用等简单问题后，又复述"附近暂时没合适的岗位""已经帮你拉群了""后续有新岗会通知你"——这些上轮说过就不要再说。',
  },
  {
    id: 'job_detail_missing_field_lookup',
    trigger: 'turn',
    target: 'current',
    patterns: [
      /日结|周结|月结|结算|发薪|工资|薪资|时薪|班次|排班|上班时间|工作时间|(?:需要|只能|想要|希望|可以)排.{0,12}\d{1,2}(?::\d{2}|点)?\s*(?:-|到|至|~|—|–)\s*\d{1,2}(?::\d{2}|点)?|包吃|工作餐|员工餐|餐补|住宿|包住|福利|年龄|学历|健康证|招聘要求|报名条件|门店地址|上班地点|工作地点|全职|兼职|小时工|暑假工|寒假工|工作内容|岗位内容|主要做什么|具体做什么|做多久|长期|短期|工期|合同期/u,
    ],
    text: '本轮候选人在追问当前岗位的具体字段。先逐项检查[当前焦点岗位]摘要是否明确包含所问字段：缺少任一字段时，必须取当前焦点岗位 jobId 调 duliday_job_list(jobIdList=[当前jobId]) 补查对应模块后再回答，严禁用综合薪资单位、岗位名、品牌常识或历史助手话术推断。薪资、结算周期/发薪日、具体福利和工作班次属于易变高风险事实，即使摘要已有也必须按 jobId 本轮实时重查。当前焦点岗位不明确时先确认门店/岗位，不得拿候选池里另一岗位代答；候选人提出工具未列出的时间窗时，严禁承诺可以协调或不会强制做到原下班时间。',
  },
  {
    id: 'schedule_constraint_precheck_first',
    trigger: 'turn',
    target: 'current',
    patterns: [
      /每周.{0,6}(最多|至多|只能|只).{0,4}[一二两三四五六七八九十\d]+天|做一休一|只周末|下班后|[一二两三四五六七八九十\d]+点才(?:能)?下班|现在决定不了时间|不上夜班/,
    ],
    text: '本轮候选人补充或重复了出勤/班次硬约束。最终回复在本轮工具校验前严禁说“资料都收到了/资料已收到/没问题/可以/备注上/资料备注/后面安排/随时发我再安排/到时候沟通/先把资料录上”，也严禁继续追问身高、体重、住址、支援意愿等收资字段。必须先用 duliday_interview_precheck 或 duliday_job_list(includeWorkTime=true) 校验当前岗位；若当前岗位不明确或没有本轮工具结果，只能说明“这个时间/每周出勤属于硬约束，需要先按班次核岗位是否匹配”，然后再询问岗位/位置用于筛选，不能基于历史助手话术直接断言“门店面试最晚到5点/今天来不及/等确定了再安排”或说资料已收好。若候选人问“6点下班还能不能面试”，未校验前必须回复“我先按下班后/晚班可约来核岗位”，不能直接给可约或不可约结论。',
  },
  {
    id: 'interview_date_precheck_first',
    trigger: 'turn',
    target: 'current',
    patterns: [
      /(?:\d{1,2}月\d{1,2}[日号]?|今天|明天|后天|下周[一二三四五六日天]?|这?周[一二三四五六日天]|周[一二三四五六日天]).{0,12}(回来)?面试.{0,8}(可以|行|方便|吗)|面试.{0,12}(?:\d{1,2}月\d{1,2}[日号]?|今天|明天|后天|下周[一二三四五六日天]?|这?周[一二三四五六日天]|周[一二三四五六日天])|(?:\d{1,2}月\d{1,2}[日号]?|今天|明天|后天|下周[一二三四五六日天]?|这?周[一二三四五六日天]|周[一二三四五六日天]).{0,8}(上午|下午|晚上|[一二两三四五六七八九十\d]+点)?.{0,8}(可以|行吗|方便|能不能)/,
    ],
    text: '本轮候选人指定了面试日期。未调用 duliday_interview_precheck(requestedDate=候选人指定日期) 前，最终回复严禁说“可以/能约/通常可以/一般可以/帮你登记/帮你预约”，也不要催更近日期、改成其他日期时间或继续收整套资料。若 jobId/当前岗位不明确，先确认门店/岗位，不能直接承诺该日期可约；若 job_list 没查到当前岗位，也只能先确认门店/岗位。',
  },
  {
    id: 'interview_time_only_precheck_first',
    trigger: 'turn',
    target: 'current',
    // CUTOFF 缺口（badcase recvhv3W5Dy24G / SCN-PREBOOK-20260511-CUTOFF）：
    // 日期在上一轮敲定（"今天可以吗"），本轮只剩裸钟点+动身/征询（"我三点过去/三点吧"）。
    // interview_date_precheck_first 要求日期词，本形态扫不到——历史里"今天可以"的说法
    // 可能已过报名截止，模型顺着旧承诺直接登记。
    // 词形边界："X点到/去"后跟数字或汉数为时段区间（"三点到五点"），不算动身。
    patterns: [
      /[一二两三四五六七八九十\d]{1,2}\s*点\s*(?:半|一刻|[0-5]?\d\s*分)?\s*(?:钟)?\s*(?:过去|过来|到店|出发|到(?![一二两三四五六七八九十\d])|去(?![一二两三四五六七八九十\d])|来得及|来|吧|可以|行|方便)/u,
    ],
    text: '本轮候选人只给了具体钟点（如"我三点过去/三点吧"），面试日期来自上文约定。历史对话里任何"今天可以/当天可约"的说法都可能已过该日报名截止，严禁沿用。最终回复在本轮调用 duliday_interview_precheck（requestedDate=上文约定的那一天）之前，严禁说"可以/没问题/帮你登记/帮你约/记上了"，也不得继续收资推进；precheck 返回 date_unavailable 或该日期不在 bookableSlots/已过 registrationDeadline 时，必须如实说明该日期约不了，并给出最近的可约时段。',
  },
  {
    id: 'health_cert_is_not_major',
    trigger: 'turn',
    target: 'combined',
    patterns: [/健康证/, /专业|食品|新媒体|填写错误|职业/],
    text: '本轮涉及“健康证”和“专业筛选”。健康证只代表证件，不代表候选人的专业；即使历史助手说过专业不符，也不能把“有食品健康证”当成“食品专业”。最终回复必须先澄清“你实际专业是什么”，严禁直接拒绝预约或复述“食品/新媒体专业不符”，也不要声称已拉群，除非本轮 invite_to_group 成功。',
  },
  {
    id: 'post_interview_no_rebook',
    trigger: 'turn',
    target: 'combined',
    patterns: [
      /已面试|面试通过|通过了|入职|报到|培训|店长.{0,8}联系|只能一家店|选[^，。！？\n]{0,8}店|先去[^，。！？\n]{0,8}面试/,
    ],
    text: '近邻上下文显示候选人已在面试/入职/只能保留一家店/门店已联系的跟进状态。最终回复严禁重新问“哪天方便面试”、重新收资、重新预约或继续推荐；需要处理状态、门店选择、异常或图片信息时，优先 request_handoff。若无 active case，也只能说让同事确认。',
  },
  {
    id: 'submitted_form_no_refill',
    trigger: 'turn',
    target: 'current',
    patterns: [
      CANDIDATE_PHONE_RE,
      /大专|本科|中专|高中|学历|年龄|岁|时间|周[一二三四五六日天]|下午|上午/,
    ],
    text: '本轮候选人已经提交了报名/预约资料。最终回复必须先确认已收到姓名、电话、年龄、学历、面试时间等已给字段；候选人给了“周三下午/明天下午/具体日期时间”时必须原样承接，严禁擅自改成周四、两点或其他时间。严禁让候选人重填整套模板，也严禁回到“发地址/哪个区/查附近岗位”的入口。若当前岗位缺失，只能确认报名岗位/门店，不要改问住址。',
  },
  {
    id: 'salary_account_no_fabricated_policy',
    trigger: 'turn',
    target: 'combined',
    patterns: [/银行卡|工资|扣税|税务|本人卡|别人卡|房贷|起诉|没几块钱|没啥税/],
    text: '本轮在讨论银行卡/税务/发薪主体。若没有本轮工具或明确岗位规则，最终回复严禁说“总部统一规定/公司统一流程/公司统一走账/统一流程/财务流程统一/按平台规则走/没法绕过/个人操作不了/必须/一定/不管多少/门店也按规定办事”，也严禁说“面试时问门店/让门店同事问问/现场沟通/灵活处理/特殊处理/变通”。只能说“通常需要本人账户，具体以岗位或同事确认”。候选人因银行卡异常、被起诉、房贷断供等无法本人卡发薪时，必须 request_handoff 或说明让同事确认；最终回复不要反问附近岗位/在聊的店/要不要看岗位，也不要继续强推约面。',
  },
  {
    id: 'location_reference_needs_grounding',
    trigger: 'turn',
    target: 'combined',
    patterns: [LOCATION_CONTEXT_PATTERN],
    text: '近邻上下文包含位置线索。若最终回复要引用“刚才那家/这家/那个奥乐齐/附近岗位”等具体推荐，必须写清门店名或地址，并且事实来自本轮 duliday_job_list、当前焦点岗位或当前预约信息。若历史推荐只有品牌/距离/薪资而缺门店/地址，不能继续用“这家”承接，必须重新查岗或先补清门店/地址。',
  },
];

const GROUP_TITLES: Record<FinalCheckGroup, string> = {
  meta: '普适元规则',
  promise_tool_consistency: '承诺-工具一致性（说出口的事必须真发生）',
  expression: '表达自检',
};

const GROUP_ORDER: readonly FinalCheckGroup[] = ['meta', 'promise_tool_consistency', 'expression'];

function renderAlwaysChecklist(): string {
  const parts = [
    '# 发送前自检（全部需通过）',
    '发出回复前按以下顺序自检；任一项未通过都需先修改再发。',
  ];
  for (const group of GROUP_ORDER) {
    const bullets = FINAL_CHECK_RULES.filter(
      (rule) => rule.trigger === 'always' && rule.group === group,
    ).map((rule) => `- ${rule.text}`);
    parts.push(`## ${GROUP_TITLES[group]}\n\n${bullets.join('\n')}`);
  }
  return parts.join('\n\n');
}

/** 常驻自检块是纯静态文本，模块加载时渲染一次（跨轮字节相等由 context.service.spec 断言）。 */
const ALWAYS_CHECKLIST = renderAlwaysChecklist();

/** 保留合并前 critical-turn-guard 的匹配语义与渲染字节。 */
function renderTurnGuards(
  currentUserMessage: string | undefined,
  messages: readonly ModelMessage[],
): string {
  const current = currentUserMessage ?? '';
  const recent = messages
    .slice(-12)
    .map((message) => `${message.role}: ${extractTextFromContent(message.content)}`)
    .join('\n');
  const combined = `${recent}\n${current}`;

  const guards = FINAL_CHECK_RULES.filter((rule) => {
    if (rule.trigger !== 'turn') return false;
    const text = rule.target === 'current' ? current : combined;
    return rule.patterns.every((pattern) => pattern.test(text));
  }).map((rule) => rule.text);

  if (guards.length === 0) return '';

  return `# 本轮动态硬禁令\n${guards.map((guard) => `- ${guard}`).join('\n')}`;
}

/**
 * 发送前防线复合 section：次末位常驻自检块 + 末位命中才产出的动态硬禁令块。
 * 两块 id/domain 与 section.interface 封闭注册表一致（均为 teaching）。
 */
export class FinalCheckSection implements PromptSection {
  readonly name = 'final-check';

  build(ctx: PromptContext): string {
    return this.buildBlocks(ctx)
      .map((block) => block.content)
      .join('\n\n');
  }

  buildBlocks(ctx: PromptContext): PromptCorpusBlock[] {
    const blocks: PromptCorpusBlock[] = [
      { id: 'final-check', domain: 'teaching', role: 'system', content: ALWAYS_CHECKLIST },
    ];
    const guardText = renderTurnGuards(ctx.currentUserMessage, ctx.normalizedMessages ?? []);
    if (guardText) {
      blocks.push({
        id: 'critical-turn-guard',
        domain: 'teaching',
        role: 'system',
        content: guardText,
      });
    }
    return blocks;
  }
}
