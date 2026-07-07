import { Global, Module } from '@nestjs/common';
import { MessageSenderController } from './message-sender.controller';
import { MessageSenderService } from './message-sender.service';
import { HttpModule } from '@infra/client-http/http.module';
import { ApiConfigModule } from '@infra/config/api-config.module';
import { GROUP_MESSAGE_SENDER } from '@biz/group-task/providers/group-channel.provider';

/**
 * 消息发送模块
 * 负责所有消息发送相关功能
 *
 * @Global：群任务域（biz/group-task）通过 GROUP_MESSAGE_SENDER 令牌消费发送能力
 * （依赖倒置，接口定义在 biz 侧），全局可见避免 biz 反向 import 本模块。
 */
@Global()
@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [MessageSenderController],
  providers: [
    MessageSenderService,
    { provide: GROUP_MESSAGE_SENDER, useExisting: MessageSenderService },
  ],
  exports: [MessageSenderService, GROUP_MESSAGE_SENDER],
})
export class MessageSenderModule {}
