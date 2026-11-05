import { Module, type ModuleMetadata, type Provider, type Type } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Socket } from 'node:net';
import { ApiConfigModule } from '@infra/config/api-config.module';
import { GroupRouteCredentialsService } from '@channels/wecom/message/credentials/group-route-credentials.service';
import { MessageModule } from '@channels/wecom/message/message.module';

@Module({})
class ExternalDependenciesStubModule {}

describe('MessageModule credential provider visibility', () => {
  it('resolves the real credential provider through module imports without external clients', async () => {
    const socket = jest.spyOn(Socket.prototype, 'connect').mockImplementation(() => {
      throw new Error('External connections are forbidden in module assembly tests');
    });
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      throw new Error('External HTTP is forbidden in module assembly tests');
    });
    try {
      const builder = Test.createTestingModule({ imports: [MessageModule] });
      const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, MessageModule) as NonNullable<
        ModuleMetadata['imports']
      >;
      // Keep the actual configuration modules. Replace unrelated application modules
      // before Nest instantiates providers, rather than booting real Redis/DB clients.
      for (const imported of imports) {
        const target =
          typeof imported === 'object' && 'forwardRef' in imported
            ? imported.forwardRef()
            : imported;
        if (target !== ConfigModule && target !== ApiConfigModule)
          builder.overrideModule(target as Type<unknown>).useModule(ExternalDependenciesStubModule);
      }
      const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, MessageModule) as Provider[];
      for (const provider of providers) {
        const token = typeof provider === 'function' ? provider : provider.provide;
        if (token !== GroupRouteCredentialsService) builder.overrideProvider(token).useValue({});
      }
      builder.overrideProvider(ConfigService).useValue({
        get: (key: string) =>
          ({
            STRIDE_API_BASE_URL: 'https://group.fixture.invalid',
            STRIDE_ENTERPRISE_API_BASE_URL: 'https://enterprise.fixture.invalid',
          })[key],
      });
      const module = await builder.compile();
      try {
        expect(module.get(GroupRouteCredentialsService)).toBeInstanceOf(
          GroupRouteCredentialsService,
        );
        expect(socket).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        await module.close();
      }
    } finally {
      jest.restoreAllMocks();
    }
  });
});
