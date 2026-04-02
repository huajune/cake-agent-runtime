import { Module } from '@nestjs/common';
import { RootRedirectController, WebEntryController } from './web-entry.controller';

/**
 * Web 入口模块
 *
 * 负责后台 SPA 的入口托管与根路径重定向。
 * 这是服务端接入层能力，不属于任何业务域。
 */
@Module({
  controllers: [RootRedirectController, WebEntryController],
})
export class WebEntryModule {}
