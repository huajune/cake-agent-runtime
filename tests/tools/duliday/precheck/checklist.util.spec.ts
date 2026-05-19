import {
  buildChecklistTemplate,
  buildEnumHintsForMissing,
  buildKnownFieldMap,
  canonicalizeChecklistFields,
  FIELD_LABELS,
  FIELD_ORDER,
  formatTemplateFieldLabel,
  normalizeChecklistField,
  orderFields,
  TEMPLATE_CORE_FIELDS,
} from '@tools/duliday/precheck/checklist.util';

describe('checklist.util', () => {
  describe('normalizeChecklistField', () => {
    it('canonicalizes phone variants', () => {
      expect(normalizeChecklistField('联系电话')).toBe('联系电话');
      expect(normalizeChecklistField('联系方式')).toBe('联系电话');
      expect(normalizeChecklistField('电话')).toBe('联系电话');
    });

    it('canonicalizes health-cert variants', () => {
      expect(normalizeChecklistField('健康证')).toBe('健康证情况');
      expect(normalizeChecklistField('健康证情况')).toBe('健康证情况');
      expect(normalizeChecklistField('有无健康证')).toBe('健康证情况');
    });

    it('canonicalizes 户籍 variants', () => {
      expect(normalizeChecklistField('籍贯')).toBe('户籍省份');
      expect(normalizeChecklistField('户籍')).toBe('户籍省份');
      expect(normalizeChecklistField('户籍省份')).toBe('户籍省份');
    });

    it('canonicalizes 身份 / 是否学生 to 身份', () => {
      expect(normalizeChecklistField('身份')).toBe('身份');
      expect(normalizeChecklistField('是否学生')).toBe('身份');
    });

    it('canonicalizes 简历 / 简历附件', () => {
      expect(normalizeChecklistField('简历')).toBe('简历附件');
      expect(normalizeChecklistField('简历附件')).toBe('简历附件');
    });

    it('canonicalizes experience variants', () => {
      expect(normalizeChecklistField('过往公司+岗位+年限')).toBe('过往公司+岗位+年限');
      expect(normalizeChecklistField('工作经历')).toBe('过往公司+岗位+年限');
      expect(normalizeChecklistField('工作经验')).toBe('过往公司+岗位+年限');
    });

    it('canonicalizes 面试日期 → 面试时间', () => {
      expect(normalizeChecklistField('面试日期')).toBe('面试时间');
    });

    it('returns "" for empty input', () => {
      expect(normalizeChecklistField('')).toBe('');
      expect(normalizeChecklistField(null)).toBe('');
      expect(normalizeChecklistField(undefined)).toBe('');
    });

    it('passes through unknown fields verbatim', () => {
      expect(normalizeChecklistField('自定义字段')).toBe('自定义字段');
    });
  });

  describe('canonicalizeChecklistFields', () => {
    it('dedupes by canonical form, preserving first-seen order', () => {
      expect(canonicalizeChecklistFields(['联系电话', '联系方式', '电话', '姓名'])).toEqual([
        '联系电话',
        '姓名',
      ]);
    });

    it('skips empty / unknown-empty inputs', () => {
      expect(canonicalizeChecklistFields(['', '姓名'])).toEqual(['姓名']);
    });
  });

  describe('orderFields', () => {
    it('returns canonical FIELD_ORDER intersection, then unknown fields sorted', () => {
      const out = orderFields(['年龄', '自定义A', '姓名', '自定义C', '联系电话']);
      // FIELD_ORDER-known come first in order; unknown alphabetized at end
      expect(out.slice(0, 3)).toEqual(['姓名', '联系电话', '年龄']);
      expect(out.slice(3)).toEqual(['自定义A', '自定义C']);
    });

    it('drops duplicates', () => {
      expect(orderFields(['姓名', '姓名', '联系电话'])).toEqual(['姓名', '联系电话']);
    });
  });

  describe('formatTemplateFieldLabel', () => {
    it('substitutes FIELD_LABELS overrides', () => {
      expect(formatTemplateFieldLabel('联系电话')).toBe(FIELD_LABELS['联系电话']);
      expect(formatTemplateFieldLabel('身份')).toBe(FIELD_LABELS['身份']);
    });

    it('returns the field itself when no override exists', () => {
      expect(formatTemplateFieldLabel('姓名')).toBe('姓名');
    });
  });

  describe('FIELD_ORDER / TEMPLATE_CORE_FIELDS sanity', () => {
    it('TEMPLATE_CORE_FIELDS is a subset of FIELD_ORDER', () => {
      for (const field of TEMPLATE_CORE_FIELDS) {
        expect(FIELD_ORDER).toContain(field);
      }
    });
  });

  describe('buildKnownFieldMap', () => {
    it('prefers sessionInterviewInfo over profile when both have a value', () => {
      const map = buildKnownFieldMap({
        sessionInterviewInfo: { name: '张三', phone: '13800000000' },
        contextProfile: { name: '李四', phone: '13900000000' },
      });
      expect(map['姓名']).toBe('张三');
      expect(map['联系电话']).toBe('13800000000');
    });

    it('falls back to profile when sessionInterviewInfo is empty', () => {
      const map = buildKnownFieldMap({
        sessionInterviewInfo: null,
        contextProfile: { name: '李四', phone: '13900000000', age: '30' },
      });
      expect(map['姓名']).toBe('李四');
      expect(map['年龄']).toBe('30');
      // age 30 ≥ 25, identity inferred as 社会人士
      expect(map['身份']).toBe('社会人士');
    });

    it('uses storeName / jobName overrides when provided', () => {
      const map = buildKnownFieldMap({
        sessionInterviewInfo: { applied_store: '老门店', applied_position: '老岗位' },
        contextProfile: null,
        storeName: '新门店',
        jobName: '新岗位',
      });
      expect(map['应聘门店']).toBe('新门店');
      expect(map['应聘岗位']).toBe('新岗位');
    });

    it('omits fields with no value', () => {
      const map = buildKnownFieldMap({
        sessionInterviewInfo: { name: '张三' },
        contextProfile: null,
      });
      expect(map['姓名']).toBe('张三');
      expect(map['联系电话']).toBeUndefined();
      expect(map['年龄']).toBeUndefined();
    });

    it('joins health_certificate_types array via 、', () => {
      const map = buildKnownFieldMap({
        sessionInterviewInfo: { health_certificate_types: ['食品类', '公共场所'] },
        contextProfile: null,
      });
      expect(map['健康证类型']).toBe('食品类、公共场所');
    });

    it('coerces number height/weight to string', () => {
      const map = buildKnownFieldMap({
        sessionInterviewInfo: { height: 170, weight: 60 },
        contextProfile: null,
      });
      expect(map['身高']).toBe('170');
      expect(map['体重']).toBe('60');
    });
  });

  describe('buildChecklistTemplate', () => {
    it('always includes TEMPLATE_CORE_FIELDS even when API requiredFields omits them (badcase #2)', () => {
      const result = buildChecklistTemplate({
        requiredFields: ['年龄'], // API only requested 年龄 — core skeleton must still appear
        knownFieldMap: {},
      });
      for (const core of TEMPLATE_CORE_FIELDS) {
        expect(result.displayOrder).toContain(core);
      }
      expect(result.templateText).toContain('面试要求：');
      expect(result.templateText).toContain('姓名：');
    });

    it('marks fields without known values as missingFields', () => {
      const result = buildChecklistTemplate({
        requiredFields: ['姓名', '联系电话', '面试时间'],
        knownFieldMap: { 姓名: '张三' },
      });
      expect(result.missingFields).not.toContain('姓名');
      expect(result.missingFields).toContain('联系电话');
      expect(result.missingFields).toContain('面试时间');
    });

    it('canonicalizes alias fields in requiredFields before rendering', () => {
      const result = buildChecklistTemplate({
        requiredFields: ['联系方式', '电话', '面试日期'], // alias forms
        knownFieldMap: {},
      });
      expect(result.requiredFields).toEqual(expect.arrayContaining(['联系电话', '面试时间']));
      // 不应该把同一字段重复列出
      const phoneCount = result.displayOrder.filter((f) => f === '联系电话').length;
      expect(phoneCount).toBe(1);
    });

    it('uses FIELD_LABELS overrides when rendering templateText', () => {
      const result = buildChecklistTemplate({
        requiredFields: ['联系电话', '身份'],
        knownFieldMap: {},
      });
      expect(result.templateText).toContain('联系方式：');
      expect(result.templateText).toContain('身份（学生/社会人士）：');
    });
  });

  describe('buildEnumHintsForMissing', () => {
    it('emits hints only for fields in missingFields', () => {
      const hints = buildEnumHintsForMissing(['性别']);
      expect(hints).toHaveProperty('gender');
      expect(hints).not.toHaveProperty('education');
    });

    it('treats 籍贯 / 户籍 / 户籍省份 as a single province hint', () => {
      const hints = buildEnumHintsForMissing(['籍贯']);
      expect(hints.householdRegisterProvince?.length).toBeGreaterThan(0);
    });

    it('emits both healthCertificate and healthCertificateTypes when both are missing', () => {
      const hints = buildEnumHintsForMissing(['健康证情况', '健康证类型']);
      expect(hints.healthCertificate).toEqual(['有', '无']);
      expect(hints.healthCertificateTypes?.length).toBeGreaterThan(0);
    });

    it('emits identity 学生/社会人士 when 身份 is missing', () => {
      const hints = buildEnumHintsForMissing(['身份']);
      expect(hints.identity).toEqual(['学生', '社会人士']);
    });

    it('returns empty object when no relevant missingFields', () => {
      expect(buildEnumHintsForMissing(['姓名', '联系电话'])).toEqual({});
    });
  });
});
