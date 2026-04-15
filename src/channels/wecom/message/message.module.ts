import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { MessageIngressController } from './ingress/message-ingress.controller';
import { MessageOpsController } from './ingress/message-ops.controller';
import { MessageService } from './message.service';
import { MessageProcessor } from './runtime/message.processor';
import { AgentModule } from '@agent/agent.module';
import { MessageSenderModule } from '../message-sender/message-sender.module';
import { BizMessageModule } from '@biz/message/message.module';
import { HostingConfigModule } from '@biz/hosting-config/hosting-config.module';
import { UserModule } from '@biz/user/user.module';
import { MonitoringModule } from '@biz/monitoring/monitoring.module';
import { RecruitmentCaseModule } from '@biz/recruitment-case/recruitment-case.module';

// 导入子服务
import { MessageDeduplicationService } from './runtime/deduplication.service';

import { MessageFilterService } from './application/filter.service';
import { SimpleMergeService } from './runtime/simple-merge.service';
import { MessageDeliveryService } from './delivery/delivery.service';
import { MessageCallbackAdapterService } from './ingress/callback-adapter.service';
import { MessagePipelineService } from './application/pipeline.service';
import { ImageDescriptionService } from './application/image-description.service';
import { WecomMessageObservabilityService } from './telemetry/wecom-message-observability.service';
import { NotificationModule } from '@notification/notification.module';
import { ConversationRiskModule } from '@/conversation-risk/conversation-risk.module';
import { MessageRuntimeConfigService } from './runtime/message-runtime-config.service';
import { MessageTraceStoreService } from './telemetry/message-trace-store.service';
import { MessageWorkerManagerService } from './runtime/message-worker-manager.service';
import { AcceptInboundMessageService } from './application/accept-inbound-message.service';
import { ReplyWorkflowService } from './application/reply-workflow.service';
import { MessageProcessingFailureService } from './application/message-processing-failure.service';
import { PreAgentRiskInterceptService } from './application/pre-agent-risk-intercept.service';
import { TypingPolicyService } from './delivery/typing-policy.service';
import {
  ContactTypeFilterRule,
  EmptyContentFilterRule,
  EnterpriseGroupFilterRule,
  GroupBlacklistFilterRule,
  PausedUserFilterRule,
  RoomMessageFilterRule,
  SelfMessageFilterRule,
  SourceMessageFilterRule,
  SupportedMessageTypeFilterRule,
} from './application/filter-rules/message-filter.rules';

/**
 * 消息处理模块
 * 负责接收、解析消息并触发 AI 自动回复
 */
@Module({
  imports: [
    ConfigModule,
    forwardRef(() => AgentModule),
    MessageSenderModule,
    BizMessageModule,
    HostingConfigModule,
    UserModule,
    RecruitmentCaseModule,
    forwardRef(() => MonitoringModule),
    NotificationModule,
    ConversationRiskModule,
    // 注册消息聚合队列
    BullModule.registerQueue({
      name: 'message-merge',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [MessageIngressController, MessageOpsController],
  providers: [
    // 主服务
    MessageRuntimeConfigService,
    MessageTraceStoreService,
    MessageWorkerManagerService,
    MessageService,
    MessageProcessor,
    // 子服务（8个核心服务，按职责分类）
    MessageDeduplicationService, // 消息去重
    MessageFilterService, // 消息过滤
    SelfMessageFilterRule,
    SourceMessageFilterRule,
    ContactTypeFilterRule,
    PausedUserFilterRule,
    GroupBlacklistFilterRule,
    EnterpriseGroupFilterRule,
    RoomMessageFilterRule,
    SupportedMessageTypeFilterRule,
    EmptyContentFilterRule,
    SimpleMergeService, // 简化版消息聚合（使用 Bull Queue 原生能力）
    MessageDeliveryService, // 消息发送（统一分段发送和监控）
    TypingPolicyService, // 发送策略（分段/打字延迟）
    MessageCallbackAdapterService, // 消息回调适配器（支持小组级和企业级格式）
    MessagePipelineService, // 消息处理管线（核心处理逻辑）
    ImageDescriptionService, // 图片描述（异步 vision 识别 → 回写 content）
    WecomMessageObservabilityService, // 企微消息链路观测（阶段时延 + 结构化调试上下文）
    AcceptInboundMessageService, // 入站预处理（过滤、去重、写历史）
    ReplyWorkflowService, // 回复工作流（调用 Agent → 发送回复）
    PreAgentRiskInterceptService, // Agent 前置风险同步拦截
    MessageProcessingFailureService, // 失败兜底（告警、降级回复）
  ],
  exports: [MessageService, MessageFilterService, MessageProcessor],
})
export class MessageModule {}
