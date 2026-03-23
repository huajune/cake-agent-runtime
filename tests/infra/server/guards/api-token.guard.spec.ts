import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { ApiTokenGuard, IS_PUBLIC_KEY } from '@infra/server/guards/api-token.guard';

describe('ApiTokenGuard', () => {
  let guard: ApiTokenGuard;
  let mockConfigService: { get: jest.Mock };
  let mockReflector: { getAllAndOverride: jest.Mock };

  function buildContext({
    authHeader,
    isPublic = false,
    method = 'GET',
    url = '/test',
  }: {
    authHeader?: string;
    isPublic?: boolean;
    method?: string;
    url?: string;
  } = {}): ExecutionContext {
    const request = {
      headers: authHeader !== undefined ? { authorization: authHeader } : {},
      method,
      url,
    };

    const handler = jest.fn();
    const classRef = jest.fn();

    mockReflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === IS_PUBLIC_KEY) return isPublic;
      return undefined;
    });

    return {
      getHandler: () => handler,
      getClass: () => classRef,
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  }

  async function buildGuard(guardToken: string | undefined): Promise<void> {
    jest.clearAllMocks();

    mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'API_GUARD_TOKEN') return guardToken;
        return undefined;
      }),
    };

    mockReflector = {
      getAllAndOverride: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiTokenGuard,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: Reflector, useValue: mockReflector },
      ],
    }).compile();

    guard = module.get<ApiTokenGuard>(ApiTokenGuard);
  }

  describe('when API_GUARD_TOKEN is configured', () => {
    const VALID_TOKEN = 'secret-token-123';

    beforeEach(async () => {
      await buildGuard(VALID_TOKEN);
    });

    it('should be defined', () => {
      expect(guard).toBeDefined();
    });

    it('should allow requests with a valid Bearer token', () => {
      const context = buildContext({ authHeader: `Bearer ${VALID_TOKEN}` });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should reject requests with a wrong token', () => {
      const context = buildContext({ authHeader: 'Bearer wrong-token' });
      expect(guard.canActivate(context)).toBe(false);
    });

    it('should reject requests without an Authorization header', () => {
      const context = buildContext();
      expect(guard.canActivate(context)).toBe(false);
    });

    it('should reject requests with an empty Authorization header', () => {
      const context = buildContext({ authHeader: '' });
      expect(guard.canActivate(context)).toBe(false);
    });

    it('should allow requests where the raw token matches even without the Bearer prefix', () => {
      // The implementation uses authHeader.replace('Bearer ', '') which is a plain string
      // replacement — not a regex anchor. When the header is exactly the token value the
      // replace is a no-op and the token still matches, so the guard passes the request.
      const context = buildContext({ authHeader: VALID_TOKEN });
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  describe('@Public() decorator bypass', () => {
    const VALID_TOKEN = 'secret-token-123';

    beforeEach(async () => {
      await buildGuard(VALID_TOKEN);
    });

    it('should allow requests on @Public() endpoints even without a token', () => {
      const context = buildContext({ isPublic: true });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow requests on @Public() endpoints even with a wrong token', () => {
      const context = buildContext({ isPublic: true, authHeader: 'Bearer wrong-token' });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should check the reflector with IS_PUBLIC_KEY against handler and class', () => {
      const context = buildContext({ isPublic: true });
      guard.canActivate(context);
      expect(mockReflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
    });
  });

  describe('when API_GUARD_TOKEN is not configured', () => {
    beforeEach(async () => {
      await buildGuard(undefined);
    });

    it('should allow all requests when no token is configured', () => {
      const context = buildContext();
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow requests even with a wrong token when no guard token is configured', () => {
      const context = buildContext({ authHeader: 'Bearer some-random-token' });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow @Public() requests when no guard token is configured', () => {
      const context = buildContext({ isPublic: true });
      expect(guard.canActivate(context)).toBe(true);
    });
  });
});
