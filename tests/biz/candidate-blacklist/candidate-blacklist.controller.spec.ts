import { Test, TestingModule } from '@nestjs/testing';
import { CandidateBlacklistController } from '@biz/candidate-blacklist/candidate-blacklist.controller';
import { CandidateBlacklistService } from '@biz/candidate-blacklist/services/candidate-blacklist.service';

describe('CandidateBlacklistController', () => {
  let controller: CandidateBlacklistController;

  const mockService = {
    getCandidateBlacklist: jest.fn(),
    addCandidateToBlacklist: jest.fn(),
    removeCandidateFromBlacklist: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CandidateBlacklistController],
      providers: [{ provide: CandidateBlacklistService, useValue: mockService }],
    }).compile();

    controller = module.get<CandidateBlacklistController>(CandidateBlacklistController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getCandidateBlacklist', () => {
    it('should wrap service records into candidates payload', async () => {
      const records = [{ target_id: 'c-1', reason: '恶意刷岗', created_at: '2026-06-11' }];
      mockService.getCandidateBlacklist.mockResolvedValue(records);

      const result = await controller.getCandidateBlacklist();

      expect(mockService.getCandidateBlacklist).toHaveBeenCalled();
      expect(result).toEqual({ candidates: records });
    });
  });

  describe('addCandidateToBlacklist', () => {
    it('should add candidate with reason and audit snapshot', async () => {
      mockService.addCandidateToBlacklist.mockResolvedValue(undefined);

      const result = await controller.addCandidateToBlacklist({
        targetId: 'c-1',
        reason: '恶意刷岗',
        operator: '小王',
        chatId: 'chat-1',
      });

      expect(mockService.addCandidateToBlacklist).toHaveBeenCalledWith({
        targetId: 'c-1',
        reason: '恶意刷岗',
        operator: '小王',
        chatId: 'chat-1',
        imContactId: undefined,
        contactName: undefined,
      });
      expect(result.message).toContain('c-1');
    });
  });

  describe('removeCandidateFromBlacklist', () => {
    it('should remove candidate from blacklist', async () => {
      mockService.removeCandidateFromBlacklist.mockResolvedValue(true);

      const result = await controller.removeCandidateFromBlacklist({ targetId: 'c-1' });

      expect(mockService.removeCandidateFromBlacklist).toHaveBeenCalledWith('c-1');
      expect(result.message).toContain('已从黑名单移除');
    });

    it('should report when candidate is not in blacklist', async () => {
      mockService.removeCandidateFromBlacklist.mockResolvedValue(false);

      const result = await controller.removeCandidateFromBlacklist({ targetId: 'c-x' });

      expect(result.message).toContain('不在黑名单中');
    });
  });
});
