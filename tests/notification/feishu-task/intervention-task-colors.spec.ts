import { HANDOFF_REASON_CATALOG } from '@enums/handoff-reason.enum';
import {
  CATEGORY_META,
  PRIORITY_LABELS,
  UNCLASSIFIED_LABEL,
  type InterventionTaskCategory,
} from '@notification/feishu-task/intervention-task-category';
import {
  CATEGORY_COLOR,
  COULD_BE_AUTOMATED_OPTION_COLOR,
  FEISHU_OPTION_COLOR,
  STATUS_OPTION_COLOR,
  resolveOptionColorIndex,
  resolveOptionColorName,
} from '@notification/feishu-task/intervention-task-colors';
import {
  BACKFILL_FIELD_OPTIONS,
  TASK_STATUS_LABELS,
} from '@notification/feishu-task/intervention-task.service';

describe('intervention-task-colors', () => {
  it('色相表：每 5 个一组取最浅档，范围 0–54', () => {
    expect(FEISHU_OPTION_COLOR).toEqual({
      red: 0,
      orange: 5,
      yellow: 10,
      green: 15,
      teal: 20,
      cyan: 25,
      blue: 30,
      indigo: 35,
      purple: 40,
      pink: 45,
      gray: 50,
    });
    for (const index of Object.values(FEISHU_OPTION_COLOR)) {
      expect(index % 5).toBe(0);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThanOrEqual(54);
    }
  });

  it('介入大类：九个大类各自固定色相', () => {
    const expected: Record<InterventionTaskCategory, number> = {
      T1: FEISHU_OPTION_COLOR.red,
      T2: FEISHU_OPTION_COLOR.orange,
      T3: FEISHU_OPTION_COLOR.yellow,
      T4: FEISHU_OPTION_COLOR.green,
      T5: FEISHU_OPTION_COLOR.teal,
      T6: FEISHU_OPTION_COLOR.blue,
      T7: FEISHU_OPTION_COLOR.purple,
      T8: FEISHU_OPTION_COLOR.indigo,
      UNCLASSIFIED: FEISHU_OPTION_COLOR.gray,
    };
    for (const code of Object.keys(expected) as InterventionTaskCategory[]) {
      expect(resolveOptionColorIndex('category', CATEGORY_META[code].label)).toBe(expected[code]);
    }
    expect(resolveOptionColorIndex('category', '现场急件')).toBe(0);
    expect(resolveOptionColorIndex('category', '风险与合规')).toBe(40);
    expect(resolveOptionColorIndex('category', '不存在的大类')).toBe(FEISHU_OPTION_COLOR.gray);
  });

  it('原因码：每个权威目录 label 跟随所属大类同色', () => {
    for (const item of HANDOFF_REASON_CATALOG) {
      const category: InterventionTaskCategory = item.category ?? 'UNCLASSIFIED';
      expect(resolveOptionColorName('reasonCode', item.label)).toBe(CATEGORY_COLOR[category]);
      expect(resolveOptionColorIndex('reasonCode', item.label)).toBe(
        resolveOptionColorIndex('category', CATEGORY_META[category].label),
      );
    }
    // 入站风险类归 T7（紫）
    expect(resolveOptionColorIndex('reasonCode', '辱骂/攻击')).toBe(FEISHU_OPTION_COLOR.purple);
    expect(resolveOptionColorIndex('reasonCode', '投诉/维权风险')).toBe(FEISHU_OPTION_COLOR.purple);
    // other 归不了类 → gray；未归类 / 未知标签 → gray
    expect(resolveOptionColorIndex('reasonCode', '其他需人工处理')).toBe(FEISHU_OPTION_COLOR.gray);
    expect(resolveOptionColorIndex('reasonCode', UNCLASSIFIED_LABEL)).toBe(
      FEISHU_OPTION_COLOR.gray,
    );
    expect(resolveOptionColorIndex('reasonCode', '目录里没有的码')).toBe(FEISHU_OPTION_COLOR.gray);
  });

  it('优先级：急红 / 当日橙 / 常规灰', () => {
    expect(resolveOptionColorIndex('priority', PRIORITY_LABELS.urgent)).toBe(
      FEISHU_OPTION_COLOR.red,
    );
    expect(resolveOptionColorIndex('priority', PRIORITY_LABELS.today)).toBe(
      FEISHU_OPTION_COLOR.orange,
    );
    expect(resolveOptionColorIndex('priority', PRIORITY_LABELS.normal)).toBe(
      FEISHU_OPTION_COLOR.gray,
    );
    expect(resolveOptionColorIndex('priority', '未知')).toBe(FEISHU_OPTION_COLOR.gray);
  });

  it('状态 / 本可由蛋糕完成：配色键集与运营维护选项一致', () => {
    expect(Object.keys(STATUS_OPTION_COLOR)).toEqual(BACKFILL_FIELD_OPTIONS.status);
    expect(Object.keys(COULD_BE_AUTOMATED_OPTION_COLOR)).toEqual(
      BACKFILL_FIELD_OPTIONS.couldBeAutomated,
    );
    expect(resolveOptionColorIndex('status', TASK_STATUS_LABELS.pending)).toBe(
      FEISHU_OPTION_COLOR.orange,
    );
    expect(resolveOptionColorIndex('status', TASK_STATUS_LABELS.done)).toBe(
      FEISHU_OPTION_COLOR.green,
    );
    expect(resolveOptionColorIndex('status', '未知状态')).toBe(FEISHU_OPTION_COLOR.gray);
    expect(resolveOptionColorIndex('couldBeAutomated', '是')).toBe(FEISHU_OPTION_COLOR.green);
    expect(resolveOptionColorIndex('couldBeAutomated', '否')).toBe(FEISHU_OPTION_COLOR.gray);
  });

  it('托管账号一律蓝；其他字段 gray', () => {
    expect(resolveOptionColorIndex('hostingAccount', '东升')).toBe(FEISHU_OPTION_COLOR.blue);
    expect(resolveOptionColorIndex('hostingAccount', '任意账号')).toBe(FEISHU_OPTION_COLOR.blue);
    expect(resolveOptionColorIndex('nickname', '小明')).toBe(FEISHU_OPTION_COLOR.gray);
    expect(resolveOptionColorIndex('brandStore', '瑞幸-徐家汇店')).toBe(FEISHU_OPTION_COLOR.gray);
    expect(resolveOptionColorIndex('remark', '任意备注')).toBe(FEISHU_OPTION_COLOR.gray);
  });
});
