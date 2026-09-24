import { HANDOFF_REASON_CATALOG } from '@enums/handoff-reason.enum';
import {
  CATEGORY_META,
  PRIORITY_LABELS,
  UNCLASSIFIED_LABEL,
  type InterventionTaskCategory,
} from '@notification/feishu-task/intervention-task-category';
import {
  CATEGORY_COLOR,
  FEISHU_OPTION_COLOR,
  PRIORITY_OPTION_COLOR,
  resolveOptionColorIndex,
  shade,
} from '@notification/feishu-task/intervention-task-colors';

describe('intervention-task-colors', () => {
  it('色相表：每 5 个一组取组首，范围 0–54；shade 取组内档位', () => {
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
    expect(shade('red', 0)).toBe(0);
    expect(shade('red', 3)).toBe(3);
    expect(shade('teal', 1)).toBe(21);
    expect(shade('gray', 4)).toBe(54);
  });

  it('介入大类：九个大类各自固定色相（组首）', () => {
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
      expect(resolveOptionColorIndex('reasonCode', item.label)).toBe(
        FEISHU_OPTION_COLOR[CATEGORY_COLOR[category]],
      );
      expect(resolveOptionColorIndex('reasonCode', item.label)).toBe(
        resolveOptionColorIndex('category', CATEGORY_META[category].label),
      );
    }
    // 入站风险类归 T7（紫）
    expect(resolveOptionColorIndex('reasonCode', '辱骂/攻击')).toBe(FEISHU_OPTION_COLOR.purple);
    expect(resolveOptionColorIndex('reasonCode', '投诉/举报风险')).toBe(FEISHU_OPTION_COLOR.purple);
    // other 归不了类 → gray；未归类 / 未知标签 → gray
    expect(resolveOptionColorIndex('reasonCode', '其他需人工处理')).toBe(FEISHU_OPTION_COLOR.gray);
    expect(resolveOptionColorIndex('reasonCode', UNCLASSIFIED_LABEL)).toBe(
      FEISHU_OPTION_COLOR.gray,
    );
    expect(resolveOptionColorIndex('reasonCode', '目录里没有的码')).toBe(FEISHU_OPTION_COLOR.gray);
  });

  it('优先级：急=红组第 3 档(3) / 当日=红组最浅(0) / 常规=灰(50)', () => {
    expect(PRIORITY_OPTION_COLOR).toEqual({
      [PRIORITY_LABELS.urgent]: 3,
      [PRIORITY_LABELS.today]: 0,
      [PRIORITY_LABELS.normal]: 50,
    });
    expect(resolveOptionColorIndex('priority', PRIORITY_LABELS.urgent)).toBe(3);
    expect(resolveOptionColorIndex('priority', PRIORITY_LABELS.today)).toBe(0);
    expect(resolveOptionColorIndex('priority', PRIORITY_LABELS.normal)).toBe(50);
    expect(resolveOptionColorIndex('priority', '未知')).toBe(FEISHU_OPTION_COLOR.gray);
  });

  it('托管账号一律蓝；其他字段 gray', () => {
    expect(resolveOptionColorIndex('hostingAccount', '东升')).toBe(FEISHU_OPTION_COLOR.blue);
    expect(resolveOptionColorIndex('hostingAccount', '任意账号')).toBe(FEISHU_OPTION_COLOR.blue);
    expect(resolveOptionColorIndex('nickname', '小明')).toBe(FEISHU_OPTION_COLOR.gray);
    expect(resolveOptionColorIndex('workOrderId', '555')).toBe(FEISHU_OPTION_COLOR.gray);
  });
});
