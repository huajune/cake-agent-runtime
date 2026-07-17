import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { MessageSenderService } from '@channels/wecom/message-sender/message-sender.service';
import { SendMessageType } from '@channels/wecom/message-sender/dto/send-message.dto';
import { GeocodingService } from '@infra/geocoding/geocoding.service';
import type { GeocodeCandidate } from '@infra/geocoding/geocoding.types';
import { SpongeService } from '@sponge/sponge.service';
import type { JobDetail } from '@sponge/sponge.types';
import { ToolBuilder } from '@shared-types/tool.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import { buildSpongeTokenContext } from '@tools/utils/sponge-token-context.util';
import { buildJobPolicyAnalysis, isOfflineInterviewMethod } from '@tools/utils/job-policy-parser';

const logger = new Logger('send_store_location');

const DESCRIPTION = `向候选人发送面试地点或工作门店的企微位置消息（不是文本回复）。

## 使用场景
- 已经明确具体岗位或门店后，候选人追问"地址在哪"、"发个定位"、"怎么过去"、"导航怎么走"时优先调用
- 已有进行中的面试预约时，上述问法默认是在问面试地点，不是工作门店

## 参数规则
- jobId 可选：
  - 当前焦点岗位已经唯一明确时，可省略，让工具自动复用当前焦点岗位
  - 若最近同时聊了多个岗位或门店，必须传入明确的 jobId；不明确时先向候选人问清楚是哪家店
- destination 默认 auto：进行中预约优先面试地点；明确问上班地址时传 store；明确问面试地址时传 interview

## 执行效果
- 工具直接向当前企微会话发送位置消息（不是普通文本回复）
- 成功后通常只需要再补一句简短确认

## 硬规则
- 不要凭记忆手写坐标或自己拼定位 payload；只通过此工具发送
- 如果工具返回 _fixedReply，必须原样输出，不要额外再重写一遍地址说明
- 若面试地址与工作门店不同，_fixedReply 会明确说明两个地址，必须原样输出
- 若工具返回失败且同时带回 interviewAddress/storeAddress，按 _fixedReply 或 _replyInstruction 告知正确目的地
- 工具返回 floorHint 不为空时，_fixedReply 已包含楼层/铺号提示，直接原样发送即可，不要再重复编造楼层信息

## 空头承诺禁忌
- 本轮回复中只要出现"门店定位我发你 / 发你个定位 / 把定位发你 / 我发个位置过去"等表述，**必须**本轮实调本工具
- 已说要发定位但没调本工具 = 空头承诺，候选人下轮没收到定位会困惑或流失
- 工具调用失败时只能用工具返回的正确目的地地址兜底；进行中预约禁止拿 storeAddress 代替 interviewAddress`;

const inputSchema = z.object({
  jobId: z.number().int().optional().describe('目标岗位 jobId。若当前焦点岗位已唯一明确，可省略'),
  destination: z
    .enum(['auto', 'interview', 'store'])
    .optional()
    .describe('目的地类型；默认 auto，进行中预约优先面试地点'),
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

type LocationDestination = 'interview' | 'store';
type InterviewLocationSource = 'same_as_workplace' | 'custom';

const SAME_AS_WORKPLACE_ADDRESS_VALUES = new Set([
  '同工作地址',
  '同工作地点',
  '同门店地址',
  '同门店地点',
  '与工作地址相同',
  '与工作地点相同',
  '与门店地址相同',
]);

function normalizeAddressForComparison(value: string | null): string {
  return (value ?? '').replace(/[\s，。！？、；：,.!?;:（）()\-]/g, '').toLowerCase();
}

function addressesDiffer(first: string | null, second: string | null): boolean {
  const a = normalizeAddressForComparison(first);
  const b = normalizeAddressForComparison(second);
  if (!a || !b) return false;
  return !a.includes(b) && !b.includes(a);
}

function resolveInterviewLocationSource(
  interviewAddress: string,
  storeAddress: string | null,
): InterviewLocationSource {
  const normalizedInterviewAddress = normalizeAddressForComparison(interviewAddress);
  if (SAME_AS_WORKPLACE_ADDRESS_VALUES.has(normalizedInterviewAddress)) {
    return 'same_as_workplace';
  }
  return addressesDiffer(interviewAddress, storeAddress) ? 'custom' : 'same_as_workplace';
}

function resolveDestination(input: {
  requested: 'auto' | 'interview' | 'store' | undefined;
  isActiveBooking: boolean;
  interviewAddress: string | null;
  offlineInterview: boolean;
  currentUserMessage?: string;
}): LocationDestination {
  const explicitlyAsksForWorkplace = /上班|工作(?:地点|地址)|入职后|工作门店/u.test(
    input.currentUserMessage ?? '',
  );
  const ambiguousJourneyQuestion = /地址|位置|定位|导航|怎么走|找不到|搞错|过去|到店/u.test(
    input.currentUserMessage ?? '',
  );

  if (explicitlyAsksForWorkplace) return 'store';
  if (input.requested === 'interview' && input.offlineInterview) return 'interview';
  if (input.requested === 'store' && !input.isActiveBooking) return 'store';
  if (input.requested === 'store' && !ambiguousJourneyQuestion) return 'store';
  if (input.isActiveBooking && input.interviewAddress && input.offlineInterview) return 'interview';
  return 'store';
}

function geocodeQueryForInterviewAddress(address: string): string {
  return address
    .replace(/^新店开业前在/u, '')
    .replace(/(?:进行)?面试\s*$/u, '')
    .trim();
}

function interviewAddressAnchors(query: string): string[] {
  const bracketAnchors = Array.from(
    query.matchAll(/[（(]([^（）()]{2,})[）)]/gu),
    (match) => match[1],
  );
  return [...bracketAnchors, query]
    .map(normalizeAddressForComparison)
    .filter((value, index, values) => value.length >= 4 && values.indexOf(value) === index);
}

function candidateMatchesInterviewAddress(candidate: GeocodeCandidate, anchors: string[]): boolean {
  const candidateText = normalizeAddressForComparison(
    `${candidate.poiName}${candidate.formattedAddress}`,
  );
  const poiName = normalizeAddressForComparison(candidate.poiName);
  return anchors.some(
    (anchor) =>
      candidateText.includes(anchor) ||
      anchor.includes(candidateText) ||
      (poiName.length >= 4 && anchor.includes(poiName)),
  );
}

function selectInterviewLocationCandidate(
  query: string,
  candidates: GeocodeCandidate[],
): GeocodeCandidate | null {
  const reliableCandidates = candidates.filter(
    (candidate) => candidate.confidence === 'high' && candidate.precision !== 'road',
  );
  if (reliableCandidates.length === 1) return reliableCandidates[0];

  const anchors = interviewAddressAnchors(query);
  const matched = reliableCandidates.filter((candidate) =>
    candidateMatchesInterviewAddress(candidate, anchors),
  );
  return matched.length === 1 ? matched[0] : null;
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
  geocodingService?: GeocodingService,
): ToolBuilder {
  return (context) =>
    tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({ jobId, destination }) => {
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
          const { jobs } = await spongeService.fetchJobs(
            {
              jobIdList: [resolvedJobId],
              pageNum: 1,
              pageSize: 1,
              options: {
                includeBasicInfo: true,
                includeInterviewProcess: true,
              },
            },
            buildSpongeTokenContext(context),
          );

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
          const policy = buildJobPolicyAnalysis(matchedJob);
          const interviewAddress = policy.interviewMeta.address;
          const interviewMethod = policy.interviewMeta.method;
          const offlineInterview = isOfflineInterviewMethod(interviewMethod);
          const isActiveBooking = context.activeBookingJobIds?.includes(resolvedJobId) ?? false;
          const explicitlyAsksForWorkplace = /上班|工作(?:地点|地址)|入职后|工作门店/u.test(
            context.currentUserMessage ?? '',
          );
          const ambiguousJourneyQuestion = /地址|位置|定位|导航|怎么走|找不到|搞错|过去|到店/u.test(
            context.currentUserMessage ?? '',
          );
          const wantsInterviewDestination =
            destination === 'interview' ||
            (isActiveBooking &&
              !explicitlyAsksForWorkplace &&
              (destination !== 'store' || ambiguousJourneyQuestion));

          if (wantsInterviewDestination && !offlineInterview) {
            if (interviewMethod) {
              const fixedReply = `这个岗位的面试形式是${interviewMethod}，不需要到门店参加面试，请按面试通知里的方式参加。`;
              return {
                success: true,
                jobId: resolvedJobId,
                destination: 'interview' as const,
                interviewMethod,
                interviewAddress: null,
                locationNotRequired: true,
                _fixedReply: fixedReply,
                _replyRule: '当工具返回 _fixedReply 时必须原样输出',
              };
            }
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.STORE_LOCATION_UNAVAILABLE,
              outcome: '面试形式未明确',
              replyInstruction:
                '岗位没有可核验的面试形式。禁止根据 interviewAddress 猜测为线下面试，也禁止发送任何定位；请调用 request_handoff(cannot_find_store) 确认面试形式。',
              details: {
                jobId: resolvedJobId,
                destination: 'interview',
                interviewMethod: null,
                interviewAddress: null,
              },
            });
          }
          const resolvedDestination = resolveDestination({
            requested: destination,
            isActiveBooking,
            interviewAddress,
            offlineInterview,
            currentUserMessage: context.currentUserMessage,
          });
          const interviewLocationSource = interviewAddress
            ? resolveInterviewLocationSource(interviewAddress, store.storeAddress)
            : null;
          const addressConflict = interviewLocationSource === 'custom';

          if (resolvedDestination === 'interview' && !interviewAddress) {
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.STORE_LOCATION_UNAVAILABLE,
              outcome: '岗位未配置面试地址',
              replyInstruction:
                '当前是进行中的面试预约，但岗位未配置可核验的面试地址。不要改发工作门店定位；请调用 request_handoff(cannot_find_store) 让招募经理确认。',
              details: {
                jobId: resolvedJobId,
                destination: resolvedDestination,
                interviewMethod,
                storeAddress: store.storeAddress,
              },
            });
          }

          if (
            !store.storeName ||
            !store.storeAddress ||
            ((resolvedDestination === 'store' || interviewLocationSource === 'same_as_workplace') &&
              (store.latitude == null || store.longitude == null))
          ) {
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.STORE_LOCATION_UNAVAILABLE,
              outcome: '岗位门店定位信息不全',
              replyInstruction:
                '当前岗位缺少完整门店定位（地址或经纬度）。把已知的门店名+地址用文字告诉候选人；' +
                '不要谎称"位置已发"，也不要透露字段缺失这种内部细节。',
              details: {
                jobId: resolvedJobId,
                destination: resolvedDestination,
                interviewMethod,
                storeName: store.storeName,
                storeAddress: store.storeAddress,
                interviewAddress,
              },
            });
          }

          let targetName = store.storeName;
          let targetAddress = store.storeAddress;
          let targetLatitude = store.latitude;
          let targetLongitude = store.longitude;

          if (resolvedDestination === 'interview' && interviewAddress) {
            if (interviewLocationSource === 'same_as_workplace') {
              targetAddress = store.storeAddress;
            } else {
              const storeInfo = matchedJob.basicInfo?.storeInfo as
                | Record<string, unknown>
                | undefined;
              const city = pickString(storeInfo?.storeCityName);
              let geocoded: GeocodeCandidate | null = null;
              if (geocodingService) {
                try {
                  const query = geocodeQueryForInterviewAddress(interviewAddress);
                  const candidates = await geocodingService.searchCandidates(
                    query,
                    city ?? undefined,
                    5,
                  );
                  geocoded = selectInterviewLocationCandidate(query, candidates);
                } catch (error) {
                  logger.warn(
                    `面试地址地理编码失败: jobId=${resolvedJobId}, error=${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                }
              }
              if (!geocoded) {
                const fixedReply = `面试地点和工作门店不是同一个地方：工作门店是 ${store.storeName}，这次面试请去 ${interviewAddress}。暂时无法发出可靠的面试定位，我再请同事帮你确认。`;
                await messageSenderService.sendMessage({
                  token: context.token,
                  imBotId: context.botImId,
                  imContactId: context.imContactId,
                  imRoomId: context.imRoomId,
                  chatId: context.chatId ?? context.sessionId,
                  messageType: SendMessageType.TEXT,
                  payload: { text: fixedReply },
                  _apiType: context.apiType,
                });
                return buildToolError({
                  errorType: TOOL_ERROR_TYPES.STORE_LOCATION_INTERVIEW_GEOCODE_FAILED,
                  outcome: '面试地址无法解析为可靠坐标',
                  replyInstruction:
                    '正确的面试地址已作为文字消息发给候选人。立即调用 request_handoff(cannot_find_store)；不要再输出文本，禁止改发工作门店定位。',
                  details: {
                    jobId: resolvedJobId,
                    destination: resolvedDestination,
                    storeName: store.storeName,
                    storeAddress: store.storeAddress,
                    interviewAddress,
                    addressConflict,
                    fallbackTextSent: true,
                  },
                });
              }
              targetName = `面试地点·${geocoded.poiName || geocoded.formattedAddress}`;
              targetAddress = interviewAddress;
              targetLatitude = geocoded.latitude;
              targetLongitude = geocoded.longitude;
            }
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
              address: targetAddress,
              latitude: targetLatitude,
              longitude: targetLongitude,
              name: targetName,
            },
            _apiType: context.apiType,
          });

          logger.log(
            `门店定位发送成功: jobId=${resolvedJobId}, store=${store.storeName}, session=${context.sessionId}`,
          );

          const floorHint = extractFloorHint(targetAddress);
          const fixedReply =
            resolvedDestination === 'interview'
              ? addressConflict
                ? `面试地点和工作门店不是同一个地方：工作门店是 ${store.storeName}，这次面试请去 ${interviewAddress}。面试定位我发你了，请按这个导航，不要按工作门店地址前往面试。`
                : `面试定位我发你了，你点开就能看导航。${floorHint ? `面试地点在 ${floorHint}。` : ''}`
              : floorHint
                ? `门店位置我发你了，你点开就能看导航。门店在 ${floorHint}，别走错。`
                : '门店位置我发你了，你点开就能看导航。';

          return {
            success: true,
            jobId: resolvedJobId,
            destination: resolvedDestination,
            interviewMethod,
            storeName: store.storeName,
            storeAddress: store.storeAddress,
            interviewAddress,
            interviewLocationSource,
            addressConflict,
            sentAddress: targetAddress,
            latitude: targetLatitude,
            longitude: targetLongitude,
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
              (context.activeBookingJobIds?.includes(resolvedJobId) ?? false)
                ? '预约场景下定位发送失败。禁止改发工作门店定位或说“地址没错”；请调用 request_handoff(cannot_find_store) 确认面试地点。'
                : '门店定位发送失败。不要把异常信息原文转述给候选人；重新核对岗位的工作门店地址后用文字告知。',
            details: { jobId: resolvedJobId, reason: message },
          });
        }
      },
    });
}
