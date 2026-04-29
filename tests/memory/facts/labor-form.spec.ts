import {
  INVALID_LABOR_FORM_WORDS,
  VALID_LABOR_FORMS,
  isValidLaborForm,
  sanitizeJobDisplayText,
  stripLaborFormFromCategories,
} from '@/memory/facts/labor-form';

describe('labor-form', () => {
  describe('isValidLaborForm', () => {
    it.each([...VALID_LABOR_FORMS])('accepts valid labor form %s', (value) => {
      expect(isValidLaborForm(value)).toBe(true);
    });

    it.each([...INVALID_LABOR_FORM_WORDS])(
      'rejects platform attribute word %s',
      (value) => {
        expect(isValidLaborForm(value)).toBe(false);
      },
    );

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
      const result = stripLaborFormFromCategories([
        '寒假工',
        '服务员',
        '兼职',
        '收银员',
        '暑假工',
      ]);

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

    it('strips "全职" residue from jobName (badcase nwr0i50f)', () => {
      expect(sanitizeJobDisplayText('蛋糕全职岗')).toBe('蛋糕岗');
      expect(sanitizeJobDisplayText('全职配送员')).toBe('配送员');
      expect(sanitizeJobDisplayText('配送员-全职')).toBe('配送员');
    });

    it('strips "正式工" / "临时工"', () => {
      expect(sanitizeJobDisplayText('正式工服务员')).toBe('服务员');
      expect(sanitizeJobDisplayText('收银员（临时工）')).toBe('收银员');
    });

    it('keeps "兼职" since it is the platform legal attribute', () => {
      expect(sanitizeJobDisplayText('兼职服务员')).toBe('兼职服务员');
      expect(sanitizeJobDisplayText('服务员-兼职岗')).toBe('服务员-兼职岗');
    });

    it('cleans up empty parens / dangling separators after stripping', () => {
      expect(sanitizeJobDisplayText('服务员（全职）')).toBe('服务员');
      expect(sanitizeJobDisplayText('全职--服务员')).toBe('服务员');
      expect(sanitizeJobDisplayText('  全职  服务员  ')).toBe('服务员');
    });

    it('returns null when nothing meaningful is left', () => {
      expect(sanitizeJobDisplayText('全职')).toBeNull();
      expect(sanitizeJobDisplayText('正式工')).toBeNull();
      expect(sanitizeJobDisplayText('  -  ')).toBeNull();
    });

    it('leaves clean job names untouched', () => {
      expect(sanitizeJobDisplayText('服务员')).toBe('服务员');
      expect(sanitizeJobDisplayText('M Stand 咖啡师')).toBe('M Stand 咖啡师');
    });
  });
});
