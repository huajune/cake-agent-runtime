import type { AgentMemorySnapshot, AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { matchIdentityEvidence } from '@resolution/candidate/student-identity';
import type { RuleContradiction } from '../output-rule.types';

const AUDIT_EVASION_PATTERN =
  /为了[^。！？\n]{0,10}(?:过|通过)[^。！？\n]{0,6}(?:系统)?(?:审核|审查|校验)[^。！？\n]{0,24}(?:按|填|登记|报名|录入)[^。！？\n]{0,10}(?:社会人士|非学生|不是学生|非暑假工|不是暑假工)/u;
const CONCEALMENT_PATTERN =
  /(?:先?别|不要|先不|不用)(?:说|提|告诉|透露)[^。！？\n]{0,12}(?:暑假工|暑期工|学生)/u;
const COERCED_DENIAL_PATTERN =
  /(?:回复|回|说|确认|填写?)[^。！？\n]{0,12}(?:不是暑假工|非暑假工|不是学生|非学生)[^。！？\n]{0,20}(?:才能|才可以|才可|就能|完成|提交|登记|预约)/u;
const FALSE_REGISTRATION_PATTERN =
  /(?:帮你|给你|替你|按|填成|登记成|报成|录入成)[^。！？\n]{0,12}(?:社会人士|非学生|不是学生|非暑假工|不是暑假工)/u;

/** 只保留封闭的身份造假教唆；身份理解本身复用既有事实与 precheck 回执。 */
export function detectIdentityMisregistrationCoaching(
  text: string,
  toolCalls: AgentToolCall[],
  memorySnapshot?: AgentMemorySnapshot,
  userMessage?: string,
  _recentMessages?: unknown[],
  _recentUserTexts?: readonly string[],
): RuleContradiction | null {
  const unconditional =
    AUDIT_EVASION_PATTERN.test(text) ||
    CONCEALMENT_PATTERN.test(text) ||
    COERCED_DENIAL_PATTERN.test(text);

  const candidateSaysNonStudent = matchIdentityEvidence(userMessage ?? '')?.identity === '社会人士';
  const contradictedIdentity =
    !candidateSaysNonStudent &&
    FALSE_REGISTRATION_PATTERN.test(text) &&
    (readKnownStudent(memorySnapshot) || hasIdentityGuard(toolCalls));
  if (!unconditional && !contradictedIdentity) return null;

  return {
    ruleId: 'identity_misregistration_coaching',
    label: '回复教唆候选人隐瞒或改写学生/暑假工身份以完成审核、登记或预约',
    action: GUARDRAIL_ACTION.REVISE,
  };
}

function readKnownStudent(memorySnapshot: AgentMemorySnapshot | undefined): boolean {
  const raw = memorySnapshot?.sessionFacts?.['interview.is_student'];
  if (raw === true) return true;
  return Boolean(raw && typeof raw === 'object' && 'value' in raw && raw.value === true);
}

function hasIdentityGuard(toolCalls: AgentToolCall[]): boolean {
  return toolCalls.some((call) => {
    if (call.toolName !== 'duliday_interview_precheck') return false;
    const result = call.result;
    if (!result || typeof result !== 'object') return false;
    const record = result as Record<string, unknown>;
    const summer = record.temporarySummerWorkerGuard;
    if (summer && typeof summer === 'object') return true;
    const identityGuard = record.identityFieldGuard;
    if (
      identityGuard &&
      typeof identityGuard === 'object' &&
      (identityGuard as Record<string, unknown>).mustAskCandidate === true
    ) {
      return true;
    }
    const checklist = record.bookingChecklist;
    if (!checklist || typeof checklist !== 'object') return false;
    const missing = (checklist as Record<string, unknown>).missingFields;
    return Array.isArray(missing) && missing.includes('身份');
  });
}
