import { Logger } from '@nestjs/common';
import {
  HANDOFF_REASON_CATALOG,
  HANDOFF_TASK_CATEGORY,
  HANDOFF_TASK_CATEGORY_META,
} from '@enums/handoff-reason.enum';
import {
  CATEGORY_META,
  UNCLASSIFIED_LABEL,
  isUrgentReasonCode,
  maxPriority,
  parsePriority,
  resolveBasePriority,
  resolveReasonCodeLabel,
  resolveTaskCategory,
  sectionNameOf,
  type InterventionTaskCategory,
} from '@notification/feishu-task/intervention-task-category';

/**
 * 飞书任务大类模块不再自持原因码表：大类 / 标签 / 标急全部由权威目录派生，
 * 这里锁定派生关系与兜底语义。
 */
describe('intervention-task-category', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe('resolveTaskCategory', () => {
    it('目录里每个带大类的码都原样映射，other 归未归类', () => {
      for (const item of HANDOFF_REASON_CATALOG) {
        expect(resolveTaskCategory(item.code)).toBe(item.category ?? 'UNCLASSIFIED');
      }
      expect(resolveTaskCategory('other')).toBe('UNCLASSIFIED');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('入站风险类型归 T7', () => {
      for (const code of [
        'abuse',
        'complaint_risk',
        'escalation',
        'human_handoff_request',
        'disability_disclosure',
      ]) {
        expect(resolveTaskCategory(code)).toBe('T7');
      }
    });

    it('空码归未归类，不记警告', () => {
      expect(resolveTaskCategory(null)).toBe('UNCLASSIFIED');
      expect(resolveTaskCategory(undefined)).toBe('UNCLASSIFIED');
      expect(resolveTaskCategory('')).toBe('UNCLASSIFIED');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('目录里查无此码时回退 T2 并记警告', () => {
      expect(resolveTaskCategory('not_a_real_code')).toBe('T2');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('not_a_real_code');
    });
  });

  describe('resolveReasonCodeLabel / isUrgentReasonCode', () => {
    it('标签与标急取自权威目录', () => {
      for (const item of HANDOFF_REASON_CATALOG) {
        expect(resolveReasonCodeLabel(item.code)).toBe(item.label);
        expect(isUrgentReasonCode(item.code)).toBe(item.urgent);
      }
    });

    it('空码 / 未知码标签为未归类且不标急', () => {
      expect(resolveReasonCodeLabel(null)).toBe(UNCLASSIFIED_LABEL);
      expect(resolveReasonCodeLabel('not_a_real_code')).toBe(UNCLASSIFIED_LABEL);
      expect(isUrgentReasonCode(null)).toBe(false);
      expect(isUrgentReasonCode('not_a_real_code')).toBe(false);
    });
  });

  describe('CATEGORY_META', () => {
    it('覆盖枚举全部大类 + 未归类，名称与枚举一致', () => {
      const enumCodes = Object.values(HANDOFF_TASK_CATEGORY);
      expect(Object.keys(CATEGORY_META).sort()).toEqual([...enumCodes, 'UNCLASSIFIED'].sort());
      for (const code of enumCodes) {
        expect(CATEGORY_META[code].code).toBe(code);
        expect(CATEGORY_META[code].label).toBe(HANDOFF_TASK_CATEGORY_META[code].name);
      }
      expect(CATEGORY_META.UNCLASSIFIED.label).toBe(UNCLASSIFIED_LABEL);
    });

    it('负责人取向与枚举文案一致：T7 主管，T4/T5/T8 单独配置，其余托管账号', () => {
      const expectedOwner: Record<InterventionTaskCategory, string> = {
        T1: 'hosting_account',
        T2: 'hosting_account',
        T3: 'hosting_account',
        T4: 'configured',
        T5: 'configured',
        T6: 'hosting_account',
        T7: 'supervisor',
        T8: 'configured',
        UNCLASSIFIED: 'hosting_account',
      };
      for (const [code, owner] of Object.entries(expectedOwner)) {
        expect(CATEGORY_META[code as InterventionTaskCategory].owner).toBe(owner);
      }
    });

    it('每个大类有语义表情；分组名 = 表情 + 大类名，标题/单选文案不受影响', () => {
      const expectedIcon: Record<InterventionTaskCategory, string> = {
        T1: '🚨',
        T2: '📅',
        T3: '🤝',
        T4: '💰',
        T5: '📋',
        T6: '⚙️',
        T7: '⚠️',
        T8: '📱',
        UNCLASSIFIED: '❓',
      };
      for (const [code, icon] of Object.entries(expectedIcon)) {
        const category = code as InterventionTaskCategory;
        expect(CATEGORY_META[category].icon).toBe(icon);
        expect(sectionNameOf(category)).toBe(`${icon} ${CATEGORY_META[category].label}`);
        expect(sectionNameOf(category)).not.toMatch(/^T\d /);
      }
      expect(sectionNameOf('T1')).toBe('🚨 现场急件');
      expect(sectionNameOf('UNCLASSIFIED')).toBe('❓ 未归类');
      expect(CATEGORY_META.T1.label).toBe('现场急件'); // 单选选项文案不带表情
    });

    it('面试上限只对 T2、T6 生效', () => {
      const applies = Object.values(CATEGORY_META)
        .filter((meta) => meta.interviewCapApplies)
        .map((meta) => meta.code);
      expect(applies.sort()).toEqual(['T2', 'T6']);
    });
  });

  describe('resolveBasePriority', () => {
    it('标急码直接 urgent；在职事务只有工伤标急；其余取大类默认', () => {
      expect(
        resolveBasePriority({ category: 'T2', reasonCode: 'modify_appointment', reasonText: '' }),
      ).toBe('urgent');
      expect(
        resolveBasePriority({
          category: 'T3',
          reasonCode: 'employment_affairs',
          reasonText: '候选人说上班工伤了',
        }),
      ).toBe('urgent');
      expect(
        resolveBasePriority({
          category: 'T3',
          reasonCode: 'employment_affairs',
          reasonText: '问离职手续',
        }),
      ).toBe('today');
      expect(
        resolveBasePriority({ category: 'T5', reasonCode: 'salary_admin_inquiry', reasonText: '' }),
      ).toBe('normal');
      expect(
        resolveBasePriority({ category: 'UNCLASSIFIED', reasonCode: null, reasonText: '' }),
      ).toBe('today');
    });
  });

  it('maxPriority / parsePriority', () => {
    expect(maxPriority('normal', 'today')).toBe('today');
    expect(maxPriority('urgent', 'today')).toBe('urgent');
    expect(parsePriority('urgent')).toBe('urgent');
    expect(parsePriority('nope')).toBeNull();
    expect(parsePriority(undefined)).toBeNull();
  });
});
