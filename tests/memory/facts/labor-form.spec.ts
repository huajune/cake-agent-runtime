import {
  INVALID_LABOR_FORM_WORDS,
  SEASONAL_LABOR_FORMS,
  VALID_LABOR_FORMS,
  isFullTimeLaborForm,
  isHardFilteredLaborForm,
  isSeasonalLaborForm,
  isValidLaborForm,
  matchesLaborForm,
  sanitizeJobDisplayText,
  sanitizeLaborFormForDisplay,
  stripLaborFormFromCategories,
} from '@/memory/facts/labor-form';

describe('labor-form', () => {
  describe('isValidLaborForm', () => {
    it.each([...VALID_LABOR_FORMS])('accepts valid labor form %s', (value) => {
      expect(isValidLaborForm(value)).toBe(true);
    });

    it.each([...INVALID_LABOR_FORM_WORDS])('rejects platform attribute word %s', (value) => {
      expect(isValidLaborForm(value)).toBe(false);
    });

    it.each([null, undefined, ''])('rejects empty value %p', (value) => {
      expect(isValidLaborForm(value)).toBe(false);
    });

    it('rejects unknown strings', () => {
      expect(isValidLaborForm('日结工')).toBe(false);
    });
  });

  describe('stripLaborFormFromCategories', () => {
    it('removes both invalid platform words and valid labor forms from categories', () => {
      const result = stripLaborFormFromCategories([
        '服务员',
        '兼职',
        '兼职+',
        '收银员',
        '全职',
        '小时工',
      ]);

      expect(result.cleaned).toEqual(['服务员', '收银员']);
      expect(result.removed).toEqual(['兼职', '兼职+', '全职', '小时工']);
    });

    it('trims whitespace and skips empty/non-string entries', () => {
      const input = ['  服务员  ', '', '   ', '兼职', null, 42] as unknown as string[];
      const result = stripLaborFormFromCategories(input);

      expect(result.cleaned).toEqual(['服务员']);
      expect(result.removed).toEqual(['兼职']);
    });

    it('returns empty arrays when no categories are provided', () => {
      const result = stripLaborFormFromCategories([]);
      expect(result.cleaned).toEqual([]);
      expect(result.removed).toEqual([]);
    });

    it('keeps order of cleaned and removed entries as seen', () => {
      const result = stripLaborFormFromCategories(['寒假工', '服务员', '兼职', '收银员', '暑假工']);

      expect(result.cleaned).toEqual(['服务员', '收银员']);
      expect(result.removed).toEqual(['寒假工', '兼职', '暑假工']);
    });

    it('does not mutate input', () => {
      const input = ['服务员', '兼职'];
      const snapshot = [...input];
      stripLaborFormFromCategories(input);
      expect(input).toEqual(snapshot);
    });
  });

  describe('sanitizeJobDisplayText', () => {
    it.each([null, undefined, ''])('returns null for empty input %p', (value) => {
      expect(sanitizeJobDisplayText(value)).toBeNull();
    });

    it('strips "正式工" / "临时工" noise words (not on the 全职/兼职 axis)', () => {
      expect(sanitizeJobDisplayText('正式工服务员')).toBe('服务员');
      expect(sanitizeJobDisplayText('收银员（临时工）')).toBe('收银员');
      expect(sanitizeJobDisplayText('配送员-临时工')).toBe('配送员');
    });

    it('keeps "全职" / "兼职" since they are now legal labor forms', () => {
      expect(sanitizeJobDisplayText('蛋糕全职岗')).toBe('蛋糕全职岗');
      expect(sanitizeJobDisplayText('全职配送员')).toBe('全职配送员');
      expect(sanitizeJobDisplayText('兼职服务员')).toBe('兼职服务员');
      expect(sanitizeJobDisplayText('服务员-兼职岗')).toBe('服务员-兼职岗');
    });

    it('cleans up empty parens / dangling separators after stripping noise words', () => {
      expect(sanitizeJobDisplayText('服务员（正式工）')).toBe('服务员');
      expect(sanitizeJobDisplayText('临时工--服务员')).toBe('服务员');
      expect(sanitizeJobDisplayText('  临时工  服务员  ')).toBe('服务员');
    });

    it('returns null when nothing meaningful is left', () => {
      expect(sanitizeJobDisplayText('正式工')).toBeNull();
      expect(sanitizeJobDisplayText('临时工')).toBeNull();
      expect(sanitizeJobDisplayText('  -  ')).toBeNull();
    });

    it('leaves clean job names untouched', () => {
      expect(sanitizeJobDisplayText('服务员')).toBe('服务员');
      expect(sanitizeJobDisplayText('M Stand 咖啡师')).toBe('M Stand 咖啡师');
    });
  });

  describe('sanitizeLaborFormForDisplay', () => {
    it.each(['临时工', '正式工'])('hides noise word %s (not on the 全职/兼职 axis)', (value) => {
      expect(sanitizeLaborFormForDisplay(value)).toBeNull();
    });

    it.each(['全职', '兼职', '兼职+', '小时工', '寒假工', '暑假工'])(
      'keeps legal labor form %s',
      (value) => {
        expect(sanitizeLaborFormForDisplay(value)).toBe(value);
      },
    );
  });

  describe('isFullTimeLaborForm', () => {
    it('treats 全职 as full-time', () => {
      expect(isFullTimeLaborForm('全职')).toBe(true);
      expect(isFullTimeLaborForm(' 全职 ')).toBe(true);
    });

    it.each(['兼职', '兼职+', '小时工', '暑假工', '正式工', '', null, undefined])(
      'treats %p as not full-time',
      (value) => {
        expect(isFullTimeLaborForm(value)).toBe(false);
      },
    );
  });

  describe('isHardFilteredLaborForm', () => {
    it('hard-filters only 全职', () => {
      expect(isHardFilteredLaborForm('全职')).toBe(true);
    });

    it.each(['兼职', '暑假工', '寒假工', '小时工', '兼职+', '正式工', '', null, undefined])(
      'does NOT hard-filter %p (returns all jobs)',
      (value) => {
        expect(isHardFilteredLaborForm(value)).toBe(false);
      },
    );
  });

  describe('isSeasonalLaborForm', () => {
    it.each([...SEASONAL_LABOR_FORMS])('treats %s as seasonal', (value) => {
      expect(isSeasonalLaborForm(value)).toBe(true);
    });

    it.each(['兼职+', '小时工', '兼职', '全职', '', null, undefined])(
      'treats %s as non-seasonal',
      (value) => {
        expect(isSeasonalLaborForm(value)).toBe(false);
      },
    );
  });

  describe('matchesLaborForm', () => {
    it('matches when job laborForm strictly equals wanted', () => {
      expect(matchesLaborForm('暑假工', '暑假工')).toBe(true);
    });

    it('does not match different subtypes (no semantic widening)', () => {
      expect(matchesLaborForm('小时工', '暑假工')).toBe(false);
      expect(matchesLaborForm('兼职+', '暑假工')).toBe(false);
    });

    it('does not match when job laborForm is empty/reverse-word/null', () => {
      expect(matchesLaborForm(null, '暑假工')).toBe(false);
      expect(matchesLaborForm('全职', '暑假工')).toBe(false);
      expect(matchesLaborForm('', '暑假工')).toBe(false);
    });

    it('returns false when wanted is empty', () => {
      expect(matchesLaborForm('暑假工', null)).toBe(false);
    });
  });
});
