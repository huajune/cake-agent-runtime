import {
  FIELD_LABELS,
  FIELD_ORDER,
  TEMPLATE_CORE_FIELDS,
  formatTemplateFieldLabel,
} from '@/tools/duliday/precheck/checklist.util';
import { CANDIDATE_CLAIM_FIELDS } from '@resolution/evidence/claim.types';
import { STRATEGY_CONFIG_STATUSES } from '@/biz/strategy/entities/strategy-config.entity';
import { HUAJUNE_SOURCE_PLATFORMS } from '@/biz/huajune/huajune.types';

/**
 * 词表单一居所守卫（期 2：报名/收资/观测链）。
 *
 * 核心是 checklist 字段名：它被别处当 **map 的键**用来定位 checklist 条目，
 * 原先那些 map 的值类型是裸 string，写错一个字不报错，只让
 * `delete knownFieldMap[...]` 静默落空——被裁决 rejected 的无据裸值就此照进报名。
 */
describe('词表单一居所 · 期 2', () => {
  describe('checklist 字段名', () => {
    it('FIELD_ORDER 取值与顺序不变（收资模板渲染顺序依赖它）', () => {
      expect([...FIELD_ORDER]).toEqual([
        '姓名',
        '联系电话',
        '性别',
        '年龄',
        '是否暑假工',
        '面试时间',
        '学历',
        '健康证情况',
        '健康证类型',
        '身份',
        '户籍省份',
        '身高',
        '体重',
        '简历附件',
        '过往公司+岗位+年限',
        '应聘门店',
        '应聘岗位',
      ]);
    });

    it('TEMPLATE_CORE_FIELDS 是 FIELD_ORDER 的子集且顺序不变', () => {
      expect([...TEMPLATE_CORE_FIELDS]).toEqual([
        '姓名',
        '联系电话',
        '性别',
        '年龄',
        '面试时间',
        '应聘门店',
      ]);
      for (const f of TEMPLATE_CORE_FIELDS) {
        expect(FIELD_ORDER as readonly string[]).toContain(f);
      }
    });

    it('FIELD_LABELS 刻意部分覆盖：只重命名 6 个，其余走原名', () => {
      const keys = Object.keys(FIELD_LABELS);
      expect(keys.length).toBe(6);
      for (const k of keys) expect(FIELD_ORDER as readonly string[]).toContain(k);
      // 未登记的字段回退原名——这是 Partial 表的既有语义，不是缺陷
      expect(formatTemplateFieldLabel('姓名')).toBe('姓名');
      expect(formatTemplateFieldLabel('联系电话')).toBe('联系方式');
      // 未知字段（API 可能返回 FIELD_ORDER 外的名字）也回退原名
      expect(formatTemplateFieldLabel('某个新字段')).toBe('某个新字段');
    });

    it('每个 claim 字段都能映射到一个合法 checklist 字段名（防伪造闸门的前提）', () => {
      // CLAIM_FIELD_TO_CHECKLIST 是 precheck 内部常量，这里从两端断言其可满足性：
      // 10 个 claim 字段各自对应的 checklist 名必须都在 FIELD_ORDER 里。
      // 真正的逐项保证由 Record<CandidateClaimField, ChecklistField> 在编译期完成。
      const expected: Record<string, string> = {
        name: '姓名',
        phone: '联系电话',
        gender: '性别',
        age: '年龄',
        isStudent: '身份',
        education: '学历',
        healthCertificate: '健康证情况',
        height: '身高',
        weight: '体重',
        householdProvince: '户籍省份',
      };
      expect(Object.keys(expected).sort()).toEqual([...CANDIDATE_CLAIM_FIELDS].sort());
      for (const checklistName of Object.values(expected)) {
        expect(FIELD_ORDER as readonly string[]).toContain(checklistName);
      }
    });
  });

  describe('白名单常量不再手抄', () => {
    it('STRATEGY_CONFIG_STATUSES 取值与顺序不变', () => {
      expect([...STRATEGY_CONFIG_STATUSES]).toEqual(['testing', 'released', 'archived']);
    });

    it('HUAJUNE_SOURCE_PLATFORMS 取值与顺序不变', () => {
      expect([...HUAJUNE_SOURCE_PLATFORMS]).toEqual(['zhipin', 'yupao', 'duliday']);
    });
  });
});
