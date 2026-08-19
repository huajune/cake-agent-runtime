import type { CandidateClaimField } from './claim.types';
import { candidateValuesEquivalent } from './normalize';
import type { PrecheckSnapshot } from './snapshot';

/**
 * booking 快照对账闸（方案 §6.3 / Phase 3）。
 *
 * 验证模型最终提交的 booking payload 与 precheck 裁决快照的一致性，拦截
 * "precheck 之后模型从 Prompt 旧资料重新拼 payload" 的分叉。§10 灰度纪律：
 * 当前为差异记录形态（shadow）——对账结果只落观测事件与日志，不拦截提交；
 * 差异率稳定后由 enforce 开关切强制。
 *
 * 对账范围刻意从窄启动：name/phone/age/gender/height/weight/healthCert 七字段
 * 的值可与 claim 值直接归一比较（gender 1/2、健康证 1/2/3 的枚举换算已在
 * candidateValuesEquivalent 内收口）；educationId/householdRegisterProvinceId
 * 是 Sponge 数字 ID，与 claim 标签值的映射对账留给 enforce 前增强，本期不判。
 */

export interface SnapshotGatePayload {
  name: string;
  phone: string;
  age: number;
  genderId: number;
  height?: number;
  weight?: number;
  hasHealthCertificate?: number;
}

export interface SnapshotGateResult {
  /** 不一致字段名；含两个伪字段：message_watermark_changed / job_id_changed。 */
  mismatchedFields: string[];
}

const PAYLOAD_FIELD_MAP: Array<{
  field: CandidateClaimField;
  read: (payload: SnapshotGatePayload) => unknown;
}> = [
  { field: 'name', read: (p) => p.name },
  { field: 'phone', read: (p) => p.phone },
  { field: 'age', read: (p) => p.age },
  { field: 'gender', read: (p) => p.genderId },
  { field: 'height', read: (p) => p.height },
  { field: 'weight', read: (p) => p.weight },
  { field: 'healthCertificate', read: (p) => p.hasHealthCertificate },
];

export function evaluateSnapshotGate(params: {
  snapshot: PrecheckSnapshot;
  payload: SnapshotGatePayload;
  jobId: number;
  currentMessageWatermark: string;
}): SnapshotGateResult {
  const mismatchedFields: string[] = [];

  // 水位失效：precheck 之后候选人又发了消息，快照裁决所依据的会话已过期
  //（方案 §6.3-4：中止旧 booking、合并最新消息重新执行）。
  if (params.snapshot.messageWatermark !== params.currentMessageWatermark) {
    mismatchedFields.push('message_watermark_changed');
  }
  if (params.snapshot.jobId !== params.jobId) {
    mismatchedFields.push('job_id_changed');
  }

  for (const { field, read } of PAYLOAD_FIELD_MAP) {
    const payloadValue = read(params.payload);
    if (payloadValue === undefined || payloadValue === null || payloadValue === '') continue;

    const adjudicated = params.snapshot.effectiveProfile.fields[field];
    if (!adjudicated || adjudicated.status !== 'accepted' || adjudicated.value === null) {
      // 模型提交了快照中无已裁决来源的值（方案 §6.3-3"不一致且没有新证据"雏形）。
      mismatchedFields.push(`${field}:no_adjudicated_source`);
      continue;
    }
    if (!candidateValuesEquivalent(field, adjudicated.value, payloadValue)) {
      mismatchedFields.push(field);
    }
  }

  return { mismatchedFields };
}
