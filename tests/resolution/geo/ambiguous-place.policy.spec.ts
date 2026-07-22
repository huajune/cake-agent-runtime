import { GENERIC_AMBIGUOUS_SUFFIXES, hasGenericAmbiguousSuffix } from '@resolution/geo';

describe('resolution/geo policy（Phase 0 golden cases 平移）', () => {
  describe('hasGenericAmbiguousSuffix', () => {
    it('完整等于黑名单条目时命中', () => {
      expect(hasGenericAmbiguousSuffix('万达广场')).toBe(true);
      expect(hasGenericAmbiguousSuffix('火车站')).toBe(true);
      expect(hasGenericAmbiguousSuffix('人民广场')).toBe(true);
    });

    it('以黑名单条目结尾时命中（连锁商业体/公共设施）', () => {
      expect(hasGenericAmbiguousSuffix('合肥万达广场')).toBe(true);
      expect(hasGenericAmbiguousSuffix('龙湖天街')).toBe(true);
      expect(hasGenericAmbiguousSuffix('交通大学')).toBe(true);
    });

    it('交通站点带 ≥2 字专名前缀时不命中（badcase: 漕宝路地铁报站名被反问城市）', () => {
      expect(hasGenericAmbiguousSuffix('漕宝路地铁站')).toBe(false);
      expect(hasGenericAmbiguousSuffix('上海火车站')).toBe(false);
      expect(hasGenericAmbiguousSuffix('北京西站火车站')).toBe(false);
      expect(hasGenericAmbiguousSuffix('虹桥高铁站')).toBe(false);
    });

    it('交通站点前缀过短或本身仍是通名时照旧命中', () => {
      expect(hasGenericAmbiguousSuffix('南地铁站')).toBe(true);
      expect(hasGenericAmbiguousSuffix('长途汽车站')).toBe(true);
      expect(hasGenericAmbiguousSuffix('中心客运站')).toBe(true);
      expect(hasGenericAmbiguousSuffix('汽车客运站')).toBe(true);
    });

    it('前后有空白时仍能匹配（自动 trim）', () => {
      expect(hasGenericAmbiguousSuffix('  万达广场  ')).toBe(true);
    });

    it('唯一对应某城市的非黑名单地名不命中（让 LLM 通识可用）', () => {
      expect(hasGenericAmbiguousSuffix('马陆')).toBe(false);
      expect(hasGenericAmbiguousSuffix('陆家嘴')).toBe(false);
      expect(hasGenericAmbiguousSuffix('光谷')).toBe(false);
      expect(hasGenericAmbiguousSuffix('中关村')).toBe(false);
    });

    it('空字符串 / 空白 / 不在黑名单的普通地名不命中', () => {
      expect(hasGenericAmbiguousSuffix('')).toBe(false);
      expect(hasGenericAmbiguousSuffix('   ')).toBe(false);
      expect(hasGenericAmbiguousSuffix('人民路 123 号')).toBe(false);
    });

    it('黑名单常量本身的每一项都自命中', () => {
      for (const suffix of GENERIC_AMBIGUOUS_SUFFIXES) {
        expect(hasGenericAmbiguousSuffix(suffix)).toBe(true);
      }
    });
  });
});
