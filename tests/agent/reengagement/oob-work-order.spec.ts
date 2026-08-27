import { evaluateOutOfBandWorkOrders } from '@agent/reengagement/oob-work-order';
import type { SignupWorkOrderItem } from '@sponge/sponge.types';

describe('evaluateOutOfBandWorkOrders（pre_booking 带外工单核验，human_oob P1）', () => {
  const NOW = Date.parse('2026-07-28T10:00:00+08:00');
  const DAY = 24 * 60 * 60 * 1000;

  const order = (overrides: Partial<SignupWorkOrderItem>): SignupWorkOrderItem =>
    ({ workOrderId: 900001, ...overrides }) as SignupWorkOrderItem;

  it('约面成功（带外约面在途）→ 停（badcase recvqgvKqRAcKg：经理手工约面仍被复聊骚扰）', () => {
    const verdict = evaluateOutOfBandWorkOrders(
      [order({ currentStatus: '约面成功', interviewTime: '2026-07-29 14:00' })],
      NOW,
    );
    expect(verdict).toMatchObject({ stop: true, reason: 'oob_work_order_active:约面成功' });
  });

  it('约面待确认且无面试时间（等通知单）→ 停', () => {
    const verdict = evaluateOutOfBandWorkOrders(
      [order({ currentStatus: '约面待确认', interviewTime: null })],
      NOW,
    );
    expect(verdict).toMatchObject({ stop: true, reason: 'oob_work_order_active:约面待确认' });
  });

  it('约面成功但面试时间已过去 4 天未推进（僵尸单）→ 放行', () => {
    const stale = new Date(NOW - 4 * DAY).toISOString().slice(0, 16).replace('T', ' ');
    expect(
      evaluateOutOfBandWorkOrders(
        [order({ currentStatus: '约面成功', interviewTime: stale })],
        NOW,
      ),
    ).toBeNull();
  });

  it('面试成功且近期通过 → 停（badcase recvqgxF51YhD8：已面试过还追问）', () => {
    const verdict = evaluateOutOfBandWorkOrders(
      [order({ currentStatus: '面试成功', interviewPassTime: '2026-07-25 15:00' })],
      NOW,
    );
    expect(verdict).toMatchObject({ stop: true, reason: 'oob_work_order_progressed:面试成功' });
  });

  it('面试成功但通过时间在 30 天窗口外 → 放行（候选人可能重新找工作）', () => {
    expect(
      evaluateOutOfBandWorkOrders(
        [order({ currentStatus: '面试成功', interviewPassTime: '2026-05-01 15:00' })],
        NOW,
      ),
    ).toBeNull();
  });

  it('面试成功但无通过时间（无法判旧）→ 保守停', () => {
    expect(evaluateOutOfBandWorkOrders([order({ currentStatus: '面试成功' })], NOW)).toMatchObject({
      stop: true,
    });
  });

  it('上岗成功（在职中）→ 停', () => {
    expect(evaluateOutOfBandWorkOrders([order({ currentStatus: '上岗成功' })], NOW)).toMatchObject({
      stop: true,
      reason: 'oob_work_order_progressed:上岗成功',
    });
  });

  it.each(['约面失败', '约面取消', '面试失败', '上岗失败', '已离职'])(
    '终结态「%s」→ 放行（流程已结束且候选人仍可求职）',
    (status) => {
      expect(evaluateOutOfBandWorkOrders([order({ currentStatus: status })], NOW)).toBeNull();
    },
  );

  it('多工单：任一在途即停，全部终结态才放行', () => {
    const orders = [
      order({ currentStatus: '约面取消' }),
      order({ workOrderId: 900002, currentStatus: '约面待确认' }),
    ];
    expect(evaluateOutOfBandWorkOrders(orders, NOW)).toMatchObject({
      stop: true,
      workOrderId: 900002,
    });
  });

  it('空列表 / 无状态字段 → 放行', () => {
    expect(evaluateOutOfBandWorkOrders([], NOW)).toBeNull();
    expect(evaluateOutOfBandWorkOrders([order({ currentStatus: null })], NOW)).toBeNull();
  });
});
