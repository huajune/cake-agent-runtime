import { Global, Module } from '@nestjs/common';
import { HandoffRecorderService } from './handoff-recorder.service';
import { HandoffEventsRepository } from './handoff-events.repository';

/**
 * 转人工触发底账模块（写入侧）。
 *
 * @Global：HandoffRecorderService 被 request_handoff 工具（以及未来其它转人工触点）调用。
 * 依赖 @Global 的 OpsEventsModule 写 handoff.triggered 事件。
 */
@Global()
@Module({
  providers: [HandoffEventsRepository, HandoffRecorderService],
  exports: [HandoffRecorderService],
})
export class HandoffEventsModule {}
