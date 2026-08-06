import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import { SupabaseService } from '@infra/supabase/supabase.service';

// Mock @supabase/supabase-js
const mockSupabaseClient = {
  from: jest.fn().mockReturnThis(),
  rpc: jest.fn(),
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabaseClient),
}));

describe('SupabaseService', () => {
  let service: SupabaseService;

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: string) => {
      const config: Record<string, string> = {
        NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
        ENABLE_AI_REPLY: 'true',
      };
      return config[key] ?? defaultValue;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupabaseService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<SupabaseService>(SupabaseService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('initialization', () => {
    it('should initialize Supabase client when credentials are provided', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createClient } = require('@supabase/supabase-js');
      expect(createClient).toHaveBeenCalledWith(
        'https://test.supabase.co',
        'test-service-key',
        expect.objectContaining({
          auth: { autoRefreshToken: false, persistSession: false },
        }),
      );
    });

    it('should be available when initialized', () => {
      expect(service.isAvailable()).toBe(true);
      expect(service.isClientInitialized()).toBe(true);
    });
  });

  describe('getSupabaseClient', () => {
    it('should return Supabase client when initialized', () => {
      const client = service.getSupabaseClient();
      expect(client).toBeDefined();
      expect(client).toBe(mockSupabaseClient);
    });
  });

  describe('when credentials are missing', () => {
    let uninitializedService: SupabaseService;

    beforeEach(async () => {
      const emptyConfigService = {
        get: jest.fn().mockReturnValue(''),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SupabaseService,
          {
            provide: ConfigService,
            useValue: emptyConfigService,
          },
        ],
      }).compile();

      uninitializedService = module.get<SupabaseService>(SupabaseService);
    });

    it('should not be available', () => {
      expect(uninitializedService.isAvailable()).toBe(false);
      expect(uninitializedService.isClientInitialized()).toBe(false);
    });

    it('should return null for Supabase client', () => {
      expect(uninitializedService.getSupabaseClient()).toBeNull();
    });
  });

  describe('keep-alive cron 的时区', () => {
    // 不显式指定 timeZone 会跟随服务器时区（生产容器 UTC），注释写的"凌晨 3 点"
    // 与实际执行时间（上海 11:00）对不上，排障时容易被误导。
    it('keep-alive 必须锁定 Asia/Shanghai，而不是跟随服务器时区', () => {
      const options = Reflect.getMetadata(
        SCHEDULE_CRON_OPTIONS,
        SupabaseService.prototype.keepAlive,
      );

      expect(options?.timeZone).toBe('Asia/Shanghai');
    });
  });
});
