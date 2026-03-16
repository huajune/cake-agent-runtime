import { Module } from '@nestjs/common';
import { BotModule } from './bot/bot.module';
import { ChatModule } from './chat/chat.module';
import { ContactModule } from './contact/contact.module';
import { CustomerModule } from './customer/customer.module';
import { GroupModule } from './group/group.module';
import { MessageModule } from './message/message.module';
import { MessageSenderModule } from './message-sender/message-sender.module';
import { RoomModule } from './room/room.module';
import { UserModule } from './user/user.module';

/**
 * 企业微信业务域模块
 *
 * 负责企业微信相关的所有业务功能，包括：
 * - 机器人管理 (Bot)
 * - 会话管理 (Chat)
 * - 联系人管理 (Contact)
 * - 客户关系管理 (Customer)
 * - 小组管理 (Group)
 * - 消息处理 (Message)
 * - 消息发送 (MessageSender)
 * - 群聊管理 (Room)
 * - 用户管理 (User)
 */
@Module({
  imports: [
    BotModule,
    ChatModule,
    ContactModule,
    CustomerModule,
    GroupModule,
    MessageModule,
    MessageSenderModule,
    RoomModule,
    UserModule,
  ],
  exports: [
    BotModule,
    ChatModule,
    ContactModule,
    CustomerModule,
    GroupModule,
    MessageModule,
    MessageSenderModule,
    RoomModule,
    UserModule,
  ],
})
export class WecomModule {}
