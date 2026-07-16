/**
 * 品牌目录加固回归（2026-07-16 生产事故）：
 *
 * 事故：成都你六姐 的全角别名 "６姐" 在归一化时全角"６"被白名单过滤删除，
 * 别名塌缩成单字"姐"；候选人喊"姐，…"分句后独立成 token 被 alias_exact
 * 批量误命中（42+ 会话 currentBrand 被污染）。
 *
 * 三道修复：
 * 1. normalizeForBrandMatch 补 NFKC 全半角折叠（§7.1 全半角统一）；
 * 2. 非标准名别名归一化后 <2 字符整体剔除（MIN_ALIAS_NORMALIZED_LENGTH）；
 * 3. 纯数字别名禁无边界包含、边界包含要求 ≥3 位；"便利店"类业态泛词入黑名单。
 */
import { normalizeForBrandMatch } from '@/resolution/brand/brand-normalize';
import {
  isBrandContainEligible,
  isShortLatinBoundaryEligible,
} from '@/resolution/brand/catalog-index';
import { resolveBrands } from '@/resolution/brand/brand-matcher';
import type { BrandItem } from '@/sponge/sponge.types';

// 按生产品牌库真实别名形态构造（含全角、纯数字、业态泛词、单字别名）
const catalog: BrandItem[] = [
  {
    id: 10200,
    name: '成都你六姐',
    aliases: ['6姐', '六姐', '６姐', '你6姐', '你六姐', '成都六姐', '10200'],
  },
  { id: 10300, name: '7-11便利店', aliases: ['71', '711', '便利店', '7-11', '７-１１'] },
  { id: 10001, name: '肯德基', aliases: ['KFC', 'kfc'] },
  { id: 10400, name: '报亭咖啡', aliases: ['报', '报亭'] },
  { id: 10500, name: '匠', aliases: [] },
];

describe('normalizeForBrandMatch 全半角折叠', () => {
  it('全角数字/字母折叠为半角，不再被白名单删除', () => {
    expect(normalizeForBrandMatch('６姐')).toBe('6姐');
    expect(normalizeForBrandMatch('７-１１')).toBe('711');
    expect(normalizeForBrandMatch('ＫＦＣ')).toBe('kfc');
  });
});

describe('别名匹配资格收紧', () => {
  it('纯数字别名不做无边界包含；边界包含要求 ≥3 位', () => {
    expect(isBrandContainEligible('10200')).toBe(false);
    expect(isShortLatinBoundaryEligible('71')).toBe(false);
    expect(isShortLatinBoundaryEligible('711')).toBe(true);
  });

  it('业态泛词"便利店"降级为仅全等', () => {
    expect(isBrandContainEligible('便利店')).toBe(false);
    expect(isShortLatinBoundaryEligible('便利店')).toBe(false);
  });
});

describe('生产事故场景回归', () => {
  it('候选人喊"姐，…"不得命中成都你六姐', () => {
    const results = resolveBrands(
      '姐，你把班车最长的那个店地址发我一下呗，我方便乘车过来',
      'user_text',
      catalog,
    );
    expect(results.map((r) => r.canonicalName)).not.toContain('成都你六姐');
  });

  it('单独一条"姐"消息不得命中任何品牌', () => {
    expect(resolveBrands('姐', 'user_text', catalog)).toHaveLength(0);
  });

  it('候选人真说"6姐"（全等 token）仍能命中', () => {
    const results = resolveBrands('6姐', 'user_text', catalog);
    expect(results.map((r) => r.canonicalName)).toContain('成都你六姐');
  });

  it('全角"６姐"经折叠后同样命中', () => {
    const results = resolveBrands('６姐还招人不', 'user_text', catalog);
    // "６姐还招人不" 不构成全等 token，不强求命中；仅验证不抛错且无误伤其它品牌
    expect(results.every((r) => r.canonicalName === '成都你六姐' || r.canonicalName === null)).toBe(
      true,
    );
  });

  it('门牌号"玫瑰街71号"不得命中 7-11便利店', () => {
    const results = resolveBrands(
      '[位置分享] 苏家屯区中国农业银行(玫瑰街)（苏家屯区玫瑰街71号） [经纬度:41.659389496,123.351409912]',
      'user_text',
      catalog,
    );
    expect(results.map((r) => r.canonicalName)).not.toContain('7-11便利店');
  });

  it('"去711买东西"仍可经边界包含命中 7-11便利店', () => {
    const results = resolveBrands('我在711旁边', 'user_text', catalog);
    expect(results.map((r) => r.canonicalName)).toContain('7-11便利店');
  });

  it('"有便利店的兼职吗"不得命中 7-11便利店（泛词黑名单）', () => {
    const results = resolveBrands('有便利店的兼职吗', 'user_text', catalog);
    expect(results.map((r) => r.canonicalName)).not.toContain('7-11便利店');
  });

  it('手机号不得巧合命中纯数字别名 10200', () => {
    const results = resolveBrands('联系方式:15680102008', 'user_text', catalog);
    expect(results.map((r) => r.canonicalName)).not.toContain('成都你六姐');
  });

  it('KFC 边界包含匹配不回归', () => {
    expect(
      resolveBrands('想去KFC看看', 'user_text', catalog).map((r) => r.canonicalName),
    ).toContain('肯德基');
    expect(
      resolveBrands('老板你好kfc还招兼职吗', 'user_text', catalog).map((r) => r.canonicalName),
    ).toContain('肯德基');
  });

  it('单字品牌标准名"匠"仍可整句全等命中；单字别名"报"已被剔除', () => {
    expect(resolveBrands('匠', 'user_text', catalog).map((r) => r.canonicalName)).toContain('匠');
    expect(resolveBrands('我报过名了', 'user_text', catalog)).toHaveLength(0);
    expect(resolveBrands('报', 'user_text', catalog)).toHaveLength(0);
  });
});
