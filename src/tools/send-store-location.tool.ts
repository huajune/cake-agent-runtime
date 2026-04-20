import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { MessageSenderService } from '@channels/wecom/message-sender/message-sender.service';
import { SendMessageType } from '@channels/wecom/message-sender/dto/send-message.dto';
import { SpongeService } from '@sponge/sponge.service';
import type { JobDetail } from '@sponge/sponge.types';
import { ToolBuilder } from '@shared-types/tool.types';

const logger = new Logger('send_store_location');

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function pickNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractStoreLocation(job: JobDetail): {
  storeName: string | null;
  storeAddress: string | null;
  latitude: number | null;
  longitude: number | null;
} {
  const basicInfo = (job.basicInfo ?? {}) as Record<string, unknown>;
  const storeInfo =
    basicInfo.storeInfo && typeof basicInfo.storeInfo === 'object'
      ? (basicInfo.storeInfo as Record<string, unknown>)
      : {};

  return {
    storeName: pickString(storeInfo.storeName) ?? pickString(basicInfo.storeName),
    storeAddress:
      pickString(storeInfo.storeAddress) ??
      pickString(storeInfo.address) ??
      pickString(basicInfo.storeAddress),
    latitude: pickNumber(storeInfo.latitude),
    longitude: pickNumber(storeInfo.longitude),
  };
}

export function buildSendStoreLocationTool(
  spongeService: SpongeService,
  messageSenderService: MessageSenderService,
): ToolBuilder {
  return (context) =>
    tool({
      description: `向候选人发送当前门店的企微位置消息（不是文本回复）。

## 使用场景
- 已经明确具体岗位或门店后，候选人追问"地址在哪"、"发个定位"、"怎么过去"、"导航怎么走"时优先调用

## 参数规则
- jobId 可选：
  - 当前焦点岗位已经唯一明确时，可省略，让工具自动复用当前焦点岗位
  - 若最近同时聊了多个岗位或门店，必须传入明确的 jobId；不明确时先向候选人问清楚是哪家店

## 执行效果
- 工具直接向当前企微会话发送位置消息（不是普通文本回复）
- 成功后通常只需要再补一句简短确认

## 硬规则
- 不要凭记忆手写坐标或自己拼定位 payload；只通过此工具发送
- 如果工具返回 _fixedReply，必须原样输出，不要额外再重写一遍地址说明
- 若工具返回失败且同时带回 storeAddress，可改为用文字把门店地址发给候选人`,
      inputSchema: z.object({
        jobId: z
          .number()
          .int()
          .optional()
          .describe('目标岗位 jobId。若当前焦点岗位已唯一明确，可省略'),
      }),
      execute: async ({ jobId }) => {
        const resolvedJobId = jobId ?? context.currentFocusJob?.jobId ?? null;
        if (!resolvedJobId) {
          return {
            success: false,
            errorType: 'missing_job_id',
            error: '缺少明确的 jobId，暂时无法判断该给哪家门店发定位',
          };
        }

        if (!context.token || !context.botImId || !(context.imContactId || context.imRoomId)) {
          return {
            success: false,
            errorType: 'missing_delivery_context',
            error: '缺少当前会话发送上下文，无法发送定位消息',
          };
        }

        try {
          const { jobs } = await spongeService.fetchJobs({
            jobIdList: [resolvedJobId],
            pageNum: 1,
            pageSize: 1,
            options: {
              includeBasicInfo: true,
            },
          });

          const matchedJob = jobs.find((job) => job.basicInfo?.jobId === resolvedJobId) ?? jobs[0];
          if (!matchedJob) {
            return {
              success: false,
              errorType: 'job_not_found',
              error: `未找到 jobId=${resolvedJobId} 对应的岗位，无法发送门店定位`,
            };
          }

          const store = extractStoreLocation(matchedJob);
          if (
            !store.storeName ||
            !store.storeAddress ||
            store.latitude == null ||
            store.longitude == null
          ) {
            return {
              success: false,
              errorType: 'store_location_unavailable',
              error: '当前岗位缺少完整门店定位信息，暂时无法发送位置消息',
              jobId: resolvedJobId,
              storeName: store.storeName,
              storeAddress: store.storeAddress,
            };
          }

          await messageSenderService.sendMessage({
            token: context.token,
            imBotId: context.botImId,
            imContactId: context.imContactId,
            imRoomId: context.imRoomId,
            chatId: context.chatId ?? context.sessionId,
            messageType: SendMessageType.LOCATION,
            payload: {
              accuracy: 15,
              address: store.storeAddress,
              latitude: store.latitude,
              longitude: store.longitude,
              name: store.storeName,
            },
            _apiType: context.apiType,
          });

          logger.log(
            `门店定位发送成功: jobId=${resolvedJobId}, store=${store.storeName}, session=${context.sessionId}`,
          );

          return {
            success: true,
            jobId: resolvedJobId,
            storeName: store.storeName,
            storeAddress: store.storeAddress,
            latitude: store.latitude,
            longitude: store.longitude,
            _fixedReply: '门店位置我发你了，你点开就能看导航。',
            _replyRule:
              '当工具返回 _fixedReply 时，必须原样输出 _fixedReply 的内容作为本轮完整回复',
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`门店定位发送失败: jobId=${resolvedJobId}, error=${message}`);
          return {
            success: false,
            errorType: 'send_location_failed',
            error: `发送门店定位失败: ${message}`,
            jobId: resolvedJobId,
          };
        }
      },
    });
}
