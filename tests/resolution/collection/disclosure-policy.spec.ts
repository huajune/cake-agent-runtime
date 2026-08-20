import {
  canDiscloseRejection,
  disclosureLevelOf,
  isSensitiveAttribute,
  shouldDeferRejection,
} from '@resolution/collection/disclosure-policy';
import type { ContractFieldDef } from '@resolution/collection/form.types';
import { AGE_FIELD, GENDER_MALE_ONLY_FIELD, HEALTH_CERT_FIELD } from './form.fixtures';

function field(labelTitle: string, labelInstructions?: string): ContractFieldDef {
  return {
    labelId: 1,
    labelTitle,
    labelInstructions,
    fieldType: 'TEXT',
    required: true,
    acceptedOptions: [],
    rejectedOptions: [],
  };
}

describe('disclosureLevelOf', () => {
  it('可明说族：岗位卡本来就印着的硬性条件（PR #421 运营裁决口径）', () => {
    expect(disclosureLevelOf(AGE_FIELD)).toBe('open');
    expect(disclosureLevelOf(GENDER_MALE_ONLY_FIELD)).toBe('open');
    expect(disclosureLevelOf(HEALTH_CERT_FIELD)).toBe('open');
    for (const title of ['学历', '身高(cm)', '体重(kg)', '预计在岗多久']) {
      expect(disclosureLevelOf(field(title))).toBe('open');
    }
  });

  it('禁明说族：出站守卫红线属性（户籍/籍贯/民族/专业/婚育）', () => {
    for (const title of ['籍贯', '户籍省份', '民族', '专业', '婚育情况', '是否本地人']) {
      expect(disclosureLevelOf(field(title))).toBe('restricted');
      expect(canDiscloseRejection(field(title))).toBe(false);
    }
  });

  it('默认档是禁明说——未知新标签不做可说的赌博', () => {
    expect(disclosureLevelOf(field('是否有纹身'))).toBe('restricted');
    expect(disclosureLevelOf(field('需要中餐厅服务员经验'))).toBe('restricted');
  });

  it('红线压过可明说白名单：标题混进敏感词也不放行', () => {
    expect(disclosureLevelOf(field('学历（限食品相关专业）'))).toBe('restricted');
    expect(disclosureLevelOf(field('年龄（仅限本地户口）'))).toBe('restricted');
  });

  it('填写说明里的敏感词同样触发禁明说', () => {
    expect(disclosureLevelOf(field('在岗时长', '不要新疆西藏籍'))).toBe('restricted');
  });

  it('禁说判据引用出站守卫同一常量，本文件不自建敏感词表', () => {
    // 词表若被另立副本，改守卫侧词表时这里不会跟着变——用守卫侧独有的婚育口径抽查。
    expect(disclosureLevelOf(field('已婚未婚'))).toBe('restricted');
  });
});

describe('isSensitiveAttribute vs disclosureLevelOf（别混用）', () => {
  it('姓名/手机号：拒绝理由不可说（默认档），但**不是敏感属性**', () => {
    for (const title of ['姓名', '手机号', '具体住址']) {
      expect(disclosureLevelOf(field(title))).toBe('restricted');
      expect(isSensitiveAttribute(field(title))).toBe(false);
    }
  });

  it('籍贯/民族/专业：两者都判敏感', () => {
    for (const title of ['籍贯', '民族', '专业']) {
      expect(disclosureLevelOf(field(title))).toBe('restricted');
      expect(isSensitiveAttribute(field(title))).toBe(true);
    }
  });

  it('契约标 RESTRICTED 即敏感，不看词表', () => {
    expect(isSensitiveAttribute({ ...field('每周可出勤天数'), disclosure: 'RESTRICTED' })).toBe(
      true,
    );
  });
});

describe('shouldDeferRejection · 因果隔离', () => {
  it('本轮刚答过 restricted 档字段 → 拒绝顺延，不在紧邻回合触发', () => {
    expect(shouldDeferRejection([field('籍贯')])).toBe(true);
    expect(shouldDeferRejection([AGE_FIELD, field('民族')])).toBe(true);
  });

  it('本轮只答了可明说族 → 当轮即可拒绝', () => {
    expect(shouldDeferRejection([AGE_FIELD, GENDER_MALE_ONLY_FIELD])).toBe(false);
    expect(shouldDeferRejection([])).toBe(false);
  });

  it('报个姓名不该顺延拒绝——因果隔离不是无差别拖延', () => {
    expect(shouldDeferRejection([field('姓名'), field('手机号')])).toBe(false);
  });
});
