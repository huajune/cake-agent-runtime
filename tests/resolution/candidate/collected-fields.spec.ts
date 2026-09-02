import {
  hasPersistableFieldProvenance,
  normalizeEducationToId,
  normalizeGenderToId,
  normalizeHealthCertToId,
  normalizeProvinceToId,
  parseAge,
  parseCandidateFieldsFromText,
  parseEducation,
  parseGender,
  parseHealthCert,
  parseHeight,
  parseHouseholdProvince,
  parseName,
  parsePhone,
  parseWeight,
} from '@resolution/candidate';
import { PERSISTABLE_CANDIDATE_FIELD_PRODUCERS } from '@resolution/candidate/types';

describe('candidate-field-parser', () => {
  describe('parsePhone', () => {
    it('extracts an 11-digit mobile number', () => {
      expect(parsePhone('我的电话是13912345678哈')).toEqual({
        value: '13912345678',
        excerpt: '13912345678',
      });
    });
    it('rejects non-mobile digit runs', () => {
      expect(parsePhone('订单号 02112345678901')).toBeNull();
      expect(parsePhone('12345678901')).toBeNull(); // 不是 1[3-9] 号段
    });
  });

  describe('parseAge', () => {
    it('reads keyed and "N岁" forms', () => {
      expect(parseAge('年龄：28')).toEqual({ value: 28, excerpt: '年龄：28' });
      expect(parseAge('我今年35岁')).toEqual({ value: 35, excerpt: '35岁' });
    });
    it('drops out-of-range ages', () => {
      expect(parseAge('我家娃8岁')).toBeNull();
      expect(parseAge('年龄：99')).toBeNull();
    });
  });

  describe('parseGender', () => {
    it('reads explicit gender statements', () => {
      expect(parseGender('性别：男')).toEqual({ value: '男', excerpt: '性别：男' });
      expect(parseGender('我是女的')).toEqual({ value: '女', excerpt: '我是女的' });
    });
    it('does not misfire on unrelated 男/女 words', () => {
      expect(parseGender('想找女装门店的岗位')).toBeNull();
      expect(parseGender('要招男生吗')).toBeNull();
      expect(parseGender('女士优先')).toBeNull();
    });
  });

  describe('parseHouseholdProvince', () => {
    it('extracts province under a household anchor', () => {
      expect(parseHouseholdProvince('户籍是黑龙江')).toMatchObject({ value: '黑龙江' });
      expect(parseHouseholdProvince('老家四川的')).toMatchObject({ value: '四川' });
    });
    it('returns null without anchor', () => {
      expect(parseHouseholdProvince('我在四川工作')).toBeNull();
    });
  });

  describe('parseHealthCert', () => {
    it('maps 有/无/无且不办 to 1/2/3', () => {
      expect(parseHealthCert('我有健康证')).toEqual({ value: 1, excerpt: '我有健康证' });
      expect(parseHealthCert('没有健康证')).toEqual({ value: 2, excerpt: '没有健康证' });
      expect(parseHealthCert('没有健康证，也不愿意办')).toMatchObject({ value: 3 });
    });
    it('unifies question and terse-answer semantics', () => {
      expect(parseHealthCert('需要有食品健康证是吗')).toBeNull();
      expect(parseHealthCert('我有健康证')?.value).toBe(1);
      expect(parseHealthCert('没办过，可以办')?.value).toBe(2);
      expect(parseHealthCert('没有，不想办')?.value).toBe(3);
    });
    it('returns null when 健康证 not mentioned', () => {
      expect(parseHealthCert('我想了解岗位')).toBeNull();
    });
  });

  describe('parseHeight / parseWeight', () => {
    it('rejects job requirements and questions', () => {
      expect(parseHeight('身高要求165以上')).toBeNull();
      expect(parseHeight('身高165以上可以吗')).toBeNull();
      expect(parseWeight('体重要求60公斤以下')).toBeNull();
    });
    it('accepts self-reported measurements', () => {
      expect(parseHeight('我身高165')).toEqual({ value: 165, excerpt: '身高165' });
      expect(parseHeight('身高:165')).toEqual({ value: 165, excerpt: '身高:165' });
      expect(parseWeight('我体重55公斤')).toEqual({ value: 55, excerpt: '体重55' });
    });
  });

  describe('parseEducation', () => {
    it('maps free text to Sponge labels', () => {
      expect(parseEducation('我是大专')).toEqual({ value: '大专', excerpt: '大专' });
      expect(parseEducation('本科毕业')).toEqual({ value: '本科', excerpt: '本科' });
      expect(parseEducation('研究生')).toEqual({ value: '硕士', excerpt: '研究生' });
    });
  });

  describe('parseName', () => {
    it('accepts structured and declared real names', () => {
      expect(parseName('姓名：王建国')).toEqual({ value: '王建国', excerpt: '姓名：王建国' });
      expect(parseName('我叫李雷')).toEqual({ value: '李雷', excerpt: '我叫李雷' });
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
    it('产物标 rule 而非 candidate_quote（工序 A2：解析产物不冒充引文权威）', () => {
      const fields = parseCandidateFieldsFromText(
        ['姓名：王建国 电话13912345678 年龄28 性别男 户籍黑龙江'],
        1000,
      );
      expect(fields.name).toMatchObject({ value: '王建国', producer: 'rule', at: 1000 });
      expect(fields.phone?.value).toBe('13912345678');
      expect(fields.age?.value).toBe(28);
      expect(fields.gender?.value).toBe('男');
      expect(fields.householdProvince?.value).toBe('黑龙江');
      expect(fields.name?.evidence).toBe('姓名：王建国');
      expect(fields.phone?.evidence).toBe('13912345678');
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

  describe('persistable provenance gate', () => {
    it('工序 A1：rule 已从权威白名单摘除（置信度是证据的属性，不是产者的属性）', () => {
      expect(PERSISTABLE_CANDIDATE_FIELD_PRODUCERS.has('candidate_quote')).toBe(true);
      expect(PERSISTABLE_CANDIDATE_FIELD_PRODUCERS.has('system')).toBe(true);
      // 正则认不出候选人口语形态时判假阳（实测 72.3%），却因产者身份是"规则"而
      // 自带确权资格——P9 旧阶梯的现行法条，宪法 P11 废除。
      expect(PERSISTABLE_CANDIDATE_FIELD_PRODUCERS.has('rule')).toBe(false);
      expect(PERSISTABLE_CANDIDATE_FIELD_PRODUCERS.has('model')).toBe(false);
    });
    it('hasPersistableFieldProvenance rejects model and rule drafts', () => {
      expect(hasPersistableFieldProvenance({ value: '小王', producer: 'model', at: 1 })).toBe(
        false,
      );
      expect(hasPersistableFieldProvenance({ value: '小王', producer: 'rule', at: 1 })).toBe(false);
      expect(
        hasPersistableFieldProvenance({ value: '王建国', producer: 'candidate_quote', at: 1 }),
      ).toBe(true);
      expect(hasPersistableFieldProvenance(undefined)).toBe(false);
    });
  });
});
