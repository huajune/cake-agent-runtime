import { evaluateSnapshotGate } from '@resolution/evidence/snapshot-gate';
import type { PrecheckSnapshot } from '@resolution/evidence/snapshot';
import { computeCandidateMessageWatermark } from '@resolution/evidence/snapshot';

function buildSnapshot(overrides?: Partial<PrecheckSnapshot>): PrecheckSnapshot {
  return {
    precheckId: 'pc_turn1_100',
    factsVersion: 1,
    messageWatermark: computeCandidateMessageWatermark(['我叫王玥', '13900000002']),
    jobId: 100,
    effectiveProfile: {
      factsVersion: 1,
      messageWatermark: 'w',
      fields: {
        name: { value: '王玥', status: 'accepted' },
        phone: { value: '13900000002', status: 'accepted' },
        age: { value: 24, status: 'accepted' },
        gender: { value: '女', status: 'accepted' },
      },
    },
    acceptedClaimIds: [],
    missingFields: [],
    createdAt: '2026-08-05T10:00:00+08:00',
    expiresAt: '2026-08-05T12:00:00+08:00',
    ...overrides,
  };
}

const MATCHING_PAYLOAD = { name: '王玥', phone: '13900000002', age: 24, genderId: 2 };

describe('booking 快照对账闸（证据化方案 §12 条目 10/11/12）', () => {
  it('payload 与快照一致 + 水位未变 → 零差异放行', () => {
    const gate = evaluateSnapshotGate({
      snapshot: buildSnapshot(),
      payload: MATCHING_PAYLOAD,
      jobId: 100,
      currentMessageWatermark: computeCandidateMessageWatermark(['我叫王玥', '13900000002']),
    });
    expect(gate.mismatchedFields).toEqual([]);
  });

  it('§12-11 booking 提交值与快照不一致 → 记录差异字段', () => {
    const gate = evaluateSnapshotGate({
      snapshot: buildSnapshot(),
      payload: { ...MATCHING_PAYLOAD, phone: '13800000001' },
      jobId: 100,
      currentMessageWatermark: computeCandidateMessageWatermark(['我叫王玥', '13900000002']),
    });
    expect(gate.mismatchedFields).toContain('phone');
  });

  it('§12-10/12 precheck 后候选人发新消息（水位变化）→ 快照失效', () => {
    const gate = evaluateSnapshotGate({
      snapshot: buildSnapshot(),
      payload: MATCHING_PAYLOAD,
      jobId: 100,
      currentMessageWatermark: computeCandidateMessageWatermark([
        '我叫王玥',
        '13900000002',
        '等等，电话换一个',
      ]),
    });
    expect(gate.mismatchedFields).toContain('message_watermark_changed');
  });

  it('§12-12 同批输入重放（水位相同）→ 快照仍有效，不误伤 Bull 重试', () => {
    const watermark = computeCandidateMessageWatermark(['我叫王玥', '13900000002']);
    const gate = evaluateSnapshotGate({
      snapshot: buildSnapshot({ messageWatermark: watermark }),
      payload: MATCHING_PAYLOAD,
      jobId: 100,
      currentMessageWatermark: watermark,
    });
    expect(gate.mismatchedFields).toEqual([]);
  });

  it('模型提交快照中无已裁决来源的值 → no_adjudicated_source', () => {
    const gate = evaluateSnapshotGate({
      snapshot: buildSnapshot(),
      payload: { ...MATCHING_PAYLOAD, height: 170 },
      jobId: 100,
      currentMessageWatermark: computeCandidateMessageWatermark(['我叫王玥', '13900000002']),
    });
    expect(gate.mismatchedFields).toContain('height:no_adjudicated_source');
  });

  it('gender 数字 ID 与标签跨形态等价（2 ≡ 女）', () => {
    const gate = evaluateSnapshotGate({
      snapshot: buildSnapshot(),
      payload: MATCHING_PAYLOAD,
      jobId: 100,
      currentMessageWatermark: computeCandidateMessageWatermark(['我叫王玥', '13900000002']),
    });
    expect(gate.mismatchedFields).not.toContain('gender');
  });

  it('jobId 与快照不一致 → job_id_changed', () => {
    const gate = evaluateSnapshotGate({
      snapshot: buildSnapshot(),
      payload: MATCHING_PAYLOAD,
      jobId: 999,
      currentMessageWatermark: computeCandidateMessageWatermark(['我叫王玥', '13900000002']),
    });
    expect(gate.mismatchedFields).toContain('job_id_changed');
  });
});
