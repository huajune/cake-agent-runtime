import { Global, Module } from '@nestjs/common';
import { RoomController } from './room.controller';
import { RoomService } from './room.service';
import { HttpModule } from '@infra/client-http/http.module';
import { ApiConfigModule } from '@infra/config/api-config.module';
import { GROUP_ROOM_QUERY } from '@biz/group-task/providers/group-channel.provider';

/**
 * 群聊管理模块
 * 负责群聊相关的所有功能
 *
 * @Global：群任务域（biz/group-task）通过 GROUP_ROOM_QUERY 令牌消费群查询能力
 * （依赖倒置，接口定义在 biz 侧），全局可见避免 biz 反向 import 本模块。
 */
@Global()
@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [RoomController],
  providers: [RoomService, { provide: GROUP_ROOM_QUERY, useExisting: RoomService }],
  exports: [RoomService, GROUP_ROOM_QUERY],
})
export class RoomModule {}
