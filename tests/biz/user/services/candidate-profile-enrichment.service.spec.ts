import { Test, TestingModule } from '@nestjs/testing';
import { CandidateProfileEnrichmentService } from '@biz/user/services/candidate-profile-enrichment.service';
import { CustomerService } from '@wecom/customer/customer.service';

describe('CandidateProfileEnrichmentService', () => {
  let service: CandidateProfileEnrichmentService;
  const getCustomerDetailV2 = jest.fn();

  const mockCustomerService = { getCustomerDetailV2 } as unknown as CustomerService;

  beforeEach(async () => {
    getCustomerDetailV2.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidateProfileEnrichmentService,
        { provide: CustomerService, useValue: mockCustomerService },
      ],
    }).compile();

    service = module.get(CandidateProfileEnrichmentService);
  });

  describe('lookupGenderFromCustomerDetail — locator guards', () => {
    it.each([
      ['no token', { imBotId: 'b1', imContactId: 'c1' }],
      ['no system locator & no wecom locator', { token: 't' }],
      ['system locator only half-filled (imBotId)', { token: 't', imBotId: 'b1' }],
      ['system locator only half-filled (imContactId)', { token: 't', imContactId: 'c1' }],
      ['wecom locator only half-filled (wecomUserId)', { token: 't', wecomUserId: 'w1' }],
      ['wecom locator only half-filled (externalUserId)', { token: 't', externalUserId: 'e1' }],
      ['all blank strings', { token: '   ', imBotId: '   ', imContactId: '   ' }],
    ])('returns null and does not call customerService when %s', async (_, params) => {
      const result = await service.lookupGenderFromCustomerDetail(params);
      expect(result).toBeNull();
      expect(getCustomerDetailV2).not.toHaveBeenCalled();
    });

    it('accepts system locator (imBotId + imContactId)', async () => {
      getCustomerDetailV2.mockResolvedValueOnce({ data: { gender: 1 } });
      const result = await service.lookupGenderFromCustomerDetail({
        token: 't',
        imBotId: 'b1',
        imContactId: 'c1',
      });
      expect(result).toBe('男');
      expect(getCustomerDetailV2).toHaveBeenCalledWith(
        expect.objectContaining({ token: 't', imBotId: 'b1', imContactId: 'c1' }),
      );
    });

    it('accepts wecom locator (wecomUserId + externalUserId)', async () => {
      getCustomerDetailV2.mockResolvedValueOnce({ data: { gender: 2 } });
      const result = await service.lookupGenderFromCustomerDetail({
        token: 't',
        wecomUserId: 'w1',
        externalUserId: 'e1',
      });
      expect(result).toBe('女');
      expect(getCustomerDetailV2).toHaveBeenCalledWith(
        expect.objectContaining({ wecomUserId: 'w1', externalUserId: 'e1' }),
      );
    });

    it('returns null and logs when customerService throws', async () => {
      getCustomerDetailV2.mockRejectedValueOnce(new Error('network down'));
      const result = await service.lookupGenderFromCustomerDetail({
        token: 't',
        imBotId: 'b1',
        imContactId: 'c1',
      });
      expect(result).toBeNull();
    });
  });

  describe('normalizeGenderValue — format coverage', () => {
    const cases: Array<[string, unknown, '男' | '女' | null]> = [
      ['number 1', 1, '男'],
      ['number 2', 2, '女'],
      ['number 0', 0, null],
      ['number 3', 3, null],
      ['string "1"', '1', '男'],
      ['string "2"', '2', '女'],
      ['english male', 'male', '男'],
      ['english MALE upper', 'MALE', '男'],
      ['english man', 'man', '男'],
      ['english female', 'female', '女'],
      ['english Female mixed case', 'Female', '女'],
      ['english woman', 'woman', '女'],
      ['chinese 男', '男', '男'],
      ['chinese 男生', '男生', '男'],
      ['chinese 男性', '男性', '男'],
      ['chinese 女', '女', '女'],
      ['chinese 女生', '女生', '女'],
      ['chinese 女性', '女性', '女'],
      ['chinese 男女 is ambiguous', '男女', null],
      ['chinese 男女不限 is ambiguous', '男女不限', null],
      ['chinese 男女皆可 is ambiguous', '男女皆可', null],
      ['chinese 女士 with 男 absent', '女士', '女'],
      // 混合表达不应被强行压成某一侧性别，否则会把“男女不限/男女皆可”等自由文本误判。
      ['edge: 处女男 remains ambiguous', '处女男', null],
      ['null', null, null],
      ['undefined', undefined, null],
      ['empty string', '', null],
      ['whitespace only', '   ', null],
      ['unrecognized string', 'unknown', null],
      ['object', { gender: 1 }, null],
      ['boolean', true, null],
    ];

    it.each(cases)('normalizes %s → %s', async (_, input, expected) => {
      getCustomerDetailV2.mockResolvedValueOnce({ data: { gender: input } });
      const result = await service.lookupGenderFromCustomerDetail({
        token: 't',
        imBotId: 'b1',
        imContactId: 'c1',
      });
      expect(result).toBe(expected);
    });

    it('returns null when detail payload is missing gender', async () => {
      getCustomerDetailV2.mockResolvedValueOnce({ data: {} });
      const result = await service.lookupGenderFromCustomerDetail({
        token: 't',
        imBotId: 'b1',
        imContactId: 'c1',
      });
      expect(result).toBeNull();
    });

    it('returns null when detail payload is null', async () => {
      getCustomerDetailV2.mockResolvedValueOnce(null);
      const result = await service.lookupGenderFromCustomerDetail({
        token: 't',
        imBotId: 'b1',
        imContactId: 'c1',
      });
      expect(result).toBeNull();
    });
  });
});
