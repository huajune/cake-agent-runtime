import { Test, TestingModule } from '@nestjs/testing';
import { HostingConfigFacadeService } from './hosting-config-facade.service';
import { SystemConfigService } from './system-config.service';
import { GroupBlacklistService } from './group-blacklist.service';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { DEFAULT_AGENT_REPLY_CONFIG } from '../types/hosting-config.types';

describe('HostingConfigFacadeService', () => {
  let service: HostingConfigFacadeService;

  const mockSystemConfigService = {
    getAgentReplyConfig: jest.fn(),
    setAgentReplyConfig: jest.fn(),
  };

  const mockGroupBlacklistService = {
    getGroupBlacklist: jest.fn(),
    addGroupToBlacklist: jest.fn(),
    removeGroupFromBlacklist: jest.fn(),
  };

  const mockUserHostingService = {
    getPausedUsersWithProfiles: jest.fn(),
    pauseUser: jest.fn(),
    resumeUser: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HostingConfigFacadeService,
        { provide: SystemConfigService, useValue: mockSystemConfigService },
        { provide: GroupBlacklistService, useValue: mockGroupBlacklistService },
        { provide: UserHostingService, useValue: mockUserHostingService },
      ],
    }).compile();

    service = module.get<HostingConfigFacadeService>(HostingConfigFacadeService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ==================== getAgentReplyConfig ====================

  describe('getAgentReplyConfig', () => {
    it('should return config and defaults', async () => {
      const mockConfig = { ...DEFAULT_AGENT_REPLY_CONFIG, maxMergedMessages: 5 };
      mockSystemConfigService.getAgentReplyConfig.mockResolvedValue(mockConfig);

      const result = await service.getAgentReplyConfig();

      expect(result.config).toEqual(mockConfig);
      expect(result.defaults).toEqual(DEFAULT_AGENT_REPLY_CONFIG);
      expect(mockSystemConfigService.getAgentReplyConfig).toHaveBeenCalledTimes(1);
    });

    it('should pass through the config from systemConfigService', async () => {
      mockSystemConfigService.getAgentReplyConfig.mockResolvedValue(DEFAULT_AGENT_REPLY_CONFIG);

      const result = await service.getAgentReplyConfig();

      expect(result.defaults).toBe(DEFAULT_AGENT_REPLY_CONFIG);
    });
  });

  // ==================== updateAgentReplyConfig ====================

  describe('updateAgentReplyConfig', () => {
    it('should update config and return success message', async () => {
      const partial = { maxMergedMessages: 5 };
      const updatedConfig = { ...DEFAULT_AGENT_REPLY_CONFIG, ...partial };
      mockSystemConfigService.setAgentReplyConfig.mockResolvedValue(updatedConfig);

      const result = await service.updateAgentReplyConfig(partial);

      expect(result.config).toEqual(updatedConfig);
      expect(result.message).toBe('配置已更新');
      expect(mockSystemConfigService.setAgentReplyConfig).toHaveBeenCalledWith(partial);
    });

    it('should pass empty partial config to systemConfigService', async () => {
      mockSystemConfigService.setAgentReplyConfig.mockResolvedValue(DEFAULT_AGENT_REPLY_CONFIG);

      const result = await service.updateAgentReplyConfig({});

      expect(result.message).toBe('配置已更新');
      expect(mockSystemConfigService.setAgentReplyConfig).toHaveBeenCalledWith({});
    });
  });

  // ==================== resetAgentReplyConfig ====================

  describe('resetAgentReplyConfig', () => {
    it('should reset config to defaults and return success message', async () => {
      mockSystemConfigService.setAgentReplyConfig.mockResolvedValue(DEFAULT_AGENT_REPLY_CONFIG);

      const result = await service.resetAgentReplyConfig();

      expect(result.config).toEqual(DEFAULT_AGENT_REPLY_CONFIG);
      expect(result.message).toBe('Agent 回复策略配置已重置为默认值');
      expect(mockSystemConfigService.setAgentReplyConfig).toHaveBeenCalledWith(
        DEFAULT_AGENT_REPLY_CONFIG,
      );
    });
  });

  // ==================== getBlacklist ====================

  describe('getBlacklist', () => {
    it('should return chatIds from paused users and groupIds from group blacklist', async () => {
      mockUserHostingService.getPausedUsersWithProfiles.mockResolvedValue([
        { userId: 'user1', pausedAt: Date.now() },
        { userId: 'user2', pausedAt: Date.now() },
      ]);
      mockGroupBlacklistService.getGroupBlacklist.mockResolvedValue([
        { group_id: 'group1', added_at: Date.now() },
        { group_id: 'group2', added_at: Date.now() },
      ]);

      const result = await service.getBlacklist();

      expect(result.chatIds).toEqual(['user1', 'user2']);
      expect(result.groupIds).toEqual(['group1', 'group2']);
    });

    it('should return empty arrays when no users or groups are blacklisted', async () => {
      mockUserHostingService.getPausedUsersWithProfiles.mockResolvedValue([]);
      mockGroupBlacklistService.getGroupBlacklist.mockResolvedValue([]);

      const result = await service.getBlacklist();

      expect(result.chatIds).toEqual([]);
      expect(result.groupIds).toEqual([]);
    });

    it('should call both services in parallel', async () => {
      mockUserHostingService.getPausedUsersWithProfiles.mockResolvedValue([]);
      mockGroupBlacklistService.getGroupBlacklist.mockResolvedValue([]);

      await service.getBlacklist();

      expect(mockUserHostingService.getPausedUsersWithProfiles).toHaveBeenCalledTimes(1);
      expect(mockGroupBlacklistService.getGroupBlacklist).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== addToBlacklist ====================

  describe('addToBlacklist', () => {
    it('should pause user when type is chatId', async () => {
      mockUserHostingService.pauseUser.mockResolvedValue(undefined);

      const result = await service.addToBlacklist('user1', 'chatId');

      expect(result.message).toBe('用户 user1 已添加到黑名单');
      expect(mockUserHostingService.pauseUser).toHaveBeenCalledWith('user1');
      expect(mockGroupBlacklistService.addGroupToBlacklist).not.toHaveBeenCalled();
    });

    it('should add group to blacklist when type is groupId', async () => {
      mockGroupBlacklistService.addGroupToBlacklist.mockResolvedValue(undefined);

      const result = await service.addToBlacklist('group1', 'groupId', 'spam group');

      expect(result.message).toBe('小组 group1 已添加到黑名单');
      expect(mockGroupBlacklistService.addGroupToBlacklist).toHaveBeenCalledWith(
        'group1',
        'spam group',
      );
      expect(mockUserHostingService.pauseUser).not.toHaveBeenCalled();
    });

    it('should add group without reason when reason is not provided', async () => {
      mockGroupBlacklistService.addGroupToBlacklist.mockResolvedValue(undefined);

      await service.addToBlacklist('group1', 'groupId');

      expect(mockGroupBlacklistService.addGroupToBlacklist).toHaveBeenCalledWith(
        'group1',
        undefined,
      );
    });
  });

  // ==================== removeFromBlacklist ====================

  describe('removeFromBlacklist', () => {
    it('should resume user when type is chatId', async () => {
      mockUserHostingService.resumeUser.mockResolvedValue(undefined);

      const result = await service.removeFromBlacklist('user1', 'chatId');

      expect(result.message).toBe('用户 user1 已从黑名单移除');
      expect(mockUserHostingService.resumeUser).toHaveBeenCalledWith('user1');
      expect(mockGroupBlacklistService.removeGroupFromBlacklist).not.toHaveBeenCalled();
    });

    it('should remove group from blacklist when type is groupId', async () => {
      mockGroupBlacklistService.removeGroupFromBlacklist.mockResolvedValue(true);

      const result = await service.removeFromBlacklist('group1', 'groupId');

      expect(result.message).toBe('小组 group1 已从黑名单移除');
      expect(mockGroupBlacklistService.removeGroupFromBlacklist).toHaveBeenCalledWith('group1');
      expect(mockUserHostingService.resumeUser).not.toHaveBeenCalled();
    });
  });
});
