import { Module } from '@nestjs/common';
import { CustomerController } from './customer.controller';
import { CustomerService } from './customer.service';
import { NewCustomerCallbackController } from './new-customer-callback.controller';
import { NewCustomerCallbackService } from './new-customer-callback.service';
import { HttpModule } from '@infra/client-http/http.module';
import { ApiConfigModule } from '@infra/config/api-config.module';
import { BotModule } from '../bot/bot.module';

@Module({
  // BotModule：NewCustomerCallbackService 按 imBotId 查 bot 所属企业 corpId 回填 friend.added
  imports: [HttpModule, ApiConfigModule, BotModule],
  // NewCustomerCallbackController：新增客户回调-RPA（friend.added 独立信号，OpsEventsRecorder 来自 @Global OpsEventsModule）
  controllers: [CustomerController, NewCustomerCallbackController],
  providers: [CustomerService, NewCustomerCallbackService],
  exports: [CustomerService],
})
export class CustomerModule {}
