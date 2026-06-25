import {
  AUTHORITATIVE_PROVENANCE,
  isFieldAuthoritative,
  normalizeEducationToId,
  normalizeGenderToId,
  normalizeHealthCertToId,
  normalizeProvinceToId,
  parseAge,
  parseCandidateFieldsFromText,
  parseEducation,
  parseGender,
  parseHealthCert,
  parseHouseholdProvince,
  parseName,
  parsePhone,
} from '@tools/shared/candidate-field-parser';

describe('candidate-field-parser', () => {
  describe('parsePhone', () => {
    it('extracts an 11-digit mobile number', () => {
      expect(parsePhone('我的电话是13912345678哈')).toBe('13912345678');
    });
    it('rejects non-mobile digit runs', () => {
      expect(parsePhone('订单号 02112345678901')).toBeNull();
      expect(parsePhone('12345678901')).toBeNull(); // 不是 1[3-9] 号段
    });
  });

  describe('parseAge', () => {
    it('reads keyed and "N岁" forms', () => {
      expect(parseAge('年龄：28')).toBe(28);
      expect(parseAge('我今年35岁')).toBe(35);
    });
    it('drops out-of-range ages', () => {
      expect(parseAge('我家娃8岁')).toBeNull();
      expect(parseAge('年龄：99')).toBeNull();
    });
  });

  describe('parseGender', () => {
    it('reads explicit gender statements', () => {
      expect(parseGender('性别：男')).toBe('男');
      expect(parseGender('我是女的')).toBe('女');
    });
    it('does not misfire on unrelated 男/女 words', () => {
      expect(parseGender('想找女装门店的岗位')).toBeNull();
    });
  });

  describe('parseHouseholdProvince', () => {
    it('extracts province under a household anchor', () => {
      expect(parseHouseholdProvince('户籍是黑龙江')).toBe('黑龙江');
      expect(parseHouseholdProvince('老家四川的')).toBe('四川');
    });
    it('returns null without anchor', () => {
      expect(parseHouseholdProvince('我在四川工作')).toBeNull();
    });
  });

  describe('parseHealthCert', () => {
    it('maps 有/无/无且不办 to 1/2/3', () => {
      expect(parseHealthCert('我有健康证')).toBe(1);
      expect(parseHealthCert('没有健康证')).toBe(2);
      expect(parseHealthCert('没有健康证，也不愿意办')).toBe(3);
    });
    it('returns null when 健康证 not mentioned', () => {
      expect(parseHealthCert('我想了解岗位')).toBeNull();
    });
  });

  describe('parseEducation', () => {
    it('maps free text to Sponge labels', () => {
      expect(parseEducation('我是大专')).toBe('大专');
      expect(parseEducation('本科毕业')).toBe('本科');
      expect(parseEducation('研究生')).toBe('硕士');
    });
  });

  describe('parseName', () => {
    it('accepts structured and declared real names', () => {
      expect(parseName('姓名：王建国')).toBe('王建国');
      expect(parseName('我叫李雷')).toBe('李雷');
    });
    it('rejects auto-greeting nicknames ("我是X")', () => {
      // "我是X" 打招呼语不算真名（无结构化/我叫锚点）
      expect(parseName('我是小晴早点睡')).toBeNull();
    });
    it('rejects non-real-name strings', () => {
      expect(parseName('姓名：测试用户')).toBeNull();
      expect(parseName('我叫abc')).toBeNull();
    });
  });

  describe('normalizers align to Sponge contract', () => {
    it('gender → 1/2', () => {
      expect(normalizeGenderToId('男')).toBe(1);
      expect(normalizeGenderToId('女')).toBe(2);
      expect(normalizeGenderToId('其他')).toBeNull();
    });
    it('healthCert → 1/2/3 (NOT 0/1)', () => {
      expect(normalizeHealthCertToId(1)).toBe(1);
      expect(normalizeHealthCertToId('无但接受办理健康证')).toBe(2);
      expect(normalizeHealthCertToId(0)).toBeNull();
    });
    it('province → numeric ID', () => {
      const id = normalizeProvinceToId('黑龙江');
      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);
    });
    it('education → numeric ID', () => {
      expect(normalizeEducationToId('大专')).toBe(3);
      expect(normalizeEducationToId('本科')).toBe(2);
    });
  });

  describe('parseCandidateFieldsFromText (aggregate)', () => {
    it('produces user_text provenance fields from a structured submission', () => {
      const fields = parseCandidateFieldsFromText(
        ['姓名：王建国 电话13912345678 年龄28 性别男 户籍黑龙江'],
        1000,
      );
      expect(fields.name).toMatchObject({ value: '王建国', provenance: 'user_text', at: 1000 });
      expect(fields.phone?.value).toBe('13912345678');
      expect(fields.age?.value).toBe(28);
      expect(fields.gender?.value).toBe('男');
      expect(fields.householdProvince?.value).toBe('黑龙江');
    });

    it('omits fields it cannot deterministically parse', () => {
      const fields = parseCandidateFieldsFromText(['想看看附近的奶茶店岗位'], 1);
      expect(Object.keys(fields)).toHaveLength(0);
    });

    it('merges across multiple messages', () => {
      const fields = parseCandidateFieldsFromText(['我叫李雷', '电话是13800000000'], 1);
      expect(fields.name?.value).toBe('李雷');
      expect(fields.phone?.value).toBe('13800000000');
    });
  });

  describe('authoritative provenance gate', () => {
    it('only user_text / booking_writeback are authoritative', () => {
      expect(AUTHORITATIVE_PROVENANCE.has('user_text')).toBe(true);
      expect(AUTHORITATIVE_PROVENANCE.has('booking_writeback')).toBe(true);
      expect(AUTHORITATIVE_PROVENANCE.has('model_arg')).toBe(false);
      expect(AUTHORITATIVE_PROVENANCE.has('llm_extract')).toBe(false);
    });
    it('isFieldAuthoritative rejects model_arg drafts', () => {
      expect(isFieldAuthoritative({ value: '小王', provenance: 'model_arg', at: 1 })).toBe(false);
      expect(isFieldAuthoritative({ value: '王建国', provenance: 'user_text', at: 1 })).toBe(true);
      expect(isFieldAuthoritative(undefined)).toBe(false);
    });
  });
});
