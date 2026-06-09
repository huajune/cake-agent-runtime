import { Global, Module } from '@nestjs/common';
import { BotController } from './bot.controller';
import { BotService } from './bot.service';
import { HttpModule } from '@infra/client-http/http.module';
import { ApiConfigModule } from '@infra/config/api-config.module';
import { BOT_ACCOUNT_PROVIDER } from '@biz/ops-events/bot-account.provider';

/**
 * @Global：除企微渠道内部使用外，运营事件域（biz/ops-events）通过 BOT_ACCOUNT_PROVIDER
 * 令牌依赖 BotService（依赖倒置——biz 不得 import wecom）。设为全局后 biz 侧无需 import
 * 本模块即可注入该令牌；绑定在 wecom 侧完成（channels 允许依赖 biz 抽象）。
 */
@Global()
@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [BotController],
  providers: [BotService, { provide: BOT_ACCOUNT_PROVIDER, useExisting: BotService }],
  exports: [BotService, BOT_ACCOUNT_PROVIDER],
})
export class BotModule {}
