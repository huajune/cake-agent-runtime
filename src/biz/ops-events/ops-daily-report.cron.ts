import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { BotService, type BotAccount } from '@channels/wecom/bot/bot.service';
import {
  FeishuBitableApiService,
  type BitableField,
} from '@infra/feishu/services/bitable-api.service';
import { formatLocalDate, getLocalDayStart, parseLocalDateStart } from '@infra/utils/date.util';
import { SpongeService } from '@sponge/sponge.service';
import type { SignupWorkOrderItem, SignupWorkOrdersResult } from '@sponge/sponge.types';
import { DailyOpsReportRepository } from './daily-ops-report.repository';
import { normalizeBotImId } from './bot-group-resolver.service';
import type { DailyOpsReportRow } from './ops-events.types';

/** 飞书多维表格字段类型枚举（仅用到的）。 */
const FEISHU_FIELD_TYPE = {
  TEXT: 1,
  NUMBER: 2,
  SINGLE_SELECT: 3,
  MULTI_SELECT: 4,
  DATETIME: 5,
  FORMULA: 20,
  AUTO_NUMBER: 1005,
} as const;

const READONLY_FEISHU_FIELD_TYPES = new Set<number>([
  FEISHU_FIELD_TYPE.FORMULA,
  FEISHU_FIELD_TYPE.AUTO_NUMBER,
]);

type ReportColumnKind = 'date' | 'number' | 'text';
type OpsDailyReportOutputRow = Omit<
  DailyOpsReportRow,
  'booking_success_count' | 'interview_pass_count' | 'candidate_summary' | 'booking_brands'
> & {
  booking_success_count: number | null;
  interview_pass_count: number | null;
  candidate_summary: string | null;
  booking_brands: string[] | null;
};

const OPS_REPORT_NUMERIC_COLUMNS = [
  'friends_added_count',
  'agent_opening_sent_count',
  'break_ice_count',
  'candidate_message_count',
  'agent_reply_count',
  'job_recommend_count',
  'precheck_pass_count',
  'booking_success_count',
  'booking_fail_count',
  'group_invite_count',
  'handoff_count',
  'interview_pass_count',
] as const satisfies readonly (keyof DailyOpsReportRow)[];

interface ReportColumn {
  /** 飞书多维表格里的列名（**按实际表头核对/调整**；不匹配的列自动跳过并告警）。 */
  fieldName: string;
  kind: ReportColumnKind;
  value: (row: OpsDailyReportOutputRow) => string | number | null;
}

/**
 * daily_ops_report → 飞书「运营日报」列映射（超集）。
 *
 * 运行时按 fieldName 与表里真实字段名精确匹配，只写匹配上的列；未匹配的列跳过并告警。
 * 字段名是按设计/常识猜测的，**首次启用前请用日志里打印的真实字段名核对**。
 */
const REPORT_COLUMNS: ReportColumn[] = [
  { fieldName: '日期', kind: 'date', value: (r) => r.report_date },
  { fieldName: '报名日期', kind: 'date', value: (r) => r.report_date },
  { fieldName: '星期', kind: 'text', value: (r) => formatWeekday(r.report_date) },
  { fieldName: '招聘经理', kind: 'text', value: (r) => r.manager_name },
  // 「账号」「招募经理」均有意与「招聘经理」同取 manager_name：本系统每个托管账号即以招募经理命名
  // （bot 的 name/nickName，看板下拉斜杠左边的显示名）。不取 r.bot_im_id —— 那是数字 wxid，给人看不可读。
  { fieldName: '账号', kind: 'text', value: (r) => r.manager_name },
  { fieldName: '招募经理', kind: 'text', value: (r) => r.manager_name },
  { fieldName: '小组', kind: 'text', value: (r) => r.group_name },
  { fieldName: '添加好友数', kind: 'number', value: (r) => r.friends_added_count },
  { fieldName: '加好友数', kind: 'number', value: (r) => r.friends_added_count },
  { fieldName: '主动回复数', kind: 'number', value: (r) => r.break_ice_count },
  { fieldName: '开口数', kind: 'number', value: (r) => r.agent_opening_sent_count },
  { fieldName: '破冰数', kind: 'number', value: (r) => r.break_ice_count },
  { fieldName: '推荐岗位数', kind: 'number', value: (r) => r.job_recommend_count },
  { fieldName: '成功报名数', kind: 'number', value: (r) => r.booking_success_count },
  { fieldName: '报名成功数', kind: 'number', value: (r) => r.booking_success_count },
  { fieldName: '报名失败数', kind: 'number', value: (r) => r.booking_fail_count },
  { fieldName: '邀请进群数', kind: 'number', value: (r) => r.group_invite_count },
  { fieldName: '进群数', kind: 'number', value: (r) => r.group_invite_count },
  { fieldName: '转人工数', kind: 'number', value: (r) => r.handoff_count },
  { fieldName: '通过数', kind: 'number', value: (r) => r.interview_pass_count },
  { fieldName: '面试通过数', kind: 'number', value: (r) => r.interview_pass_count },
  { fieldName: '候选人基本信息', kind: 'text', value: (r) => r.candidate_summary },
  { fieldName: '报名明细', kind: 'text', value: (r) => r.candidate_summary },
  {
    fieldName: '报名品牌（品牌名称简写）',
    kind: 'text',
    value: (r) => (r.booking_brands ?? []).join('、'),
  },
  { fieldName: '报名品牌', kind: 'text', value: (r) => (r.booking_brands ?? []).join('、') },
];

/** 返回 report_date 对应的星期几（0=周日 … 6=周六）；非法日期返回 null。 */
function getWeekdayIndex(reportDate: string): number | null {
  const match = reportDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCDay();
}

function formatWeekday(reportDate: string): string | null {
  const index = getWeekdayIndex(reportDate);
  if (index === null) return null;
  const labels = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  return labels[index] ?? null;
}

/** 周末（周六/周日）不出运营日报。 */
function isWeekend(reportDate: string): boolean {
  const index = getWeekdayIndex(reportDate);
  return index === 0 || index === 6;
}

/**
 * 运营日报飞书 cron（每天 21:00 Asia/Shanghai，推当天数据）。
 *
 * 流程：读 daily_ops_report(当天) → 用海绵 self/list 按账号 token 覆盖报名/通过与候选人信息
 * → 按真实表头字段名映射 → 批量写入飞书多维表格。
 *
 * 安全约定：
 * - 可用 FEISHU_OPS_REPORT_ENABLED=false 显式 dry-run：只聚合 + 打印将写入的记录，不写飞书。
 */
@Injectable()
export class OpsDailyReportCronService {
  private readonly logger = new Logger(OpsDailyReportCronService.name);
  private readonly appToken: string;
  private readonly tableId: string;
  private readonly enabled: boolean;
  private running = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly dailyOpsReportRepository: DailyOpsReportRepository,
    private readonly bitableApi: FeishuBitableApiService,
    private readonly spongeService: SpongeService,
    private readonly botService: BotService,
  ) {
    // 默认值来自 wiki 节点解析出的「运营日报」bitable（obj_token）+ URL 里的 table。
    this.appToken = this.configService
      .get<string>('FEISHU_OPS_REPORT_APP_TOKEN', 'TM0hb4fmtaa5jusAnlnc32Nfnpg')
      .trim();
    this.tableId = this.configService
      .get<string>('FEISHU_OPS_REPORT_TABLE_ID', 'tblusTgxaBKp9BA7')
      .trim();
    this.enabled = this.configService.get<string>('FEISHU_OPS_REPORT_ENABLED', 'true') === 'true';
  }

  @Cron('0 21 * * *', { timeZone: 'Asia/Shanghai' })
  async run(): Promise<void> {
    if (this.running) {
      this.logger.warn('上一轮运营日报推送尚未结束，跳过本次');
      return;
    }
    this.running = true;
    try {
      const reportDate = formatLocalDate(getLocalDayStart());
      await this.pushReport(reportDate);
    } catch (error) {
      this.logger.error('运营日报推送失败', error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
  }

  /** 推送指定日期日报（独立方法便于测试 / 手动触发）。 */
  async pushReport(reportDate: string): Promise<{ rows: number; written: number }> {
    if (isWeekend(reportDate)) {
      this.logger.log(`运营日报: ${reportDate} 为周末，跳过`);
      return { rows: 0, written: 0 };
    }

    const rawRows = await this.dailyOpsReportRepository.findByReportDate(reportDate);
    const rows = await this.canonicalizeRowsByCurrentBots(rawRows);
    if (rows.length === 0) {
      this.logger.log(`运营日报: ${reportDate} 无数据，跳过`);
      return { rows: 0, written: 0 };
    }

    if (!this.enabled) {
      this.logger.warn(
        `运营日报 dry-run（FEISHU_OPS_REPORT_ENABLED≠true）: ${reportDate} 共 ${rows.length} 行，未写入飞书。` +
          ` 启用前请核对字段映射。样例: ${JSON.stringify(this.buildFieldsByName(rows[0]))}`,
      );
      return { rows: rows.length, written: 0 };
    }

    if (!this.appToken || !this.tableId) {
      this.logger.warn('运营日报: 缺少 FEISHU_OPS_REPORT_APP_TOKEN / _TABLE_ID，跳过');
      return { rows: rows.length, written: 0 };
    }

    const hydratedRows = await this.hydrateRowsFromSponge(reportDate, rows);

    let fields: BitableField[];
    try {
      fields = await this.bitableApi.getFields(this.appToken, this.tableId);
    } catch (error) {
      this.logger.error(
        `运营日报: 获取飞书表字段失败，跳过本次: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { rows: rows.length, written: 0 };
    }

    const fieldTypeByName = new Map(fields.map((f) => [f.field_name, f.type]));
    const usableColumns = REPORT_COLUMNS.filter((c) => fieldTypeByName.has(c.fieldName));
    const missing = REPORT_COLUMNS.filter((c) => !fieldTypeByName.has(c.fieldName)).map(
      (c) => c.fieldName,
    );
    this.logger.log(
      `运营日报: 飞书表真实字段=[${fields.map((f) => f.field_name).join(', ')}]; ` +
        `命中列=[${usableColumns.map((c) => c.fieldName).join(', ')}]; 未命中(跳过)=[${missing.join(', ')}]`,
    );
    if (usableColumns.length === 0) {
      this.logger.warn('运营日报: 没有任何列名与飞书表匹配，跳过写入');
      return { rows: rows.length, written: 0 };
    }

    const records = hydratedRows.map((row) => ({
      fields: this.buildFields(row, usableColumns, fieldTypeByName),
    }));
    const result = await this.bitableApi.batchCreateRecords(this.appToken, this.tableId, records);
    this.logger.log(
      `运营日报推送完成: ${reportDate} 行=${rows.length} 写入成功=${result.created} 失败=${result.failed}`,
    );
    return { rows: rows.length, written: result.created };
  }

  /**
   * daily_ops_report 里历史上可能同时存在数字 wxid、wecomUserId、prod-sync:wecomUserId
   * 三种 bot_im_id 形态。同一个当前托管 bot 在飞书日报里只能写一行，否则看起来像重复刷新。
   */
  private async canonicalizeRowsByCurrentBots(
    rows: DailyOpsReportRow[],
  ): Promise<DailyOpsReportRow[]> {
    if (rows.length === 0) return rows;

    let botByKey: Map<string, BotAccount>;
    try {
      botByKey = await this.buildCurrentBotLookup();
    } catch (error) {
      this.logger.warn(
        `运营日报: 获取当前托管 bot 列表失败，跳过 botId 合并: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return rows;
    }
    if (botByKey.size === 0) return rows;

    const merged = new Map<string, DailyOpsReportRow>();
    for (const row of rows) {
      const normalizedKey = normalizeBotImId(row.bot_im_id);
      const currentBot = botByKey.get(normalizedKey);
      const canonicalBotImId = currentBot?.wxid?.trim() || normalizedKey || row.bot_im_id;
      const mergeKey = `${row.report_date}|${canonicalBotImId}`;
      const normalizedRow: DailyOpsReportRow = {
        ...row,
        bot_im_id: canonicalBotImId,
        manager_name:
          currentBot?.name?.trim() || currentBot?.wecomUserId?.trim() || row.manager_name,
        group_name: currentBot?.groupName?.trim() || row.group_name,
      };

      const existing = merged.get(mergeKey);
      if (!existing) {
        merged.set(mergeKey, normalizedRow);
        continue;
      }

      for (const column of OPS_REPORT_NUMERIC_COLUMNS) {
        existing[column] = ((existing[column] ?? 0) + (normalizedRow[column] ?? 0)) as never;
      }
      existing.candidate_summary = this.mergeText(
        existing.candidate_summary,
        normalizedRow.candidate_summary,
      );
      existing.booking_brands = this.mergeTextList(
        existing.booking_brands,
        normalizedRow.booking_brands,
      );
    }

    if (merged.size < rows.length) {
      this.logger.log(`运营日报: botId 归一合并 ${rows.length} 行 → ${merged.size} 行`);
    }

    return Array.from(merged.values()).sort((a, b) =>
      `${a.group_name ?? ''}|${a.manager_name ?? ''}|${a.bot_im_id}`.localeCompare(
        `${b.group_name ?? ''}|${b.manager_name ?? ''}|${b.bot_im_id}`,
        'zh-Hans-CN',
        { numeric: true, sensitivity: 'base' },
      ),
    );
  }

  private async buildCurrentBotLookup(): Promise<Map<string, BotAccount>> {
    const bots = await this.botService.getConfiguredBotList();
    const map = new Map<string, BotAccount>();
    for (const bot of bots) {
      for (const rawKey of [bot.wxid, bot.wecomUserId]) {
        const key = rawKey?.trim() ? normalizeBotImId(rawKey) : '';
        if (key) map.set(key, bot);
      }
    }
    return map;
  }

  /**
   * 用海绵当前供应商工单接口覆盖日报里的报名成功数 / 通过数 / 候选人基本信息。
   *
   * 注意：self/list 的权限边界来自 Duliday-Token；这里必须按 row.bot_im_id 解析托管账号 token，
   * 不能退回全局 token，否则不同账号会写成同一供应商账号的数据。
   */
  private async hydrateRowsFromSponge(
    reportDate: string,
    rows: DailyOpsReportRow[],
  ): Promise<OpsDailyReportOutputRow[]> {
    const startTime = `${reportDate} 00:00:00`;
    const endTime = `${reportDate} 23:59:59`;

    return Promise.all(
      rows.map(async (row) => {
        try {
          const [signupResult, passResult] = await Promise.all([
            this.spongeService.fetchSelfSignupWorkOrders(
              {
                queryParam: {
                  signUpStartTime: startTime,
                  signUpEndTime: endTime,
                },
              },
              { botImId: row.bot_im_id },
            ),
            this.spongeService.fetchSelfSignupWorkOrders(
              {
                queryParam: {
                  interviewPassStartTime: startTime,
                  interviewPassEndTime: endTime,
                },
              },
              { botImId: row.bot_im_id },
            ),
          ]);

          return this.mergeSpongeMetrics(row, signupResult, passResult);
        } catch (error) {
          this.logger.warn(
            `运营日报: 海绵工单数据覆盖失败 bot=${row.bot_im_id} date=${reportDate}，海绵口径字段留空: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return this.clearSpongeFields(row);
        }
      }),
    );
  }

  private async mergeSpongeMetrics(
    row: DailyOpsReportRow,
    signupResult: SignupWorkOrdersResult,
    passResult: SignupWorkOrdersResult,
  ): Promise<OpsDailyReportOutputRow> {
    const signupOrders = this.uniqueWorkOrders(signupResult.workOrders);
    const passOrders = this.uniqueWorkOrders(passResult.workOrders);
    const candidateNames = await this.fetchCandidateNamesFromSignupDetails(row, signupOrders);
    const bookingBrands = this.uniqueText(
      signupOrders.map((order) => order.brandName).filter((value): value is string => !!value),
    );

    return {
      ...row,
      booking_success_count: Math.max(signupResult.total ?? 0, signupOrders.length),
      interview_pass_count: Math.max(passResult.total ?? 0, passOrders.length),
      candidate_summary: candidateNames.join('\n') || null,
      booking_brands: bookingBrands.length > 0 ? bookingBrands : null,
    };
  }

  private clearSpongeFields(row: DailyOpsReportRow): OpsDailyReportOutputRow {
    return {
      ...row,
      booking_success_count: null,
      interview_pass_count: null,
      candidate_summary: null,
      booking_brands: null,
    };
  }

  private uniqueWorkOrders(workOrders: SignupWorkOrderItem[]): SignupWorkOrderItem[] {
    const byKey = new Map<string, SignupWorkOrderItem>();
    for (const order of workOrders) {
      const key = Number.isFinite(order.workOrderId)
        ? String(order.workOrderId)
        : JSON.stringify([order.candidateName ?? '', order.phone ?? '', order.signUpTime ?? '']);
      if (!byKey.has(key)) byKey.set(key, order);
    }
    return Array.from(byKey.values());
  }

  private async fetchCandidateNamesFromSignupDetails(
    row: DailyOpsReportRow,
    workOrders: SignupWorkOrderItem[],
  ): Promise<string[]> {
    const names = await Promise.all(
      workOrders.map(async (order) => {
        const nameFromSelfList = this.readWorkOrderText(order, [
          'candidateName',
          'candidate_name',
          'name',
        ]);
        if (nameFromSelfList) return nameFromSelfList;
        if (!Number.isFinite(order.workOrderId)) return null;

        try {
          const detail = await this.spongeService.fetchSignupWorkOrders(
            { workOrderId: order.workOrderId },
            { botImId: row.bot_im_id },
          );
          return (
            this.cleanText(detail.candidateName) ??
            this.readWorkOrderText(detail.workOrders[0], [
              'candidateName',
              'candidate_name',
              'name',
            ])
          );
        } catch (error) {
          this.logger.warn(
            `运营日报: 海绵工单姓名查询失败 bot=${row.bot_im_id} workOrderId=${
              order.workOrderId
            }: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      }),
    );

    return this.uniqueText(names.filter((name): name is string => !!name));
  }

  private readWorkOrderText(order: SignupWorkOrderItem | undefined, keys: string[]): string | null {
    if (!order) return null;
    const record = order as unknown as Record<string, unknown>;
    for (const key of keys) {
      const value = this.cleanText(record[key]);
      if (value) return value;
    }
    return null;
  }

  private cleanText(value: unknown): string | null {
    if (value == null) return null;
    const text = String(value).trim();
    return text.length > 0 ? text : null;
  }

  private uniqueText(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      const text = value.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
    return out;
  }

  private mergeText(left: string | null, right: string | null): string | null {
    return (
      this.uniqueText([...(left?.split('\n') ?? []), ...(right?.split('\n') ?? [])]).join('\n') ||
      null
    );
  }

  private mergeTextList(left: string[] | null, right: string[] | null): string[] | null {
    const merged = this.uniqueText([...(left ?? []), ...(right ?? [])]);
    return merged.length > 0 ? merged : null;
  }

  /** dry-run 样例用：按列名 → 原始值（不做飞书类型转换）。 */
  private buildFieldsByName(row: OpsDailyReportOutputRow): Record<string, string | number | null> {
    const out: Record<string, string | number | null> = {};
    for (const col of REPORT_COLUMNS) out[col.fieldName] = col.value(row);
    return out;
  }

  /** 真实写入用：按飞书字段类型转换值（date→epoch ms / number / text / multi-select）。 */
  private buildFields(
    row: OpsDailyReportOutputRow,
    columns: ReportColumn[],
    fieldTypeByName: Map<string, number>,
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const col of columns) {
      const raw = col.value(row);
      if (raw === null || raw === '') continue;
      const fieldType = fieldTypeByName.get(col.fieldName);
      if (fieldType != null && READONLY_FEISHU_FIELD_TYPES.has(fieldType)) continue;
      if (col.kind === 'date') {
        fields[col.fieldName] =
          fieldType === FEISHU_FIELD_TYPE.DATETIME
            ? parseLocalDateStart(String(raw)).getTime()
            : String(raw);
      } else if (col.kind === 'number') {
        fields[col.fieldName] = fieldType === FEISHU_FIELD_TYPE.TEXT ? String(raw) : Number(raw);
      } else if (fieldType === FEISHU_FIELD_TYPE.MULTI_SELECT) {
        const options = this.toMultiSelectOptions(raw);
        if (options.length > 0) fields[col.fieldName] = options;
      } else {
        fields[col.fieldName] = String(raw);
      }
    }
    return fields;
  }

  private toMultiSelectOptions(value: string | number): string[] {
    return this.uniqueText(
      String(value)
        .split(/[、,\n]/)
        .map((item) => item.trim()),
    );
  }
}
