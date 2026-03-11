import { Global, Module } from '@nestjs/common';

// config
import { SystemConfigRepository } from './config/system-config.repository';
import { GroupBlacklistRepository } from './config/group-blacklist.repository';

// user
import { UserHostingRepository } from './user/user-hosting.repository';

// agent
import { StrategyConfigRepository } from './agent/strategy-config.repository';

// message
import { ChatMessageRepository } from './message/chat-message.repository';
import { MessageProcessingRepository } from './message/message-processing.repository';
import { BookingRepository } from './message/booking.repository';

// monitoring
import { MonitoringRepository } from './monitoring/monitoring.repository';
import { MonitoringHourlyStatsRepository } from './monitoring/monitoring-hourly-stats.repository';
import { MonitoringErrorLogRepository } from './monitoring/monitoring-error-log.repository';

// test-suite
import { TestBatchRepository } from './test-suite/test-batch.repository';
import { TestExecutionRepository } from './test-suite/test-execution.repository';
import { ConversationSourceRepository } from './test-suite/conversation-source.repository';

/**
 * Repository 提供者列表
 */
const REPOSITORIES = [
  // config
  SystemConfigRepository,
  GroupBlacklistRepository,
  // user
  UserHostingRepository,
  // agent
  StrategyConfigRepository,
  // message
  ChatMessageRepository,
  MessageProcessingRepository,
  BookingRepository,
  // monitoring
  MonitoringRepository,
  MonitoringHourlyStatsRepository,
  MonitoringErrorLogRepository,
  // test-suite
  TestBatchRepository,
  TestExecutionRepository,
  ConversationSourceRepository,
];

/**
 * 数据访问模块
 *
 * 全局模块，提供：
 * - *Repository: 各业务域数据访问层
 *
 * 依赖 SupabaseModule（core/supabase）提供的 SupabaseService。
 *
 * 按业务域组织：config / user / agent / message / monitoring / test-suite
 */
@Global()
@Module({
  providers: [...REPOSITORIES],
  exports: [...REPOSITORIES],
})
export class DbModule {}
