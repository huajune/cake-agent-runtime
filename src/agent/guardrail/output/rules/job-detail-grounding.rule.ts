import type {
  AgentJobDetailField,
  AgentMemorySnapshot,
  AgentToolCall,
} from '@shared-types/agent-telemetry.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
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
  { field: 'employment', pattern: /全职|兼职|小时工|暑假工|寒假工|用工形式/u },
  { field: 'duties', pattern: /工作内容|岗位内容|主要做什么|具体做什么|主要干嘛|干什么活/u },
  { field: 'duration', pattern: /做多久|工作多久|长期|短期|至少几个月|工期|合同期/u },
];

function hasFocusJobLookup(toolCalls: AgentToolCall[], jobId: number): boolean {
  return toolCalls.some((call) => {
    if (call.toolName !== 'duliday_job_list' || call.status === 'error') return false;
    const jobIdList = call.args.jobIdList;
    return Array.isArray(jobIdList) && jobIdList.some((value) => Number(value) === jobId);
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

  const requested = JOB_DETAIL_QUERY_RULES.filter((rule) => rule.pattern.test(userMessage));
  if (requested.length === 0) return null;

  // 已展示多个岗位但没有形成 currentFocusJob 时，不能把其中任一岗位的班次泛化成
  // “这些店都可以协调”。先阻止当前回复，让修复轮明确门店/岗位再按 jobId 查证。
  if (!focusJob) {
    const hasPresentedJobs = (memorySnapshot?.presentedJobIds?.length ?? 0) > 0;
    const asksShift = requested.some((rule) => rule.field === 'shift');
    if (hasPresentedJobs && asksShift) {
      return {
        ruleId: 'job_detail_lookup_required',
        label:
          '候选人在追问已展示岗位的班次，但当前焦点岗位不明确，必须先确认门店/岗位再按 jobId 查证',
        action: GUARDRAIL_ACTION.REPLAN,
      };
    }
    return null;
  }

  if (hasFocusJobLookup(toolCalls, focusJob.jobId)) return null;

  const available = new Set(focusJob.availableDetailFields);
  const missingOrFresh = requested.filter((rule) => rule.alwaysFresh || !available.has(rule.field));
  if (missingOrFresh.length === 0) return null;

  const fields = [...new Set(missingOrFresh.map((rule) => rule.field))].join('/');
  return {
    ruleId: 'job_detail_lookup_required',
    label: `候选人追问当前岗位详情(${fields})，但精简记忆缺字段或该字段要求实时刷新，本轮未按 jobId=${focusJob.jobId} 调用 duliday_job_list`,
    action: GUARDRAIL_ACTION.REPLAN,
  };
}
