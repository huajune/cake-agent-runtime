import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { MessageSenderService } from '@channels/wecom/message-sender/message-sender.service';
import { SendMessageType } from '@channels/wecom/message-sender/dto/send-message.dto';
import { SpongeService } from '@sponge/sponge.service';
import type { JobDetail } from '@sponge/sponge.types';
import { ToolBuilder } from '@shared-types/tool.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

const logger = new Logger('send_store_location');

const DESCRIPTION = `向候选人发送当前门店的企微位置消息（不是文本回复）。

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
- 若工具返回失败且同时带回 storeAddress，可改为用文字把门店地址发给候选人
- 工具返回 floorHint 不为空时，_fixedReply 已包含楼层/铺号提示，直接原样发送即可，不要再重复编造楼层信息

## 空头承诺禁忌
- 本轮回复中只要出现"门店定位我发你 / 发你个定位 / 把定位发你 / 我发个位置过去"等表述，**必须**本轮实调本工具
- 已说要发定位但没调本工具 = 空头承诺，候选人下轮没收到定位会困惑或流失
- 工具调用失败时优先用文字发送 storeAddress 兜底，不得只说"我发你"然后什么都没发`;

const inputSchema = z.object({
  jobId: z.number().int().optional().describe('目标岗位 jobId。若当前焦点岗位已唯一明确，可省略'),
});

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

/**
 * 楼层提示匹配模式。只识别有"楼/层/F/B[1-9]"等明确楼层指示的片段，
 * 避免把"青塔西路 1 号"这种街道门牌号误判为楼层。
 *
 * 命中后会顺带把紧随其后的"X 号 / X-X 号 / X 室 / X 铺"等铺位号一起抓出来，
 * 因为候选人在商场里关心的是"几层 + 几号铺"。
 */
const FLOOR_HINT_PATTERN =
  /((?:负[一二三四五六七八九十]|地下[一二三四五1-5]|[BLF][1-5]|[1-9][0-9]?)[层楼F](?:[\s-]?\d{1,3}(?:[\s-]\d{1,3})?\s*(?:号|室|铺|档|位|窗口|商铺))?|(?:第)?[一二三四五六七八九十]+\s*层(?:[\s-]?\d{1,3}(?:[\s-]\d{1,3})?\s*(?:号|室|铺|档|位|窗口|商铺))?)/g;

/**
 * 从完整门店地址里抽出"楼层 / 单元号"等微定位信息。
 * 企微 location 卡片只显示场馆名，B1层 48-50 号这类关键定位埋在地址文本里候选人看不到，
 * 需要发卡片后再用一句文字补出来。
 */
function extractFloorHint(storeAddress: string | null): string | null {
  if (!storeAddress) return null;
  const normalized = storeAddress.replace(/\s+/g, '');

  const hits = new Set<string>();
  for (const match of normalized.matchAll(FLOOR_HINT_PATTERN)) {
    if (match[0]) hits.add(match[0]);
  }

  if (hits.size === 0) return null;
  return Array.from(hits).join(' ');
}

export function buildSendStoreLocationTool(
  spongeService: SpongeService,
  messageSenderService: MessageSenderService,
): ToolBuilder {
  return (context) =>
    tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({ jobId }) => {
        const resolvedJobId = jobId ?? context.currentFocusJob?.jobId ?? null;
        if (!resolvedJobId) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.STORE_LOCATION_MISSING_JOB_ID,
            outcome: '缺少 jobId',
            replyInstruction:
              '没有明确的目标岗位 jobId。先从 [当前焦点岗位] 或会话上下文确认候选人具体在聊哪家门店；' +
              '不确定时先口头问"是指 xx 店那家吗"，确认后再调用本工具。',
          });
        }

        if (!context.token || !context.botImId || !(context.imContactId || context.imRoomId)) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.STORE_LOCATION_MISSING_DELIVERY_CONTEXT,
            outcome: '缺少发送上下文',
            replyInstruction:
              '当前会话缺少发送定位所需的上下文（token / imBotId / imContactId / imRoomId）。' +
              '这是结构性问题，本轮不要重试；按招募者口吻把门店地址用文字告诉候选人。',
          });
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
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.STORE_LOCATION_JOB_NOT_FOUND,
              outcome: '未找到岗位',
              replyInstruction:
                '当前 jobId 对应的岗位查不到。先用 duliday_job_list 重新核对岗位状态；' +
                '不要透露 jobId 或接口细节给候选人。',
              details: { jobId: resolvedJobId },
            });
          }

          const store = extractStoreLocation(matchedJob);
          if (
            !store.storeName ||
            !store.storeAddress ||
            store.latitude == null ||
            store.longitude == null
          ) {
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.STORE_LOCATION_UNAVAILABLE,
              outcome: '岗位门店定位信息不全',
              replyInstruction:
                '当前岗位缺少完整门店定位（地址或经纬度）。把已知的门店名+地址用文字告诉候选人；' +
                '不要谎称"位置已发"，也不要透露字段缺失这种内部细节。',
              details: {
                jobId: resolvedJobId,
                storeName: store.storeName,
                storeAddress: store.storeAddress,
              },
            });
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

          const floorHint = extractFloorHint(store.storeAddress);
          const fixedReply = floorHint
            ? `门店位置我发你了，你点开就能看导航。门店在 ${floorHint}，别走错。`
            : '门店位置我发你了，你点开就能看导航。';

          return {
            success: true,
            jobId: resolvedJobId,
            storeName: store.storeName,
            storeAddress: store.storeAddress,
            latitude: store.latitude,
            longitude: store.longitude,
            floorHint,
            _fixedReply: fixedReply,
            _replyRule:
              '当工具返回 _fixedReply 时，必须原样输出 _fixedReply 的内容作为本轮完整回复',
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`门店定位发送失败: jobId=${resolvedJobId}, error=${message}`);
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.STORE_LOCATION_SEND_FAILED,
            outcome: '门店定位发送失败',
            replyInstruction:
              '门店定位发送失败。不要把异常信息原文转述给候选人；用招募者口吻把门店地址直接用文字告诉候选人。',
            details: { jobId: resolvedJobId, reason: message },
          });
        }
      },
    });
}
