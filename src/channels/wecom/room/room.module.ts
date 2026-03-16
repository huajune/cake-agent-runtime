import { Module } from '@nestjs/common';
import { RoomController } from './room.controller';
import { RoomService } from './room.service';
import { HttpModule } from '@core/client-http';
import { ApiConfigModule } from '@core/config';

/**
 * 群聊管理模块
 * 负责群聊相关的所有功能
 */
@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [RoomController],
  providers: [RoomService],
  exports: [RoomService],
})
export class RoomModule {}
