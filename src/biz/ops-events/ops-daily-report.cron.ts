import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  FeishuBitableApiService,
  type BitableField,
} from '@infra/feishu/services/bitable-api.service';
import {
  addLocalDays,
  formatLocalDate,
  getLocalDayStart,
  parseLocalDateStart,
} from '@infra/utils/date.util';
import { DailyOpsReportRepository } from './daily-ops-report.repository';
import type { DailyOpsReportRow } from './ops-events.types';

/** 飞书多维表格字段类型枚举（仅用到的）。 */
const FEISHU_FIELD_TYPE = { TEXT: 1, NUMBER: 2, DATETIME: 5 } as const;

type ReportColumnKind = 'date' | 'number' | 'text';

interface ReportColumn {
  /** 飞书多维表格里的列名（**按实际表头核对/调整**；不匹配的列自动跳过并告警）。 */
  fieldName: string;
  kind: ReportColumnKind;
  value: (row: DailyOpsReportRow) => string | number | null;
}

/**
 * daily_ops_report → 飞书「运营日报」列映射（超集）。
 *
 * 运行时按 fieldName 与表里真实字段名精确匹配，只写匹配上的列；未匹配的列跳过并告警。
 * 字段名是按设计/常识猜测的，**首次启用前请用日志里打印的真实字段名核对**。
 */
const REPORT_COLUMNS: ReportColumn[] = [
  { fieldName: '日期', kind: 'date', value: (r) => r.report_date },
  { fieldName: '招聘经理', kind: 'text', value: (r) => r.manager_name },
  // 「账号」有意与「招聘经理」同取 manager_name：本系统每个托管账号即以招聘经理命名（wecomUserId 可读名）。
  // 不取 r.bot_im_id —— 那是数字 wxid，飞书表给人看时不可读。
  { fieldName: '账号', kind: 'text', value: (r) => r.manager_name },
  { fieldName: '小组', kind: 'text', value: (r) => r.group_name },
  { fieldName: '加好友数', kind: 'number', value: (r) => r.friends_added_count },
  { fieldName: '开口数', kind: 'number', value: (r) => r.agent_opening_sent_count },
  { fieldName: '破冰数', kind: 'number', value: (r) => r.break_ice_count },
  { fieldName: '推荐岗位数', kind: 'number', value: (r) => r.job_recommend_count },
  { fieldName: '报名成功数', kind: 'number', value: (r) => r.booking_success_count },
  { fieldName: '报名失败数', kind: 'number', value: (r) => r.booking_fail_count },
  { fieldName: '进群数', kind: 'number', value: (r) => r.group_invite_count },
  { fieldName: '转人工数', kind: 'number', value: (r) => r.handoff_count },
  { fieldName: '面试通过数', kind: 'number', value: (r) => r.interview_pass_count },
  { fieldName: '报名明细', kind: 'text', value: (r) => r.candidate_summary },
  { fieldName: '报名品牌', kind: 'text', value: (r) => (r.booking_brands ?? []).join('、') },
];

/**
 * 运营日报飞书 cron（每天 09:00 Asia/Shanghai，推 T-1 数据）。
 *
 * 流程：读 daily_ops_report(T-1) → 按真实表头字段名映射 → 批量写入飞书多维表格。
 *
 * 安全约定：
 * - **默认 dry-run**（FEISHU_OPS_REPORT_ENABLED ≠ 'true'）：只聚合 + 打印将写入的记录与
 *   表里真实字段名，不真正写入，避免把猜测的列名当真往运营在看的表里塞错数据。
 * - 启用前先看 dry-run 日志里的真实字段名，核对/修正 REPORT_COLUMNS，再置 ENABLED=true。
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
  ) {
    // 默认值来自 wiki 节点解析出的「运营日报」bitable（obj_token）+ URL 里的 table。
    this.appToken = this.configService
      .get<string>('FEISHU_OPS_REPORT_APP_TOKEN', 'TM0hb4fmtaa5jusAnlnc32Nfnpg')
      .trim();
    this.tableId = this.configService
      .get<string>('FEISHU_OPS_REPORT_TABLE_ID', 'tblusTgxaBKp9BA7')
      .trim();
    this.enabled = this.configService.get<string>('FEISHU_OPS_REPORT_ENABLED', 'false') === 'true';
  }

  @Cron('0 9 * * *', { timeZone: 'Asia/Shanghai' })
  async run(): Promise<void> {
    if (this.running) {
      this.logger.warn('上一轮运营日报推送尚未结束，跳过本次');
      return;
    }
    this.running = true;
    try {
      const reportDate = formatLocalDate(addLocalDays(getLocalDayStart(), -1));
      await this.pushReport(reportDate);
    } catch (error) {
      this.logger.error('运营日报推送失败', error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
  }

  /** 推送指定日期日报（独立方法便于测试 / 手动触发）。 */
  async pushReport(reportDate: string): Promise<{ rows: number; written: number }> {
    const rows = await this.dailyOpsReportRepository.findByReportDate(reportDate);
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

    const records = rows.map((row) => ({
      fields: this.buildFields(row, usableColumns, fieldTypeByName),
    }));
    const result = await this.bitableApi.batchCreateRecords(this.appToken, this.tableId, records);
    this.logger.log(
      `运营日报推送完成: ${reportDate} 行=${rows.length} 写入成功=${result.created} 失败=${result.failed}`,
    );
    return { rows: rows.length, written: result.created };
  }

  /** dry-run 样例用：按列名 → 原始值（不做飞书类型转换）。 */
  private buildFieldsByName(row: DailyOpsReportRow): Record<string, string | number | null> {
    const out: Record<string, string | number | null> = {};
    for (const col of REPORT_COLUMNS) out[col.fieldName] = col.value(row);
    return out;
  }

  /** 真实写入用：按飞书字段类型转换值（date→epoch ms / number / text）。 */
  private buildFields(
    row: DailyOpsReportRow,
    columns: ReportColumn[],
    fieldTypeByName: Map<string, number>,
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const col of columns) {
      const raw = col.value(row);
      if (raw === null || raw === '') continue;
      const fieldType = fieldTypeByName.get(col.fieldName);
      if (col.kind === 'date') {
        fields[col.fieldName] =
          fieldType === FEISHU_FIELD_TYPE.DATETIME
            ? parseLocalDateStart(String(raw)).getTime()
            : String(raw);
      } else if (col.kind === 'number') {
        fields[col.fieldName] = fieldType === FEISHU_FIELD_TYPE.TEXT ? String(raw) : Number(raw);
      } else {
        fields[col.fieldName] = String(raw);
      }
    }
    return fields;
  }
}
