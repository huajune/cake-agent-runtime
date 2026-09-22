import {
  buildReconcileAnchorKey,
  findSnapshotDuplicate,
  isSnapshotEligibleWorkOrder,
  isWorkOrderOwnedByCandidate,
  normalizeSignupSource,
  toBookingSnapshotEntry,
} from '@tools/booking/booking-snapshot.util';
import { parseLocalDateTime } from '@infra/utils/date.util';

const NOW = parseLocalDateTime('2026-09-22 10:00:00')!.getTime();

describe('booking-snapshot.util', () => {
  describe('isSnapshotEligibleWorkOrder（状态在途 且 报名近 15 天或面试在未来）', () => {
    it('在途 + 报名近 15 天 → 入选', () => {
      expect(
        isSnapshotEligibleWorkOrder(
          { workOrderId: 1, currentStatus: '约面待确认', signUpTime: '2026-09-10 09:00:00' },
          NOW,
        ),
      ).toBe(true);
    });

    it('在途 + 老报名但面试在未来 → 入选（服务端按报名时间过滤会漏掉它）', () => {
      expect(
        isSnapshotEligibleWorkOrder(
          {
            workOrderId: 2,
            currentStatus: '约面成功',
            signUpTime: '2026-08-01 09:00:00',
            interviewTime: '2026-09-25 14:00',
          },
          NOW,
        ),
      ).toBe(true);
    });

    it('在途 + 老报名 + 面试已过 → 剔除', () => {
      expect(
        isSnapshotEligibleWorkOrder(
          {
            workOrderId: 3,
            currentStatus: '约面成功',
            signUpTime: '2026-08-01 09:00:00',
            interviewTime: '2026-08-05 14:00',
          },
          NOW,
        ),
      ).toBe(false);
    });

    it('非在途状态一律剔除（面试成功/约面取消）', () => {
      for (const currentStatus of ['面试成功', '约面取消', '上岗成功']) {
        expect(
          isSnapshotEligibleWorkOrder(
            { workOrderId: 4, currentStatus, signUpTime: '2026-09-21 09:00:00' },
            NOW,
          ),
        ).toBe(false);
      }
    });

    it('报名恰好 15 天边界入选，16 天且无未来面试剔除', () => {
      expect(
        isSnapshotEligibleWorkOrder(
          { workOrderId: 5, currentStatus: '约面待确认', signUpTime: '2026-09-07 10:00:00' },
          NOW,
        ),
      ).toBe(true);
      expect(
        isSnapshotEligibleWorkOrder(
          { workOrderId: 6, currentStatus: '约面待确认', signUpTime: '2026-09-06 09:00:00' },
          NOW,
        ),
      ).toBe(false);
    });
  });

  describe('isWorkOrderOwnedByCandidate（本人校验 fail-closed）', () => {
    it('海绵姓名与会话/档案任一姓名一致（忽略空白）→ 本人', () => {
      expect(isWorkOrderOwnedByCandidate({ rowCandidateName: '张 三' }, [null, '张三'])).toBe(true);
      expect(isWorkOrderOwnedByCandidate({ topCandidateName: '李四' }, ['李四', undefined])).toBe(
        true,
      );
    });

    it('海绵没有姓名或两边不一致 → 非本人', () => {
      expect(isWorkOrderOwnedByCandidate({}, ['张三'])).toBe(false);
      expect(isWorkOrderOwnedByCandidate({ rowCandidateName: '王五' }, ['张三'])).toBe(false);
      expect(isWorkOrderOwnedByCandidate({ rowCandidateName: '张三' }, [null, undefined])).toBe(
        false,
      );
    });

    it('工单行姓名优先于顶层姓名', () => {
      expect(
        isWorkOrderOwnedByCandidate({ rowCandidateName: '同行人', topCandidateName: '张三' }, [
          '张三',
        ]),
      ).toBe(false);
    });
  });

  describe('toBookingSnapshotEntry / normalizeSignupSource', () => {
    it('归一化 signupSource 并带出本人校验结果', () => {
      const entry = toBookingSnapshotEntry(
        {
          workOrderId: 88,
          jobId: 99,
          brandName: ' 肯德基 ',
          jobName: '服务员',
          signupSource: 'supplier',
          interviewTime: '2026-09-25 14:00',
          signUpTime: '2026-09-20 10:00:00',
        },
        { topCandidateName: '张三', knownNames: ['张三'] },
      );
      expect(entry).toMatchObject({
        workOrderId: 88,
        jobId: 99,
        brandName: '肯德基',
        signupSource: 'SUPPLIER',
        candidateName: '张三',
        ownedByCandidate: true,
        interviewTime: '2026-09-25 14:00',
      });
      expect(normalizeSignupSource('AI')).toBe('AI');
      expect(normalizeSignupSource('unknown')).toBeNull();
      expect(normalizeSignupSource(null)).toBeNull();
    });
  });

  describe('buildReconcileAnchorKey（稳定锚点）', () => {
    it('同工单同面试时间同键；面试时间变化（含由空变有值）换键；恢复后缀独立', () => {
      const a = buildReconcileAnchorKey({ workOrderId: 1, interviewTime: '2026-09-25 14:00' });
      expect(a).toBe('reconcile:wo1:iv2026-09-25_14:00');
      expect(buildReconcileAnchorKey({ workOrderId: 1, interviewTime: '2026-09-25 14:00' })).toBe(
        a,
      );
      expect(buildReconcileAnchorKey({ workOrderId: 1, interviewTime: null })).toBe(
        'reconcile:wo1:ivnone',
      );
      expect(
        buildReconcileAnchorKey({ workOrderId: 1, interviewTime: '2026-09-26 14:00' }),
      ).not.toBe(a);
      expect(
        buildReconcileAnchorKey({ workOrderId: 1, interviewTime: '2026-09-25 14:00' }, 'resumed'),
      ).toBe(`${a}:resumed`);
    });
  });

  describe('findSnapshotDuplicate（同岗位或同品牌在途即命中）', () => {
    const entries = [
      { workOrderId: 1, jobId: 100, brandName: '瑞幸' },
      { workOrderId: 2, jobId: 200, brandName: 'KFC' },
    ];

    it('同岗位命中', () => {
      expect(findSnapshotDuplicate(entries, { jobId: 200 })?.workOrderId).toBe(2);
    });

    it('不同岗位但同品牌命中（忽略大小写与空白）', () => {
      expect(findSnapshotDuplicate(entries, { jobId: 300, brandName: ' kfc ' })?.workOrderId).toBe(
        2,
      );
    });

    it('岗位与品牌都不同 → 不命中；目标无品牌时只按岗位', () => {
      expect(findSnapshotDuplicate(entries, { jobId: 300, brandName: '麦当劳' })).toBeUndefined();
      expect(findSnapshotDuplicate(entries, { jobId: 300 })).toBeUndefined();
    });
  });
});
