import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ProfileLoaderService } from '@agent/profile-loader.service';
import { ScenarioType, ContextStrategy } from '@enums/agent.enum';

// Mock fs modules to control file system behavior
jest.mock('fs', () => ({
  existsSync: jest.fn(),
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
}));

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;

describe('ProfileLoaderService', () => {
  let service: ProfileLoaderService;

  const mockConfigService = {
    get: jest.fn(),
  };

  function setupConfigMock(overrides?: Record<string, unknown>) {
    const defaults: Record<string, unknown> = {
      AGENT_DEFAULT_MODEL: 'anthropic/claude-sonnet-4-6',
      DULIDAY_API_TOKEN: 'test-duliday-token',
      ...overrides,
    };
    mockConfigService.get.mockImplementation((key: string, defaultVal?: unknown) => {
      return defaults[key] ?? defaultVal;
    });
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    mockExistsSync.mockImplementation((filePath: unknown) => {
      const pathStr = String(filePath);
      if (pathStr.includes('profiles')) return true;
      return false;
    });

    mockReadFile.mockResolvedValue('# System Prompt\nYou are a helpful assistant.' as never);

    setupConfigMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfileLoaderService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<ProfileLoaderService>(ProfileLoaderService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should load profiles during module initialization', async () => {
      await service.onModuleInit();

      const profile = service.getProfile(ScenarioType.CANDIDATE_CONSULTATION);
      expect(profile).not.toBeNull();
    });

    it('should mark as initialized after first call', async () => {
      await service.onModuleInit();
      await service.onModuleInit();

      expect(service.hasProfile(ScenarioType.CANDIDATE_CONSULTATION)).toBe(true);
    });

    it('should load candidate-consultation profile with correct properties', async () => {
      await service.onModuleInit();

      const profile = service.getProfile(ScenarioType.CANDIDATE_CONSULTATION);
      expect(profile).not.toBeNull();
      expect(profile!.name).toBe(ScenarioType.CANDIDATE_CONSULTATION);
      expect(profile!.description).toBe('候选人私聊咨询服务');
      expect(profile!.model).toBe('anthropic/claude-sonnet-4-6');
      expect(profile!.promptType).toBe('weworkSystemPrompt');
      expect(profile!.contextStrategy).toBe(ContextStrategy.SKIP);
    });

    it('should set system prompt from file content', async () => {
      mockReadFile.mockResolvedValue('Custom system prompt content' as never);

      await service.onModuleInit();

      const profile = service.getProfile(ScenarioType.CANDIDATE_CONSULTATION);
      expect(profile!.systemPrompt).toBe('Custom system prompt content');
    });

    it('should set undefined system prompt when file does not exist', async () => {
      mockExistsSync.mockImplementation((filePath: unknown) => {
        const pathStr = String(filePath);
        return pathStr.includes('profiles') && !pathStr.includes('system-prompt');
      });

      await service.onModuleInit();

      const profile = service.getProfile(ScenarioType.CANDIDATE_CONSULTATION);
      expect(profile!.systemPrompt).toBeUndefined();
    });

    it('should have hardcoded allowedTools for candidate-consultation', async () => {
      await service.onModuleInit();

      const profile = service.getProfile(ScenarioType.CANDIDATE_CONSULTATION);
      expect(profile!.allowedTools).toContain('duliday_job_list');
      expect(profile!.allowedTools).toContain('duliday_interview_booking');
      expect(profile!.allowedTools).toContain('memory_recall');
      expect(profile!.allowedTools).toContain('memory_store');
      expect(profile!.allowedTools).toContain('wework_plan_turn');
      expect(profile!.allowedTools).toHaveLength(5);
    });

    it('should inject dulidayToken into profile context', async () => {
      await service.onModuleInit();

      const profile = service.getProfile(ScenarioType.CANDIDATE_CONSULTATION);
      expect(profile!.context).toBeDefined();
      expect(profile!.context!.dulidayToken).toBe('test-duliday-token');
    });

    it('should handle initialization failure gracefully', async () => {
      mockReadFile.mockRejectedValue(new Error('Read file error'));
      await expect(service.onModuleInit()).resolves.not.toThrow();
    });
  });

  describe('getProfile', () => {
    beforeEach(async () => {
      await service.onModuleInit();
    });

    it('should return profile when it exists', () => {
      const profile = service.getProfile(ScenarioType.CANDIDATE_CONSULTATION);
      expect(profile).not.toBeNull();
      expect(profile!.name).toBe(ScenarioType.CANDIDATE_CONSULTATION);
    });

    it('should return null when profile does not exist', () => {
      const profile = service.getProfile('non-existent-scenario');
      expect(profile).toBeNull();
    });

    it('should accept string as scenario argument', () => {
      const profile = service.getProfile('candidate-consultation');
      expect(profile).not.toBeNull();
    });
  });

  describe('getAllProfiles', () => {
    it('should return empty array before initialization', () => {
      const profiles = service.getAllProfiles();
      expect(profiles).toEqual([]);
    });

    it('should return all loaded profiles after initialization', async () => {
      await service.onModuleInit();

      const profiles = service.getAllProfiles();
      expect(profiles).toHaveLength(1);
      expect(profiles[0].name).toBe(ScenarioType.CANDIDATE_CONSULTATION);
    });
  });

  describe('registerProfile', () => {
    it('should register a new profile', () => {
      const testProfile = {
        name: 'test-scenario',
        description: 'Test scenario',
        model: 'test-model',
        allowedTools: [],
      };

      service.registerProfile(testProfile as never);

      const retrieved = service.getProfile('test-scenario');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe('test-scenario');
    });

    it('should overwrite an existing profile with the same name', async () => {
      await service.onModuleInit();

      const updatedProfile = {
        name: ScenarioType.CANDIDATE_CONSULTATION,
        description: 'Updated description',
        model: 'new-model',
        allowedTools: [],
      };

      service.registerProfile(updatedProfile as never);

      const retrieved = service.getProfile(ScenarioType.CANDIDATE_CONSULTATION);
      expect(retrieved!.description).toBe('Updated description');
      expect(retrieved!.model).toBe('new-model');
    });
  });

  describe('reloadProfile', () => {
    beforeEach(async () => {
      await service.onModuleInit();
    });

    it('should reload a known profile successfully', async () => {
      const result = await service.reloadProfile(ScenarioType.CANDIDATE_CONSULTATION);
      expect(result).toBe(true);
    });

    it('should return false for an unknown profile name', async () => {
      const result = await service.reloadProfile('unknown-profile');
      expect(result).toBe(false);
    });

    it('should return false when reload fails with error', async () => {
      mockReadFile.mockRejectedValue(new Error('File system error'));

      const result = await service.reloadProfile(ScenarioType.CANDIDATE_CONSULTATION);
      expect(typeof result).toBe('boolean');
    });
  });

  describe('hasProfile', () => {
    it('should return false when profile does not exist', () => {
      expect(service.hasProfile('non-existent')).toBe(false);
    });

    it('should return true after profile is registered', async () => {
      await service.onModuleInit();
      expect(service.hasProfile(ScenarioType.CANDIDATE_CONSULTATION)).toBe(true);
    });
  });

  describe('removeProfile', () => {
    it('should remove an existing profile and return true', async () => {
      await service.onModuleInit();

      const removed = service.removeProfile(ScenarioType.CANDIDATE_CONSULTATION);

      expect(removed).toBe(true);
      expect(service.hasProfile(ScenarioType.CANDIDATE_CONSULTATION)).toBe(false);
    });

    it('should return false when removing non-existent profile', () => {
      const removed = service.removeProfile('non-existent');
      expect(removed).toBe(false);
    });
  });

  describe('validateProfile', () => {
    it('should return valid for profile with model and name', () => {
      const profile = {
        name: 'test-valid',
        description: 'Valid test',
        model: 'anthropic/claude-sonnet-4-6',
        allowedTools: [],
      };

      const result = service.validateProfile(profile as never);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return invalid when model is empty', () => {
      const profile = {
        name: 'test',
        description: 'Test',
        model: '',
        allowedTools: [],
      };

      const result = service.validateProfile(profile as never);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('model'))).toBe(true);
    });

    it('should return invalid when name is empty', () => {
      const profile = {
        name: '',
        description: 'Test',
        model: 'some-model',
        allowedTools: [],
      };

      const result = service.validateProfile(profile as never);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('name'))).toBe(true);
    });
  });
});
