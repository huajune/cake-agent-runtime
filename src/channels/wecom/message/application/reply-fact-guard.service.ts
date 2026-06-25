import { Injectable, Logger } from '@nestjs/common';
import { AgentToolCall } from '@agent/agent-run.types';
import { ReplyFactGuardNotifierService } from '@notification/services/reply-fact-guard-notifier.service';
import { extractSalaryFacts } from '@tools/duliday/job-list/salary-facts.util';

/**
 * 从 reply 中抽取"字段名：" 模板字段集合。
 *
 * 识别规则：行首是 2-8 字符中文/斜杠（如"姓名"、"联系方式"、"籍贯/户籍"），
 * 字段名后可带括号注释（如"面试时间（选一个）："、"健康证（有/无）："），
 * 然后是全角或半角冒号，且冒号后不是数字（防误吃"面试时间：13:30"里的"13"）。
 * 至少 3 行命中才视为收资模板，避免误判普通的"门店地址："/"时薪：24"等单行说明。
 */
function extractFormFieldsFromReply(reply: string): string[] {
  const fields: string[] = [];
  // `(?:[（(][^）)]*[）)])*` 允许字段名后跟零或多个括号注释，再接冒号
  const fieldLineRegex = /^\s*([一-龥/]{2,8})(?:[（(][^）)]*[）)])*[：:](?!\s*\d)/;
  for (const line of reply.split(/\r?\n/)) {
    const match = line.match(fieldLineRegex);
    if (match) {
      // 斜杠合并字段（如"性别/年龄："）拆分为独立字段，逐个加入集合
      const parts = match[1].split('/').filter(Boolean);
      fields.push(...parts);
    }
  }
  return fields;
}

/**
 * 从本轮 duliday_interview_precheck 工具结果中读出 Agent 本轮应该收集的字段集合。
 *
 * 优先级：collectionStrategy.starterFields > bookingChecklist.requiredFieldsToCollectNow
 * > bookingChecklist.missingFields。同步 precheck 工具对 progressive/抗拒场景的降级语义。
 */
function readExpectedFieldsFromPrecheck(toolCalls: AgentToolCall[]): string[] | null {
  const precheck = toolCalls.find(
    (call) => call.toolName === 'duliday_interview_precheck' && call.result,
  );
  if (!precheck || typeof precheck.result !== 'object' || precheck.result === null) return null;

  const result = precheck.result as Record<string, unknown>;
  const checklist = result.bookingChecklist as Record<string, unknown> | undefined;
  if (!checklist) return null;

  const strategy = checklist.collectionStrategy as Record<string, unknown> | undefined;
  const starterFields = strategy?.starterFields;
  if (Array.isArray(starterFields) && starterFields.length > 0) {
    return starterFields.filter((f): f is string => typeof f === 'string');
  }

  const required = checklist.requiredFieldsToCollectNow;
  if (Array.isArray(required) && required.length > 0) {
    return required.filter((f): f is string => typeof f === 'string');
  }

  const missing = checklist.missingFields;
  if (Array.isArray(missing) && missing.length > 0) {
    return missing.filter((f): f is string => typeof f === 'string');
  }

  return null;
}

/**
 * 把 precheck 返回字段与 reply 模板字段都规范成同一基准，方便对账。
 *
 * - "联系方式" / "电话" / "联系电话" → "电话"
 * - "工作经验" / "过往经历" / "过往经验" / "过往公司岗位年限" → "经验"
 * - "健康证" / "健康证情况" → "健康证"
 * - "学历" / "学历水平" → "学历"
 * - "面试时间" / "可面试时间" → "面试时间"
 * - 其余按 trim 比对
 */
function normalizeFieldName(name: string): string {
  const trimmed = name.trim();
  if (/电话|联系方式/.test(trimmed)) return '电话';
  if (/经验|过往|经历|公司.*岗位/.test(trimmed)) return '经验';
  if (/健康证/.test(trimmed)) return '健康证';
  if (/学历/.test(trimmed)) return '学历';
  if (/面试时间/.test(trimmed)) return '面试时间';
  if (/籍贯|户籍/.test(trimmed)) return '籍贯';
  if (/身份证(号)?/.test(trimmed)) return '身份证号';
  return trimmed;
}

/**
 * 检查某个字段是否已以预填值或括号备注形式出现在 reply 中。
 *
 * extractFormFieldsFromReply 只提取空值模板行（"字段名："后无数字），
 * 但 Agent 经常把已收集的值预填进模板（如"年龄：32"、"电话：139…"），
 * 或在括号中备注（如"（性别女/50岁我记下了）"）。这些情况下字段并非缺失。
 */
function isFieldCollectedInReply(reply: string, fieldName: string): boolean {
  const normalized = normalizeFieldName(fieldName);
  const original = fieldName.trim();
  const terms = [original, normalized].filter((v, i, a) => a.indexOf(v) === i);

  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`${escaped}(?:[（(][^）)]*[）)])*[：:]\\s*\\S`).test(reply)) return true;
    if (new RegExp(`[（(][^）)]*${escaped}[^）)]*[）)]`).test(reply)) return true;
  }
  // "XX岁" 隐含年龄已知（"（性别女/50岁我记下了）" → 年龄已收集）
  if (normalized === '年龄' && /\d{1,3}岁/.test(reply)) return true;
  return false;
}

/**
 * 判断本轮 duliday_job_list 返回里是否有"节假日/加班"独立薪资字段（type ≠ "无薪资"）。
 * 实现委托给 salary-facts.util 统一派生，避免双口径漂移。
 */
function hasNonEmptyHolidayOrOvertimeSalary(jobListResult: unknown): boolean {
  if (typeof jobListResult !== 'object' || jobListResult === null) return false;
  const rawData = (jobListResult as Record<string, unknown>).rawData as
    | Record<string, unknown>
    | undefined;
  const jobs = (rawData?.result ?? (jobListResult as Record<string, unknown>).result) as
    | unknown[]
    | undefined;
  if (!Array.isArray(jobs)) return false;

  for (const job of jobs) {
    const jobSalary = (job as Record<string, unknown> | undefined)?.jobSalary;
    const facts = extractSalaryFacts(jobSalary);
    if (facts.hasHolidayBonus || facts.hasOvertimeBonus) return true;
  }
  return false;
}

/** 本轮 duliday_job_list 召回结果里是否有任一岗位带 distanceKm（候选人发过定位/查附近）。 */
function jobListHasDistance(jobListResult: unknown): boolean {
  if (typeof jobListResult !== 'object' || jobListResult === null) return false;
  const rawData = (jobListResult as Record<string, unknown>).rawData as
    | Record<string, unknown>
    | undefined;
  const jobs = (rawData?.result ?? (jobListResult as Record<string, unknown>).result) as
    | unknown[]
    | undefined;
  if (!Array.isArray(jobs)) return false;
  return jobs.some((job) => {
    const d = (job as Record<string, unknown> | undefined)?.distanceKm;
    return typeof d === 'number' && Number.isFinite(d);
  });
}

/** 距离表述 token（公里数）；命中即认为回复已给出距离。 */
const DISTANCE_TOKEN_PATTERN = /公里|千米|[0-9.]+\s*k?m\b/i;

/** 民族类敏感词（出站泄漏检测用，限定具体民族词避免误伤"上班族/家族"等）。 */
const ETHNIC_TERM = '少数民族|维吾尔族|哈萨克族|蒙古族|朝鲜族|土家族|[汉回藏满苗彝壮侗瑶白傣黎]族';

/**
 * 歧视性筛选条件外露检测（窄口径）。
 *
 * 岗位的户籍/籍贯/民族筛选条件 🔒 仅供内部筛选（render/precheck/prompt 三层都有
 * 勿透露标注），模型一旦违规说给候选人，此前没有任何代码层兜底。本 pattern 只匹配
 * "把条件本身说出口"的措辞，刻意避开合规话术：
 * - 合规（不命中）："公司这边登记需要核对下户籍信息" / 收资模板"籍贯/户籍：" /
 *   "你的户籍是哪个省" / "户籍不限" / "没有户籍要求"
 * - 违规（命中）："不要新疆西藏籍" / "不收东北户籍" / "仅限本地户口" / "限汉族" /
 *   "这个岗位有户籍要求" / "你的户籍不符合"
 */
const DISCRIMINATORY_LEAK_PATTERN = new RegExp(
  [
    // 排除式条件外露："不要 X 籍 / 不收 X 户籍 / 谢绝少数民族"；籍(?!贯) 避开"不要忘了填籍贯"
    `(?:不要|不收|不招|不接受|不考虑|谢绝|拒绝|排除)[^。！？?\\n]{0,10}?(?:户籍|户口|籍(?!贯)|${ETHNIC_TERM})`,
    // 圈定式条件外露："仅限本地户口 / 只招上海籍 / 限汉族"；(?<!不) 排除合规的"不限户籍/民族"
    `(?<!不)(?:仅限|只限|只招|只收|限)[^。！？?\\n]{0,8}?(?:户籍|户口|本地人|籍(?!贯)|${ETHNIC_TERM})`,
    // 把敏感门槛当条件名说出口："这个岗位有户籍要求"；排除"没有/无户籍要求""户籍要求不限"
    '(?<!没有)(?<!无)(?:户籍|籍贯|民族|地域)(?:要求|限制)(?!不限)',
    // 当拒绝理由说出口："你的户籍不符合 / 民族不匹配"
    '(?:户籍|籍贯|民族)[^。！？?\\n]{0,6}?不(?:符|匹配)',
  ].join('|'),
);

const INSURANCE_POLICY_TERM_PATTERN = /保险|社保|五险(?:一金)?|意外险|雇主责任险/;

/**
 * 单条事实矛盾规则：reply 中出现 `keywords` 任一时，要求本轮 tool 调用满足
 * `requiredToolPredicate`；否则判定为"事实矛盾"。
 */
interface FactRule {
  ruleId: string;
  label: string;
  keywords: RegExp;
  ignorePredicate?: (text: string, toolCalls: AgentToolCall[]) => boolean;
  requiredToolPredicate: (toolCalls: AgentToolCall[]) => boolean;
  /**
   * 命中即出站短路：调用方必须丢弃本轮回复（不发送给候选人），而非仅告警。
   * 仅用于"发出去即不可挽回"的内容类规则（如歧视性筛选条件外露）；
   * 误报代价是本轮沉默 + 飞书告警人工跟进，远低于泄漏代价。
   */
  block?: boolean;
}

/**
 * Reply 后置事实对账（Phase 1：仅告警，不改写）。
 *
 * 设计目的：拦截 Agent 在确认轮 / 收尾轮"自由发挥"——即没有真正调任何工具
 * 却声称动态事实（群人数、库存、距离、薪资）。历史 badcase i41pab8n：
 * 上一轮 invite_to_group 已成功，本轮用户回"好的"，Agent 无 tool 调用
 * 编出"群里人数满了"。
 *
 * Phase 1：常规规则只 logger.warn + 飞书告警，不改写 reply（避免误杀真有信息的回复）。
 * 飞书数据积累 1-2 周后，再决定是否升级到 Phase 2（命中即静默 drop）。
 *
 * 例外——阻断规则（FactRule.block=true）：歧视性筛选条件外露这类"发出去即不可挽回"
 * 的内容直接走出站短路（check 返回 blocked=true，reply-workflow 丢弃回复不发送），
 * 不等 Phase 2。
 *
 * 规则维护：[reply-fact-guard.keywords.ts] 单独文件，独立可读。
 */
@Injectable()
export class ReplyFactGuardService {
  private readonly logger = new Logger(ReplyFactGuardService.name);

  /**
   * "要不要/还是先拉你进群？" 属于征求候选人选择，不是声称本轮已经完成拉群。
   * 这类问句不能要求本轮 invite_to_group 成功，否则会把正常的候选人确认流程打成误报。
   *
   * 覆盖三种条件句形式：
   * 1. 领头词 + invite + ？：要不要/还是先拉你进群？
   * 2. 能力/选项陈述：我也可以拉你进群（不是承诺，是给候选人的一个选项）
   * 3. invite + 尾随确认问：发个入群邀请，你看行行？（向候选人征求确认，下轮才执行）
   */
  private static isConditionalGroupInviteQuestion(text: string): boolean {
    const normalized = text.replace(/\s+/g, '');

    // Case 1：领头征询词 + invite + 问号
    if (
      /(?:要不要|需不需要|是否需要|你看是|还是(?:先)?|要不(?:我)?)[^。！？?；]{0,80}?(?:拉(?:你|您)[^。！？?；]{0,15}?群|进(?:咱们|我们|这个|这|这边)[^。！？?；]{0,15}?群|加(?:你|您)[^。！？?；]{0,15}?群|发(?:个|一个|条)?(?:入)?群邀请)[^。！？?；]{0,80}?(?:吗|呢|？|\?)/.test(
        normalized,
      )
    ) {
      return true;
    }

    // Case 2：能力/选项陈述（"我也可以/可以" + invite）
    // 场景：Agent 在介绍岗位后顺带提到"也可以拉你进群"，属于选项提示，不是承诺。
    if (
      /(?:我?(?:也|还)?可以|(?:要|需要|有需要|感兴趣)的话(?:我)?(?:也)?)[^。！？?；]{0,30}?(?:拉(?:你|您)[^。！？?；]{0,15}?群|进(?:咱们|我们|这个|这|这边)[^。！？?；]{0,15}?群|加(?:你|您)[^。！？?；]{0,15}?群|发(?:个|一个|条)?(?:入)?群邀请)/.test(
        normalized,
      )
    ) {
      return true;
    }

    // Case 3：invite + 尾随确认问（"发个入群邀请，你看行行？"）
    // 向候选人征求确认，invite_to_group 尚未执行，候选人同意后下轮再调。
    // 用 [^。！？]{0,30} 限制窗口，避免误豁免"我拉你进群，有问题你看如何联系我？"
    if (
      /(?:拉(?:你|您)[^。，,；！？\s]{0,15}?群|进(?:咱们|我们|这个|这|这边)[^。，,；！？\s]{0,15}?群|加(?:你|您)[^。，,；！？\s]{0,15}?群|发(?:个|一个|条)?(?:入)?群邀请)[^。！？]{0,30}?(?:你看(?:行|好|可以|怎么样|行不行|行行)?|好吗|行吗|可以吗|方便吗|好不好)[^。！？]{0,10}?(?:？|\?)/.test(
        normalized,
      )
    ) {
      return true;
    }

    // Case 4a："或者" 引出的备选方案（"或者我先拉你进群"），不要求尾随问号
    if (
      /或者(?:我)?(?:也|先|还)?(?:给(?:你|您))?[^。！？?；]{0,20}?(?:拉(?:你|您)[^。！？?；]{0,15}?群|进(?:咱们|我们|这个|这|这边)[^。！？?；]{0,15}?群|加(?:你|您)[^。！？?；]{0,15}?群|发(?:个|一个|条)?(?:入)?群邀请)/.test(
        normalized,
      )
    ) {
      return true;
    }

    // Case 4b："不XX的话/可以的话" 条件句 + invite（中间可能夹长解释，放宽到 80 字符）
    // "不行的话…我先拉你进群留意下？" / "不考虑的话我拉你进群"
    if (
      /(?:不[^。！？?；]{0,8}?|(?:可以|愿意|感兴趣|有需要|有兴趣|方便))的话[^。！？?；]{0,80}?(?:拉(?:你|您)[^。！？?；]{0,15}?群|进(?:咱们|我们|这个|这|这边)[^。！？?；]{0,15}?群|加(?:你|您)[^。！？?；]{0,15}?群|发(?:个|一个|条)?(?:入)?群邀请)/.test(
        normalized,
      )
    ) {
      return true;
    }

    return false;
  }

  /**
   * "之前已经拉你进群了" 是回顾既有事实，不是本轮承诺。
   * 检测 past-tense marker（之前/已经/上次）出现在 invite 短语前的情况。
   */
  private static isPastTenseGroupReference(text: string): boolean {
    const normalized = text.replace(/\s+/g, '');
    return /(?:之前|已经|上次|前面|前两天|前几天|此前|早先)[^。！？?；]{0,40}?(?:拉(?:你|您)[^。！？?；]{0,15}?群|加(?:你|您)[^。！？?；]{0,15}?群|发(?:过)?(?:入)?群邀请)/.test(
      normalized,
    );
  }

  /** 本轮 invite_to_group 真正成功了（用于规则 requiredToolPredicate）。 */
  private static inviteCalledSuccessfully(toolCalls: AgentToolCall[]): boolean {
    return toolCalls.some(
      (call) =>
        call.toolName === 'invite_to_group' &&
        (call.status === 'ok' ||
          (typeof call.result === 'object' &&
            call.result !== null &&
            (call.result as Record<string, unknown>).success === true)),
    );
  }

  /**
   * 检测 reply 是否凭空编造"节假日双倍 / 周末加薪 / 浮动 / 面议"等本平台没有的薪资口径。
   *
   * 历史 badcase：
   * - aalxnd77：阶梯薪资被说成"固定的 24 元/时"
   * - zt98hgy3：受候选人发来的其它平台截图污染，编造"周末和节假日不一样"
   *
   * 命中规则：reply 含"节假日双倍 / 周末加薪 / 工资浮动 / 薪资面议"等关键词 +
   *   本轮 duliday_job_list 返回的 jobSalary 里 holidaySalary/overtimeSalary 字段
   *   type 都是"无薪资"或缺失 → 判定为编造。
   *
   * 例外：本轮没有 duliday_job_list 调用时（如 Agent 仅在转述上一轮已查岗的薪资细节），
   *   不告警——避免 Agent 复述历史薪资被误伤。
   */
  private static detectSalaryFabrication(
    text: string,
    toolCalls: AgentToolCall[],
  ): { ruleId: string; label: string } | null {
    const fabricationPhrases =
      /节假日(工资|薪资|时薪)?双倍|节假日(工资|薪资|时薪)(不一样|更高|翻倍)|周末(加薪|双倍|涨)|工资(按表现|按业绩|按绩效)?浮动|薪资面议|薪资按.*面议/;
    if (!fabricationPhrases.test(text)) return null;

    const jobListCall = toolCalls.find(
      (call) => call.toolName === 'duliday_job_list' && call.result,
    );
    if (!jobListCall) return null;

    const hasHolidayOrOvertimeSalary = hasNonEmptyHolidayOrOvertimeSalary(jobListCall.result);
    if (hasHolidayOrOvertimeSalary) return null;

    return {
      ruleId: 'salary_fabrication',
      label:
        '回复声称节假日/周末薪资差异或工资浮动/面议，但本轮 duliday_job_list 返回的 jobSalary 里没有对应的 holidaySalary/overtimeSalary 字段（badcase aalxnd77 / zt98hgy3）',
    };
  }

  /**
   * 保险/社保属于敏感政策：候选人没主动问时，reply 不应主动提。
   *
   * 兼职岗位字段里的"保险"多指雇主责任险/意外险，候选人容易理解成社保/五险；
   * 与歧视性筛选外露一样，发出去就会形成聊天证据，所以命中时直接阻断。
   */
  private static detectProactiveInsurancePolicyMention(
    text: string,
    userMessage?: string,
  ): { ruleId: string; label: string; blocked: boolean } | null {
    if (!INSURANCE_POLICY_TERM_PATTERN.test(text)) return null;
    if (userMessage && INSURANCE_POLICY_TERM_PATTERN.test(userMessage)) return null;

    return {
      ruleId: 'proactive_insurance_policy_mention',
      label:
        '候选人本轮未主动询问保险/社保，但回复主动提及保险/社保/五险等敏感政策（兼职保险易被误解为社保/五险，需拦截）',
      blocked: true,
    };
  }

  /**
   * candidate_name_echo（51 条新规则，warn）：回复用候选人昵称/姓名直接称呼。
   *
   * 企微名称备注是内部线索（运营写的「城市品牌门店姓名」），prompt 已要求"禁止称呼候选人
   * 昵称"。这里做确定性兜底：reply 里出现"X你好/你好X/Hi X"等称呼语，且 X 是企微备注
   * （contactName）的子串时判定回声。只在 contactName 含该 token 时命中，避免误伤普通问候。
   */
  private static detectCandidateNameEcho(
    text: string,
    contactName?: string,
  ): { ruleId: string; label: string } | null {
    const cleaned = contactName
      ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return null;

    const vocatives = [
      /([一-龥A-Za-z]{2,6})\s*[，,]?\s*(?:你好|您好|在吗)/,
      /(?:你好|您好)[，,]?\s*([一-龥A-Za-z]{2,6})/,
      /\bhi[, ]\s*([一-龥A-Za-z]{2,6})/i,
    ];
    for (const re of vocatives) {
      const token = re.exec(text)?.[1]?.trim();
      if (token && token.length >= 2 && cleaned.includes(token)) {
        return {
          ruleId: 'candidate_name_echo',
          label: `回复疑似用候选人昵称/姓名直接称呼（"${token}" 命中企微备注），禁止称呼候选人昵称（51 条 candidate_name_echo）`,
        };
      }
    }
    return null;
  }

  /**
   * distance_missing（51 条新规则，warn）：本轮召回带 distanceKm（候选人发过定位/查附近），
   * 但回复推荐了具体门店却没给出公里数——候选人最关心远近，漏距离体验差。
   */
  private static detectDistanceMissing(
    text: string,
    toolCalls: AgentToolCall[],
  ): { ruleId: string; label: string } | null {
    const jobListCall = toolCalls.find(
      (call) => call.toolName === 'duliday_job_list' && call.result,
    );
    if (!jobListCall || !jobListHasDistance(jobListCall.result)) return null;
    const looksLikeRecommendation = /门店|这家|地址|位于|附近|推荐/.test(text);
    if (!looksLikeRecommendation) return null;
    if (DISTANCE_TOKEN_PATTERN.test(text)) return null;
    return {
      ruleId: 'distance_missing',
      label:
        '本轮召回结果带 distanceKm，但回复推荐了门店却未给出距离（公里数）（51 条 distance_missing）',
    };
  }

  /**
   * 检测 reply 中的收资模板字段是否与本轮 duliday_interview_precheck 返回的
   * requiredFieldsToCollectNow（或 starterFields 降级集合）一致。
   *
   * 命中规则：reply 像收资模板（≥3 行"字段名："格式）+ 本轮调过 precheck
   *   + 工具要求的字段在 reply 中漏掉了 ≥1 个 → 判定 mismatch。
   *
   * 历史 badcase 67o8y2ez：precheck 返回需要"过往工作经验"等字段，Agent 自己
   * 改模板时把"工作经验"漏掉、又加上 precheck 没要求的"应聘门店/面试时间"，
   * 候选人按 Agent 模板填完后 booking 仍然缺字段。
   *
   * 只检测 "expected 中存在但 reply 中漏了"——"多了字段"不告警（Agent 加
   * "应聘门店/面试时间"虽然 precheck 没要求，但通常是良性的明确告知）。
   */
  private static detectBookingFormFieldMismatch(
    text: string,
    toolCalls: AgentToolCall[],
  ): { ruleId: string; label: string } | null {
    const fieldsInReply = extractFormFieldsFromReply(text);
    if (fieldsInReply.length < 3) return null;

    const expected = readExpectedFieldsFromPrecheck(toolCalls);
    if (!expected || expected.length === 0) return null;

    const replySet = new Set(fieldsInReply.map(normalizeFieldName));
    const missing = expected.filter((f) => !replySet.has(normalizeFieldName(f)));
    if (missing.length === 0) return null;

    // Rescue：预填值行（"年龄：32"）和括号备注（"（性别女我记下了）"）不算漏掉
    const trulyMissing = missing.filter((f) => !isFieldCollectedInReply(text, f));
    if (trulyMissing.length === 0) return null;

    return {
      ruleId: 'booking_form_field_mismatch',
      label: `收资模板字段与 precheck.requiredFieldsToCollectNow 不一致，漏掉字段: ${trulyMissing.join('/')}（badcase 67o8y2ez）`,
    };
  }

  private readonly rules: FactRule[] = [
    {
      ruleId: 'group_full_without_invite',
      label: '声称群满/群解散但本轮未成功调 invite_to_group（badcase i41pab8n）',
      keywords:
        /群已满|群里人数满|群人数已满|邀请暂时发不过去|拉不进群|拉群没成功|群已解散|群里满了/,
      requiredToolPredicate: (toolCalls) =>
        ReplyFactGuardService.inviteCalledSuccessfully(toolCalls),
    },
    {
      ruleId: 'group_promise_without_invite',
      label: '承诺"拉/邀请进群"但本轮未成功调 invite_to_group（badcase gay6j94c）',
      // 仅匹配"本轮要拉群"的强承诺，必须有 invite_to_group 成功兜底，否则就是空头承诺。
      // 不匹配"群里通知/群更新/关注群"等 future-tense 弱承诺——这些话术常出现在候选人
      // 已在群里的会话中（"后续合适的我在群里通知你"），未来 follow-up 不要求本轮拉群。
      // 弱承诺误报场景（false positive）：候选人此前已被拉过群，Agent 婉拒当前岗位时
      // 自然带出"群里通知你"，本轮无需也不该再调 invite_to_group。
      // 弱承诺真要监控，需要 invitedGroups 记忆豁免，留待 phase 2 升级时一起做。
      // [^。，,；！？\s]{0,15} 允许"拉你"与"群"之间夹任意修饰词（"拉你进咱们餐饮兼职群"），
      // 但禁止跨标点，避免误吃到下一句的"群里通知你"上。
      keywords:
        /拉(?:你|您)[^。，,；！？\s]{0,15}?群|进(?:咱们|我们|这个|这|这边)[^。，,；！？\s]{0,15}?群|加(?:你|您)[^。，,；！？\s]{0,15}?群|发(?:个|一个|条)?(?:入)?群邀请/,
      ignorePredicate: (text) =>
        ReplyFactGuardService.isConditionalGroupInviteQuestion(text) ||
        ReplyFactGuardService.isPastTenseGroupReference(text),
      requiredToolPredicate: (toolCalls) =>
        ReplyFactGuardService.inviteCalledSuccessfully(toolCalls),
    },
    {
      ruleId: 'discriminatory_screening_leak',
      label:
        '回复疑似向候选人透露户籍/籍贯/民族等歧视性筛选条件（敏感门槛 🔒 仅供内部筛选，外露涉地域/民族歧视纠纷风险）',
      keywords: DISCRIMINATORY_LEAK_PATTERN,
      // 没有任何工具调用能正当化把歧视性筛选条件说给候选人——命中即拦截
      requiredToolPredicate: () => false,
      // 歧视性内容发出去即不可挽回，必须出站短路（丢弃回复），不能像其他规则只告警
      block: true,
    },
  ];

  constructor(private readonly replyFactGuardNotifier: ReplyFactGuardNotifierService) {}

  /**
   * 检查 reply 是否与本轮 tool 调用矛盾。
   *
   * - 常规规则：命中即日志告警 + 飞书 badcase，不改写文本（Phase 1）
   * - 阻断规则（block=true，如歧视性筛选条件外露）：额外返回 blocked=true，
   *   调用方**必须**据此丢弃本轮回复，不得发送给候选人
   *
   * @returns 命中的规则与是否需要出站短路；调用方可记 anomaly_flag
   */
  check(params: {
    replyText: string;
    toolCalls: AgentToolCall[] | undefined;
    chatId?: string;
    userId?: string;
    traceId?: string;
    contactName?: string;
    botImId?: string;
    botUserName?: string;
    /** 本轮候选人输入，用于写 badcase 时构建对话上下文 */
    userMessage?: string;
  }): {
    hit: boolean;
    blocked: boolean;
    contradictions: Array<{ ruleId: string; label: string; blocked?: boolean }>;
  } {
    const text = params.replyText ?? '';
    if (!text.trim()) return { hit: false, blocked: false, contradictions: [] };

    const toolCalls = params.toolCalls ?? [];
    const contradictions: Array<{ ruleId: string; label: string; blocked?: boolean }> = [];

    for (const rule of this.rules) {
      if (!rule.keywords.test(text)) continue;
      if (rule.ignorePredicate?.(text, toolCalls)) continue;
      if (rule.requiredToolPredicate(toolCalls)) continue;
      contradictions.push({ ruleId: rule.ruleId, label: rule.label, blocked: rule.block === true });
    }

    const bookingFormMismatch = ReplyFactGuardService.detectBookingFormFieldMismatch(
      text,
      toolCalls,
    );
    if (bookingFormMismatch) {
      contradictions.push(bookingFormMismatch);
    }

    const salaryFabrication = ReplyFactGuardService.detectSalaryFabrication(text, toolCalls);
    if (salaryFabrication) {
      contradictions.push(salaryFabrication);
    }

    const proactiveInsuranceMention = ReplyFactGuardService.detectProactiveInsurancePolicyMention(
      text,
      params.userMessage,
    );
    if (proactiveInsuranceMention) {
      contradictions.push(proactiveInsuranceMention);
    }

    const candidateNameEcho = ReplyFactGuardService.detectCandidateNameEcho(
      text,
      params.contactName,
    );
    if (candidateNameEcho) {
      contradictions.push(candidateNameEcho);
    }

    const distanceMissing = ReplyFactGuardService.detectDistanceMissing(text, toolCalls);
    if (distanceMissing) {
      contradictions.push(distanceMissing);
    }

    if (contradictions.length === 0) return { hit: false, blocked: false, contradictions: [] };

    const blocked = contradictions.some((c) => c.blocked);

    this.logger.warn(
      `[ReplyFactGuard] 命中事实矛盾: chatId=${params.chatId ?? '-'}, userId=${params.userId ?? '-'}, action=${
        blocked ? 'block' : 'warn'
      }, rules=${contradictions
        .map((c) => c.ruleId)
        .join(',')}, replyPreview="${text.slice(0, 80)}"`,
    );

    // 飞书告警 fire-and-forget——不阻塞回复链路；阻断规则标注"已拦截"便于运营分辨
    void this.replyFactGuardNotifier
      .notifyContradiction({
        chatId: params.chatId,
        userId: params.userId,
        traceId: params.traceId,
        contactName: params.contactName,
        botImId: params.botImId,
        botUserName: params.botUserName,
        userMessage: params.userMessage,
        replyPreview: text.slice(0, 400),
        contradictions: contradictions.map((c) =>
          c.blocked ? { ...c, label: `【已拦截，未发送给候选人】${c.label}` } : c,
        ),
        toolNames: toolCalls.map((c) => c.toolName),
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`[ReplyFactGuard] 飞书告警发送失败: ${message}`);
      });

    return { hit: true, blocked, contradictions };
  }
}
