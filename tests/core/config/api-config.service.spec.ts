import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ApiConfigService } from '@core/config/api-config.service';

describe('ApiConfigService', () => {
  let service: ApiConfigService;

  const STRIDE_BASE_URL = 'https://stride-bg.dpclouds.com';
  const STRIDE_ENTERPRISE_BASE_URL = 'https://enterprise.stride-bg.dpclouds.com';

  const mockConfigService = {
    get: jest.fn((key: string) => {
      const config: Record<string, string> = {
        STRIDE_API_BASE_URL: STRIDE_BASE_URL,
        STRIDE_ENTERPRISE_API_BASE_URL: STRIDE_ENTERPRISE_BASE_URL,
      };
      return config[key];
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [ApiConfigService, { provide: ConfigService, useValue: mockConfigService }],
    }).compile();

    service = module.get<ApiConfigService>(ApiConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ==================== getStrideStreamApiBaseUrl ====================

  describe('getStrideStreamApiBaseUrl', () => {
    it('should return stream-api base URL', () => {
      const result = service.getStrideStreamApiBaseUrl();
      expect(result).toBe(`${STRIDE_BASE_URL}/stream-api`);
    });
  });

  // ==================== getStrideApiV2BaseUrl ====================

  describe('getStrideApiV2BaseUrl', () => {
    it('should return v2 API base URL', () => {
      const result = service.getStrideApiV2BaseUrl();
      expect(result).toBe(`${STRIDE_BASE_URL}/api/v2`);
    });
  });

  // ==================== getStrideEnterpriseApiV2BaseUrl ====================

  describe('getStrideEnterpriseApiV2BaseUrl', () => {
    it('should return enterprise v2 API base URL', () => {
      const result = service.getStrideEnterpriseApiV2BaseUrl();
      expect(result).toBe(`${STRIDE_ENTERPRISE_BASE_URL}/api/v2`);
    });
  });

  // ==================== buildApiUrl ====================

  describe('buildApiUrl', () => {
    it('should build stream-api URL by default', () => {
      const result = service.buildApiUrl('/chat/list');
      expect(result).toBe(`${STRIDE_BASE_URL}/stream-api/chat/list`);
    });

    it('should build stream-api URL explicitly', () => {
      const result = service.buildApiUrl('/message/history', 'stream-api');
      expect(result).toBe(`${STRIDE_BASE_URL}/stream-api/message/history`);
    });

    it('should build v2 API URL', () => {
      const result = service.buildApiUrl('/customer/list', 'v2');
      expect(result).toBe(`${STRIDE_BASE_URL}/api/v2/customer/list`);
    });

    it('should build enterprise v2 API URL', () => {
      const result = service.buildApiUrl('/message/send', 'enterprise-v2');
      expect(result).toBe(`${STRIDE_ENTERPRISE_BASE_URL}/api/v2/message/send`);
    });

    it('should prepend slash to endpoint if missing', () => {
      const result = service.buildApiUrl('chat/list');
      expect(result).toBe(`${STRIDE_BASE_URL}/stream-api/chat/list`);
    });

    it('should not double-slash when endpoint already starts with slash', () => {
      const result = service.buildApiUrl('/chat/list');
      expect(result).not.toContain('//stream-api');
      expect(result).toBe(`${STRIDE_BASE_URL}/stream-api/chat/list`);
    });
  });

  // ==================== endpoints ====================

  describe('endpoints', () => {
    describe('chat', () => {
      it('should build correct chat list URL', () => {
        expect(service.endpoints.chat.list()).toBe(`${STRIDE_BASE_URL}/stream-api/chat/list`);
      });

      it('should build correct chat get URL', () => {
        expect(service.endpoints.chat.get()).toBe(`${STRIDE_BASE_URL}/stream-api/chat/get`);
      });
    });

    describe('message', () => {
      it('should build correct message history URL (stream-api)', () => {
        expect(service.endpoints.message.history()).toBe(
          `${STRIDE_BASE_URL}/stream-api/message/history`,
        );
      });

      it('should build correct message send URL (enterprise-v2)', () => {
        expect(service.endpoints.message.send()).toBe(
          `${STRIDE_ENTERPRISE_BASE_URL}/api/v2/message/send`,
        );
      });

      it('should build correct group message send URL (stream-api)', () => {
        expect(service.endpoints.message.sendGroup()).toBe(
          `${STRIDE_BASE_URL}/stream-api/message/send`,
        );
      });

      it('should build correct sentResult URL', () => {
        expect(service.endpoints.message.sentResult()).toBe(
          `${STRIDE_BASE_URL}/stream-api/sentResult`,
        );
      });
    });

    describe('contact', () => {
      it('should build correct contact list URL', () => {
        expect(service.endpoints.contact.list()).toBe(`${STRIDE_BASE_URL}/stream-api/contact/list`);
      });
    });

    describe('room', () => {
      it('should build correct room list URL', () => {
        expect(service.endpoints.room.list()).toBe(`${STRIDE_BASE_URL}/stream-api/room/list`);
      });

      it('should build correct room simpleList URL', () => {
        expect(service.endpoints.room.simpleList()).toBe(
          `${STRIDE_BASE_URL}/stream-api/room/simpleList`,
        );
      });

      it('should build correct room addMember URL', () => {
        expect(service.endpoints.room.addMember()).toBe(
          `${STRIDE_BASE_URL}/stream-api/room/addMember`,
        );
      });

      it('should build correct addFriendSend URL', () => {
        expect(service.endpoints.room.addFriendSend()).toBe(
          `${STRIDE_BASE_URL}/stream-api/addFriend/room/send`,
        );
      });
    });

    describe('groupChat', () => {
      it('should build correct group chat list URL (enterprise-v2)', () => {
        expect(service.endpoints.groupChat.list()).toBe(
          `${STRIDE_ENTERPRISE_BASE_URL}/api/v2/groupChat/list`,
        );
      });
    });

    describe('user', () => {
      it('should build correct user list URL', () => {
        expect(service.endpoints.user.list()).toBe(`${STRIDE_BASE_URL}/stream-api/user/list`);
      });
    });

    describe('bot', () => {
      it('should build correct bot list URL', () => {
        expect(service.endpoints.bot.list()).toBe(`${STRIDE_BASE_URL}/stream-api/bot/list`);
      });
    });

    describe('group', () => {
      it('should build correct group list URL (enterprise-v2)', () => {
        expect(service.endpoints.group.list()).toBe(
          `${STRIDE_ENTERPRISE_BASE_URL}/api/v2/group/list`,
        );
      });
    });

    describe('customer', () => {
      it('should build correct customer list URL (v2)', () => {
        expect(service.endpoints.customer.list()).toBe(`${STRIDE_BASE_URL}/api/v2/customer/list`);
      });
    });
  });
});
