import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SupabaseService } from '@infra/supabase/supabase.service';
import type { CenterRoute } from '@infra/server/dashboard-access/center-routes';

/** 复用原页面的数据契约；所有筛选在 SQL 内与后端机器人范围取交集。 */
@Injectable()
export class CenterDashboardRepository {
  constructor(private readonly supabase: SupabaseService) {}

  async read(kind: CenterRoute, botIds: string[], input: Record<string, unknown>) {
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const scalar = (key: string) => {
      const value = input[key];
      if (value !== undefined && typeof value !== 'string')
        throw new BadRequestException(`无效参数 ${key}`);
      if (typeof value === 'string' && value.length > 500)
        throw new BadRequestException(`参数过长 ${key}`);
      return value as string | undefined;
    };
    const daysValue = scalar('days');
    const days = daysValue === undefined ? (kind === 'users' ? 1 : 30) : Number(daysValue);
    if (!Number.isInteger(days) || days < 0 || days > 366)
      throw new BadRequestException('日期范围无效');
    const end = scalar('date') || scalar('endDate') || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || !Number.isFinite(Date.parse(end)))
      throw new BadRequestException('日期格式无效');
    const start =
      scalar('date') ||
      scalar('startDate') ||
      (kind === 'business-trend' || days === 0
        ? '2026-06-01'
        : new Date(Date.parse(end) - (days - 1) * 86400000).toISOString().slice(0, 10));
    for (const value of [start, end]) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value
      )
        throw new BadRequestException('日期格式无效');
    }
    if (start > end || end > today || Date.parse(end) - Date.parse(start) > 365 * 86400000)
      throw new BadRequestException('单次日期范围不能超过一年');
    const params: Record<string, unknown> = {};
    for (const key of [
      'id',
      'chatId',
      'touchKey',
      'sessionId',
      'status',
      'scenarioCode',
      'keyword',
      'search',
      'pendingOnly',
      'cursorTimestamp',
      'cursorChatId',
      'userName',
      'afterChatId',
      'afterBotId',
    ]) {
      const value = scalar(key);
      if (value) params[key] = value;
    }
    if (params.cursorTimestamp && !Number.isFinite(Date.parse(String(params.cursorTimestamp))))
      throw new BadRequestException('游标无效');
    for (const key of ['limit', 'offset']) {
      const value = scalar(key);
      if (
        value !== undefined &&
        (!/^\d+$/.test(value) || Number(value) > (key === 'limit' ? 600 : 10000))
      )
        throw new BadRequestException('分页参数超出范围');
      if (value !== undefined) params[key] = Number(value);
    }
    const managers = input.managerName;
    if (managers !== undefined) {
      const values = Array.isArray(managers) ? managers : [managers];
      if (
        values.length > 100 ||
        values.some((value) => typeof value !== 'string' || value.length > 100)
      )
        throw new BadRequestException('招募经理筛选无效');
      params.managerNames = values;
    }
    if (Boolean(params.cursorTimestamp) !== Boolean(params.cursorChatId))
      throw new BadRequestException('游标必须完整');
    if (Boolean(params.afterChatId) !== Boolean(params.afterBotId))
      throw new BadRequestException('用户游标必须完整');
    const client = this.supabase.getSupabaseClient();
    if (!client) throw new ServiceUnavailableException('数据服务暂不可用');
    const { data, error } = await client
      .rpc('center_dashboard_read', {
        p_kind: kind,
        p_bot_ids: botIds,
        p_start: start,
        p_end: end,
        p_params: params,
      })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) throw new ServiceUnavailableException('当前范围的数据暂不可用，请稍后重试');
    return data;
  }
}
