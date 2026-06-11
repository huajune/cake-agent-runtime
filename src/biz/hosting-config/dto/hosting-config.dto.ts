import {
  IsBoolean,
  IsOptional,
  IsNumber,
  IsString,
  IsIn,
  IsNotEmpty,
  Min,
  Max,
} from 'class-validator';

// ==================== 运行时开关 ====================

export class ToggleDto {
  @IsBoolean()
  enabled: boolean;
}

// ==================== Agent 回复策略配置 ====================

export class UpdateAgentReplyConfigDto {
  @IsOptional()
  @IsString()
  wecomCallbackModelId?: string;

  @IsOptional()
  @IsIn(['fast', 'deep'])
  wecomCallbackThinkingMode?: 'fast' | 'deep';

  @IsOptional()
  @IsNumber()
  @Min(0)
  initialMergeWindowMs?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  typingDelayPerCharMs?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  typingSpeedCharsPerSec?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  paragraphGapMs?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  alertThrottleWindowMs?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  alertThrottleMaxCount?: number;

  @IsOptional()
  @IsBoolean()
  businessAlertEnabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(1)
  minSamplesForAlert?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  alertIntervalMinutes?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  successRateCritical?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  avgDurationCritical?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  queueDepthCritical?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  errorRateCritical?: number;
}

// ==================== 群任务通知配置 ====================

export class UpdateGroupTaskConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

// ==================== 黑名单 ====================

export class AddToBlacklistDto {
  @IsString()
  id: string;

  @IsIn(['chatId', 'groupId'])
  type: 'chatId' | 'groupId';

  @IsOptional()
  @IsString()
  reason?: string;

  /** 仅 type=chatId 生效：永久暂停托管（不自动解禁），如店长微信、客户微信 */
  @IsOptional()
  @IsBoolean()
  permanent?: boolean;

  /** 操作人（供回溯） */
  @IsOptional()
  @IsString()
  operator?: string;
}

export class RemoveFromBlacklistDto {
  @IsString()
  id: string;

  @IsIn(['chatId', 'groupId'])
  type: 'chatId' | 'groupId';
}

// ==================== 候选人黑名单 ====================

export class AddCandidateBlacklistDto {
  /** 候选人标识：chatId / imContactId / externalUserId 任一均可 */
  @IsString()
  targetId: string;

  /** 拉黑理由（命中告警与暂停记录中展示，必填且不可为空字符串） */
  @IsString()
  @IsNotEmpty()
  reason: string;

  @IsOptional()
  @IsString()
  operator?: string;

  /** 拉黑时的会话快照（可选，供回溯） */
  @IsOptional()
  @IsString()
  chatId?: string;

  @IsOptional()
  @IsString()
  imContactId?: string;

  @IsOptional()
  @IsString()
  contactName?: string;
}

export class RemoveCandidateBlacklistDto {
  @IsString()
  targetId: string;
}
