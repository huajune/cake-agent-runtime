import type {
  AgentJobDetailField,
  AgentMemorySnapshot,
  AgentToolCall,
} from '@shared-types/agent-telemetry.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { stripMessageDecorations } from '@tools/shared/identity-statement.util';
import type { RuleContradiction } from '../output-rule.types';

interface JobDetailQueryRule {
  field: AgentJobDetailField;
  pattern: RegExp;
  alwaysFresh?: boolean;
}

const JOB_DETAIL_QUERY_RULES: readonly JobDetailQueryRule[] = [
  {
    field: 'settlement',
    pattern: /日结|周结|月结|结算|发薪|几号发|什么时候发工资|工资什么时候到账/u,
    alwaysFresh: true,
  },
  {
    field: 'salary',
    pattern: /工资|薪资|时薪|日薪|月薪|多少钱|一小时多少/u,
    alwaysFresh: true,
  },
  {
    field: 'welfare',
    pattern: /包吃|工作餐|员工餐|餐补|住宿|包住|交通补贴|福利/u,
    alwaysFresh: true,
  },
  {
    field: 'shift',
    pattern:
      /班次|排班|上班时间|工作时间|几点上班|几点下班|(?:需要|只能|想要|希望|可以)排.{0,12}\d{1,2}(?::\d{2}|点)?\s*(?:-|到|至|~|—|–)\s*\d{1,2}(?::\d{2}|点)?|\d{1,2}(?::\d{2}|点)\s*(?:-|到|至|~|—|–)\s*\d{1,2}(?::\d{2}|点)/u,
    // 班次会随门店经营安排变化，且 compact memory 只记录字段存在性、不保存完整时段。
    // 必须按当前 jobId 刷新，避免把 16:00-00:00 擅自缩成 16:00-22:00。
    alwaysFresh: true,
  },
  { field: 'age_requirement', pattern: /年龄|多少岁/u },
  { field: 'education_requirement', pattern: /学历/u },
  { field: 'health_certificate_requirement', pattern: /健康证/u },
  { field: 'student_requirement', pattern: /学生|在校生/u },
  { field: 'age_requirement', pattern: /招聘要求|报名条件|有什么要求|什么条件/u },
  { field: 'education_requirement', pattern: /招聘要求|报名条件|有什么要求|什么条件/u },
  {
    field: 'health_certificate_requirement',
    pattern: /招聘要求|报名条件|有什么要求|什么条件/u,
  },
  { field: 'student_requirement', pattern: /招聘要求|报名条件|有什么要求|什么条件/u },
  { field: 'address', pattern: /门店地址|店在哪里|店在哪|上班地点|工作地点/u },
  {
    field: 'interview_address',
    pattern: /面试(?:地址|地点|去哪|在哪)|去哪面试|面试怎么走/u,
    alwaysFresh: true,
  },
  { field: 'employment', pattern: /全职|兼职|小时工|暑假工|寒假工|用工形式/u },
  { field: 'duties', pattern: /工作内容|岗位内容|主要做什么|具体做什么|主要干嘛|干什么活/u },
  { field: 'duration', pattern: /做多久|工作多久|长期|短期|至少几个月|工期|合同期/u },
];

// 报名表单回填行（生产误伤复盘 2026-07-21）：候选人整段回填「姓名：… / 学历：中专 /
// 健康证：有 / 身份：社会人士」时，"学历/健康证/年龄"等标签词会被误判成详情追问。
// 只剥离已知报名表单标签开头的行；值里带疑问语气（"学历：初中可以吗"）的仍是追问，保留。
const BOOKING_FORM_LABELS =
  '姓名|联系方式|联系电话|电话|手机号?|性别|年龄|学历|健康证|身份|面试时间|应聘门店|应聘岗位|到岗时间|现居住?地?|住址|籍贯';
const FORM_FILL_LINE_RE = new RegExp(
  `^\\s*(?:${BOOKING_FORM_LABELS})(?:[（(][^（）()]*[）)])?\\s*[：:].*$`,
  'gmu',
);
const QUESTION_HINT_RE = /[？?]|吗\b|吗$|多少|多久|几点|几号|行不行|能不能|可以不|可不可以/u;

/**
 * 详情追问匹配前的消息清洗：剥引用块/时间戳装饰（引用的是 Agent 自己发过的岗位卡片，
 * 里面的班次时段、薪资关键词不代表候选人在追问），再剥报名表单回填行。
 */
function stripNonInquiryText(userMessage: string): string {
  return stripMessageDecorations(userMessage)
    .replace(FORM_FILL_LINE_RE, (line) => (QUESTION_HINT_RE.test(line) ? line : ''))
    .trim();
}

function hasFocusJobLookup(
  toolCalls: AgentToolCall[],
  jobId: number,
  requested: readonly JobDetailQueryRule[],
): boolean {
  const hasJobListLookup = toolCalls.some((call) => {
    if (call.toolName !== 'duliday_job_list' || call.status === 'error') return false;
    const jobIdList = call.args.jobIdList;
    return Array.isArray(jobIdList) && jobIdList.some((value) => Number(value) === jobId);
  });
  if (hasJobListLookup) return true;

  const onlyInterviewAddress = requested.every((rule) => rule.field === 'interview_address');
  if (!onlyInterviewAddress) return false;
  return toolCalls.some((call) => {
    if (call.toolName !== 'send_store_location' || call.status === 'error') return false;
    const result =
      call.result && typeof call.result === 'object' && !Array.isArray(call.result)
        ? (call.result as Record<string, unknown>)
        : null;
    return (
      Number(call.args.jobId ?? result?.jobId) === jobId && result?.destination === 'interview'
    );
  });
}

/**
 * 当前岗位已明确时，详情追问只能由精简记忆已有字段或本轮按 jobId 补查来回答。
 * 薪资、结算和福利属于易变/高风险事实，即使摘要有值也要求本轮刷新。
 */
export function detectJobDetailLookupRequired(
  toolCalls: AgentToolCall[],
  memorySnapshot: AgentMemorySnapshot | undefined,
  userMessage: string | undefined,
): RuleContradiction | null {
  const focusJob = memorySnapshot?.currentFocusJob;
  if (!userMessage?.trim()) return null;

  const inquiryText = stripNonInquiryText(userMessage);
  if (!inquiryText) return null;

  const requested = JOB_DETAIL_QUERY_RULES.filter((rule) => rule.pattern.test(inquiryText));
  if (requested.length === 0) return null;

  // 已展示多个岗位但没有形成 currentFocusJob 时，不能把其中任一岗位的班次泛化成
  // “这些店都可以协调”。
  //
  // 2026-07-21 审计：本分支只能 observe，不能 replan。它要求的补救动作是“先反问候选人
  // 问的是哪家门店”——一个**对话行为**，而本规则拿不到 replyText（入参只有 toolCalls/
  // memorySnapshot/userMessage），无从判断回复是否已经反问。且这三个入参在 repair 轮内
  // 都不会变（memory 不在回合中途回写，repair 会重建同一份 snapshot），因此命中即注定
  // 二审复燃 → isSecondDecisionWorse/回归闸门判定 → 修复版默认胜出，仅真变差时回退首版。
  // 生产实测：57 条 replan 二审失败全部复燃在本规则上，即每条命中白烧一次带工具的
  // Agent 生成而候选人拿到的仍是原文。降级为 observe：保留档案与告警，不再触发无效 repair。
  if (!focusJob) {
    const presentedJobIds = memorySnapshot?.presentedJobIds ?? [];

    // 唯一已展示岗位但焦点未锁定（badcase chat 6a62c6f8，2026-07-24：单岗展示打分
    // 不足焦点悬空，“兼职还是全职的”零工具作答编出全职/月结/签合同）：追问只可能
    // 指这一个岗位，且精简记忆没有任何岗位字段可供接地，必须按该 jobId 查证。
    // 与下方多岗分支不同，这里的补救动作本可通过工具调用解除；但 REPLAN 已从类型层
    // 退役（2026-07-27），job_detail 规则族一律 observe，由事后环接盘。
    if (presentedJobIds.length === 1) {
      const presentedJobId = presentedJobIds[0];
      if (hasFocusJobLookup(toolCalls, presentedJobId, requested)) return null;
      const fields = [...new Set(requested.map((rule) => rule.field))].join('/');
      return {
        ruleId: 'job_detail_lookup_required',
        label: `候选人追问唯一已展示岗位详情(${fields})，但焦点未锁定、精简记忆无岗位字段，本轮未按 jobId=${presentedJobId} 调用 duliday_job_list 查证`,
        action: GUARDRAIL_ACTION.OBSERVE,
      };
    }

    const hasPresentedJobs = presentedJobIds.length > 0;
    const asksShift = requested.some((rule) => rule.field === 'shift');
    if (hasPresentedJobs && asksShift) {
      return {
        ruleId: 'job_detail_lookup_required',
        label:
          '候选人在追问已展示岗位的班次，但当前焦点岗位不明确，应先确认门店/岗位再按 jobId 查证',
        action: GUARDRAIL_ACTION.OBSERVE,
      };
    }
    return null;
  }

  if (hasFocusJobLookup(toolCalls, focusJob.jobId, requested)) return null;

  const available = new Set(focusJob.availableDetailFields);
  const missingOrFresh = requested.filter((rule) => rule.alwaysFresh || !available.has(rule.field));
  if (missingOrFresh.length === 0) return null;

  const fields = [...new Set(missingOrFresh.map((rule) => rule.field))].join('/');
  return {
    ruleId: 'job_detail_lookup_required',
    label: `候选人追问当前岗位详情(${fields})，但精简记忆缺字段或该字段要求实时刷新，本轮未按 jobId=${focusJob.jobId} 调用 duliday_job_list`,
    // 2026-07-27 发牌切换：主分支 replan → observe（docs/architecture/
    // guardrail-chain-assessment-and-rebuild.md §2.2/§2.4）。本规则是三期审计全部
    // 重度已投递伤害的宿主——replan 重生成曾把正确首版改成事实反转（trace
    // batch_6a59dcad…"要求"→"奥乐齐没岗位"）、把工具盖章的"周二"改成"周一"并降级
    // 已成功报名（trace batch_6a630be4…），且反馈注入/首版注入/白名单补 geocode 等
    // 提示层防护均被击穿。降 observe 后首版直投（多为"未现查即答详情"级轻问题），
    // 接盘方=事后环 L1 投递文本 vs 工具事实矛盾抽查（每日 badcase 日报 4.5 栏目，
    // 与本切换同步上线，满足 §6 硬约束）。
    action: GUARDRAIL_ACTION.OBSERVE,
  };
}
