import {
  computeCandidateMessageWatermark,
  deriveFactsVersion,
  PRECHECK_SNAPSHOT_TTL_SECONDS,
} from '@memory/facts/candidate/precheck-snapshot.types';

describe('precheck-snapshot 消息水位与版本', () => {
  it('同批消息水位稳定（Bull 重试幂等的基石）', () => {
    const texts = ['我叫王玥', '13900000002'];
    expect(computeCandidateMessageWatermark(texts)).toBe(computeCandidateMessageWatermark([...texts]));
  });

  it('新消息追加后水位必变（快照失效判据）', () => {
    const before = computeCandidateMessageWatermark(['我叫王玥']);
    const after = computeCandidateMessageWatermark(['我叫王玥', '等等，号码换一个']);
    expect(after).not.toBe(before);
  });

  it('末条消息内容变化（同条数）水位也变', () => {
    expect(computeCandidateMessageWatermark(['a', '明天面试'])).not.toBe(
      computeCandidateMessageWatermark(['a', '后天面试']),
    );
  });

  it('空会话有确定水位，不抛错', () => {
    expect(computeCandidateMessageWatermark([])).toBe('0:0:');
  });

  it('deriveFactsVersion 确定性且随水位变化', () => {
    const w1 = computeCandidateMessageWatermark(['我叫王玥']);
    const w2 = computeCandidateMessageWatermark(['我叫王玥', '在吗']);
    expect(deriveFactsVersion(w1)).toBe(deriveFactsVersion(w1));
    expect(deriveFactsVersion(w1)).not.toBe(deriveFactsVersion(w2));
  });

  it('快照 TTL 为 2 小时', () => {
    expect(PRECHECK_SNAPSHOT_TTL_SECONDS).toBe(7200);
  });
});
