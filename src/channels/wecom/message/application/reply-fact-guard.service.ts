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
}

/**
 * Reply 后置事实对账（Phase 1：仅告警，不改写）。
 *
 * 设计目的：拦截 Agent 在确认轮 / 收尾轮"自由发挥"——即没有真正调任何工具
 * 却声称动态事实（群人数、库存、距离、薪资）。历史 badcase i41pab8n：
 * 上一轮 invite_to_group 已成功，本轮用户回"好的"，Agent 无 tool 调用
 * 编出"群里人数满了"。
 *
 * Phase 1：只 logger.warn + 飞书告警，不改写 reply（避免误杀真有信息的回复）。
 * 飞书数据积累 1-2 周后，再决定是否升级到 Phase 2（命中即静默 drop）。
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
  ];

  constructor(private readonly replyFactGuardNotifier: ReplyFactGuardNotifierService) {}

  /**
   * 检查 reply 是否与本轮 tool 调用矛盾。命中即日志告警，不改写文本。
   *
   * @returns 命中的规则；调用方可记 anomaly_flag、用于后续 phase 2 改写决策
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
  }): { hit: boolean; contradictions: Array<{ ruleId: string; label: string }> } {
    const text = params.replyText ?? '';
    if (!text.trim()) return { hit: false, contradictions: [] };

    const toolCalls = params.toolCalls ?? [];
    const contradictions: Array<{ ruleId: string; label: string }> = [];

    for (const rule of this.rules) {
      if (!rule.keywords.test(text)) continue;
      if (rule.ignorePredicate?.(text, toolCalls)) continue;
      if (rule.requiredToolPredicate(toolCalls)) continue;
      contradictions.push({ ruleId: rule.ruleId, label: rule.label });
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

    if (contradictions.length === 0) return { hit: false, contradictions: [] };

    this.logger.warn(
      `[ReplyFactGuard] 命中事实矛盾: chatId=${params.chatId ?? '-'}, userId=${params.userId ?? '-'}, rules=${contradictions
        .map((c) => c.ruleId)
        .join(',')}, replyPreview="${text.slice(0, 80)}"`,
    );

    // 飞书告警 fire-and-forget——不阻塞回复链路
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
        contradictions,
        toolNames: toolCalls.map((c) => c.toolName),
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`[ReplyFactGuard] 飞书告警发送失败: ${message}`);
      });

    return { hit: true, contradictions };
  }
}
