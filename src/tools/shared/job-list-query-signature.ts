/**
 * duliday_job_list 查询签名：把一次岗位查询的「实质过滤条件」归一成稳定字符串，
 * 用于跨轮比对"两轮查询是否有实质差异"。
 *
 * 背景（badcase chat 6a5dc7c4ce406a6aee57bf6d）：候选人明确要包住宿岗位、Agent 也承诺
 * "扩大范围再查"，但连续三轮 duliday_job_list 入参完全相同，回复逐字复读"没有"，
 * 候选人被激怒流失。签名相同 = 结果必然相同，此时模型必须实质调整查询，或按
 * “拉群优先、群满才转人工”的既有兜底阶梯推进，不得复读。
 *
 * 签名只包含影响结果集的过滤维度；include* 渲染开关、responseFormat 不参与。
 * 数组排序去重后参与，坐标四舍五入到 3 位小数（~110m），避免无意义抖动。
 */

interface SignatureLocation {
  longitude?: number | null;
  latitude?: number | null;
  range?: number | null;
}

export interface JobListQuerySignatureInput {
  cityNameList: string[];
  regionNameList: string[];
  brandAliasList: string[];
  brandIdList: number[];
  /** 品牌过滤方向；同一品牌的 enforce / exclude 会产生不同结果集。 */
  brandFilterMode?: 'enforce' | 'exclude' | null;
  /**
   * exclude 模式本地剔除的品牌标准名。排除品牌不进上游查询参数
   * （brandAliasList/brandIdList 在 exclude 时为空），必须单独参与签名，
   * 否则"排除肯德基"与"不限品牌"、或换一个排除对象都会被误判为同一查询。
   */
  excludeBrandNames?: string[];
  projectNameList: string[];
  projectIdList: number[];
  storeNameList: string[];
  searchJobName?: string | null;
  jobCategoryList: string[];
  jobIdList: number[];
  salaryPeriodNameList: string[];
  location?: SignatureLocation | null;
  /** 结构化班次约束（本地过滤生效维度），任意可序列化对象。 */
  candidateScheduleConstraint?: Record<string, unknown> | null;
  /** 候选人用工形式意向（本地过滤生效维度）。 */
  candidateLaborForm?: string | null;
}

function normalizeStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort();
}

function normalizeNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function roundCoord(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

/** 计算查询签名；入参相同（实质过滤条件层面）必得相同签名。 */
export function buildJobListQuerySignature(input: JobListQuerySignatureInput): string {
  const constraint = input.candidateScheduleConstraint ?? null;
  const normalizedConstraintEntries = constraint
    ? Object.entries(constraint)
        .filter(([, v]) => v !== undefined && v !== null && v !== false)
        .sort(([a], [b]) => a.localeCompare(b))
    : [];
  const normalizedConstraint =
    normalizedConstraintEntries.length > 0 ? Object.fromEntries(normalizedConstraintEntries) : null;
  const normalizedLocation = input.location
    ? {
        lng: roundCoord(input.location.longitude),
        lat: roundCoord(input.location.latitude),
        range: input.location.range ?? null,
      }
    : null;
  const hasLocationFilter = normalizedLocation
    ? Object.values(normalizedLocation).some((value) => value !== null)
    : false;
  const payload = {
    city: normalizeStrings(input.cityNameList),
    region: normalizeStrings(input.regionNameList),
    brandAlias: normalizeStrings(input.brandAliasList),
    brandId: normalizeNumbers(input.brandIdList),
    brandMode: input.brandFilterMode ?? null,
    excludeBrand: normalizeStrings(input.excludeBrandNames ?? []),
    project: normalizeStrings(input.projectNameList),
    projectId: normalizeNumbers(input.projectIdList),
    store: normalizeStrings(input.storeNameList),
    searchJobName: input.searchJobName?.trim() || null,
    category: normalizeStrings(input.jobCategoryList),
    jobId: normalizeNumbers(input.jobIdList),
    settlement: normalizeStrings(input.salaryPeriodNameList),
    location: hasLocationFilter ? normalizedLocation : null,
    schedule: normalizedConstraint,
    laborForm: input.candidateLaborForm?.trim() || null,
  };
  return JSON.stringify(payload);
}

/**
 * 重复查询提醒：与上一轮签名一致时注入工具结果头部，在模型的决策时刻堵死复读，
 * 并把出口指回既有兜底阶梯（改查询 → 拉群维护 → 群满/无法自助才转人工）。
 * 注意：本提醒不另起兜底顺序——拉群优先、群满才 no_match_or_group_full、
 * 无群城市自然收口不转人工，均与 invite_to_group / request_handoff 的既有裁定一致。
 */
export const REPEAT_QUERY_NOTICE =
  '⚠️ **重复查询提醒**：本次查询条件与上一轮完全一致，岗位结果不会有任何变化。' +
  '若上一轮结果已经无法满足候选人明确提出的需求（如包住宿、包吃、特定班次、更近门店等），' +
  '本轮**禁止**基于相同结果复读上一轮话术、也禁止再次原样反问同一个问题，按下面顺序推进：\n' +
  '1. 还能实质调整查询条件的（如去掉 regionNameList 扩大到全市、放宽品牌/品类、调整距离范围），立即调整后重新查询；\n' +
  '2. 调整后仍满足不了需求的，先向候选人如实说明一次"暂时没有满足该条件的岗位"（不复读），' +
  '再按既有兜底调用 invite_to_group 拉群维护；\n' +
  '3. invite_to_group 返回群满（group_full）时按 no_match_or_group_full 调用 request_handoff 转人工；' +
  '返回该城市本就没有群（no_group_in_city / no_group_available）时按其 replyInstruction 自然收口、继续托管，不转人工；' +
  '候选人明确拒绝进群、点名要真人跟进、或场景确实无法用拉群维护时按 other 调用 request_handoff，' +
  '不要让候选人反复收到同样的"没有"。\n' +
  '另外：若你已向候选人承诺"扩大范围/帮你再查查"，本轮必须真的改变查询条件；严禁声称已扩大范围却原样重查。';
