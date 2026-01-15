import { Injectable, Logger } from '@nestjs/common';
import { FeishuApiService } from './feishu-api.service';
import { feishuBitableConfig, FeishuBitableTableConfig } from '../constants/feishu-bitable.config';

/**
 * 飞书 API 响应结构
 */
interface FeishuResponse<T = any> {
  code: number;
  msg: string;
  data?: T;
}

/**
 * 表格记录结构
 */
export interface BitableRecord {
  record_id: string;
  fields: Record<string, any>;
}

/**
 * 表格字段结构
 */
export interface BitableField {
  field_id: string;
  field_name: string;
  type: number;
  property?: {
    options?: Array<{ id: string; name: string }>;
  };
}

/**
 * 批量创建记录请求
 */
export interface BatchCreateRequest {
  fields: Record<string, any>;
}

/**
 * 飞书多维表格 API 服务
 *
 * 职责：
 * - 封装 Bitable API 的 CRUD 操作
 * - 提供表格配置获取方法
 * - 处理分页查询
 *
 * 设计原则：
 * - 依赖 FeishuApiService 进行 HTTP 请求（复用 Token 管理）
 * - 只负责 Bitable 相关的 API 封装
 */
@Injectable()
export class FeishuBitableApiService {
  private readonly logger = new Logger(FeishuBitableApiService.name);

  constructor(private readonly feishuApi: FeishuApiService) {
    this.logger.log('FeishuBitableApiService 初始化完成');
  }

  // ==================== 表格配置 ====================

  /**
   * 获取预配置的表格信息
   */
  getTableConfig(
    tableName: 'chat' | 'badcase' | 'goodcase' | 'testSuite',
  ): FeishuBitableTableConfig {
    return feishuBitableConfig.tables[tableName];
  }

  // ==================== 字段操作 ====================

  /**
   * 获取表格字段列表
   */
  async getFields(appToken: string, tableId: string): Promise<BitableField[]> {
    const response = await this.feishuApi.get<FeishuResponse<{ items: BitableField[] }>>(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
    );

    if (response.data.code !== 0) {
      throw new Error(`获取表格字段失败: ${response.data.msg}`);
    }

    return response.data.data?.items || [];
  }

  /**
   * 创建表格字段
   *
   * @param appToken 多维表格 app token
   * @param tableId 表格 ID
   * @param fieldName 字段名称
   * @param fieldType 字段类型：1-文本, 2-数字, 3-单选, 4-多选, 5-日期, 7-复选框, 11-人员, 13-电话, 15-超链接, 17-附件, 18-关联, 20-公式, 21-双向关联, 22-地理位置, 23-群组, 1001-创建时间, 1002-修改时间, 1003-创建人, 1004-修改人
   * @param options 单选/多选的选项列表
   */
  async createField(
    appToken: string,
    tableId: string,
    fieldName: string,
    fieldType: number,
    options?: string[],
  ): Promise<{ fieldId: string }> {
    const body: Record<string, unknown> = {
      field_name: fieldName,
      type: fieldType,
    };

    // 如果是单选(3)或多选(4)，需要添加选项
    if ((fieldType === 3 || fieldType === 4) && options && options.length > 0) {
      body.property = {
        options: options.map((name) => ({ name })),
      };
    }

    const response = await this.feishuApi.post<
      FeishuResponse<{ field: { field_id: string; field_name: string } }>
    >(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, body);

    if (response.data.code !== 0) {
      throw new Error(`创建字段失败: ${response.data.msg}`);
    }

    this.logger.log(`成功创建字段: ${fieldName} (${response.data.data!.field.field_id})`);
    return { fieldId: response.data.data!.field.field_id };
  }

  /**
   * 检查字段是否存在
   */
  async fieldExists(appToken: string, tableId: string, fieldName: string): Promise<boolean> {
    const fields = await this.getFields(appToken, tableId);
    return fields.some((f) => f.field_name === fieldName);
  }

  /**
   * 构建字段名到字段 ID 的映射
   */
  buildFieldNameToIdMap(fields: BitableField[]): Record<string, string> {
    const map: Record<string, string> = {};
    for (const field of fields) {
      map[field.field_name] = field.field_id;
    }
    return map;
  }

  // ==================== 记录查询 ====================

  /**
   * 获取单条记录
   */
  async getRecord(appToken: string, tableId: string, recordId: string): Promise<BitableRecord> {
    const response = await this.feishuApi.get<FeishuResponse<{ record: BitableRecord }>>(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    );

    if (response.data.code !== 0) {
      throw new Error(`获取记录失败: ${response.data.msg}`);
    }

    return response.data.data!.record;
  }

  /**
   * 获取表格所有记录（自动分页）
   */
  async getAllRecords(appToken: string, tableId: string): Promise<BitableRecord[]> {
    const allRecords: BitableRecord[] = [];
    let pageToken: string | undefined;

    do {
      const params: Record<string, any> = { page_size: 100 };
      if (pageToken) {
        params.page_token = pageToken;
      }

      const response = await this.feishuApi.get<
        FeishuResponse<{ items: BitableRecord[]; page_token?: string }>
      >(`/bitable/v1/apps/${appToken}/tables/${tableId}/records`, { params });

      if (response.data.code !== 0) {
        throw new Error(`获取表格记录失败: ${response.data.msg}`);
      }

      const items = response.data.data?.items || [];
      allRecords.push(...items);
      pageToken = response.data.data?.page_token;
    } while (pageToken);

    this.logger.debug(`从表格 ${tableId} 获取 ${allRecords.length} 条记录`);
    return allRecords;
  }

  /**
   * 按条件查询记录
   */
  async queryRecords(
    appToken: string,
    tableId: string,
    filter?: string,
    pageSize = 100,
  ): Promise<BitableRecord[]> {
    const params: Record<string, any> = { page_size: pageSize };
    if (filter) {
      params.filter = filter;
    }

    const response = await this.feishuApi.get<FeishuResponse<{ items: BitableRecord[] }>>(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      { params },
    );

    if (response.data.code !== 0) {
      throw new Error(`查询记录失败: ${response.data.msg}`);
    }

    return response.data.data?.items || [];
  }

  // ==================== 记录创建 ====================

  /**
   * 创建单条记录
   */
  async createRecord(
    appToken: string,
    tableId: string,
    fields: Record<string, any>,
  ): Promise<{ recordId: string }> {
    const response = await this.feishuApi.post<FeishuResponse<{ record: { record_id: string } }>>(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      { fields },
    );

    if (response.data.code !== 0) {
      throw new Error(`创建记录失败: ${response.data.msg}`);
    }

    return { recordId: response.data.data!.record.record_id };
  }

  /**
   * 批量创建记录
   */
  async batchCreateRecords(
    appToken: string,
    tableId: string,
    records: BatchCreateRequest[],
    batchSize = 200,
  ): Promise<{ created: number; failed: number }> {
    let created = 0;
    let failed = 0;

    for (let i = 0; i < records.length; i += batchSize) {
      const chunk = records.slice(i, i + batchSize);

      try {
        const response = await this.feishuApi.post<FeishuResponse>(
          `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
          { records: chunk },
        );

        if (response.data.code === 0) {
          created += chunk.length;
          this.logger.debug(`批量创建进度: ${created}/${records.length}`);
        } else {
          failed += chunk.length;
          this.logger.error(`批量创建失败: ${response.data.msg}`);
        }
      } catch (error: any) {
        failed += chunk.length;
        this.logger.error(`批量创建异常: ${error.message}`);
      }
    }

    return { created, failed };
  }

  // ==================== 记录更新 ====================

  /**
   * 更新单条记录
   */
  async updateRecord(
    appToken: string,
    tableId: string,
    recordId: string,
    fields: Record<string, any>,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.feishuApi.put<FeishuResponse>(
        `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
        { fields },
      );

      if (response.data.code !== 0) {
        return { success: false, error: response.data.msg };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 批量更新记录
   */
  async batchUpdateRecords(
    appToken: string,
    tableId: string,
    records: Array<{ record_id: string; fields: Record<string, any> }>,
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    // 飞书 API 单次最多 500 条
    const batchSize = 500;
    for (let i = 0; i < records.length; i += batchSize) {
      const chunk = records.slice(i, i + batchSize);

      try {
        const response = await this.feishuApi.post<FeishuResponse>(
          `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_update`,
          { records: chunk },
        );

        if (response.data.code === 0) {
          success += chunk.length;
        } else {
          failed += chunk.length;
          this.logger.error(`批量更新失败: ${response.data.msg}`);
        }
      } catch (error: any) {
        failed += chunk.length;
        this.logger.error(`批量更新异常: ${error.message}`);
      }
    }

    return { success, failed };
  }

  // ==================== 记录删除 ====================

  /**
   * 删除单条记录
   */
  async deleteRecord(
    appToken: string,
    tableId: string,
    recordId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.feishuApi.delete<FeishuResponse>(
        `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
      );

      if (response.data.code !== 0) {
        return { success: false, error: response.data.msg };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 批量删除记录
   */
  async batchDeleteRecords(
    appToken: string,
    tableId: string,
    recordIds: string[],
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    // 飞书 API 单次最多 500 条
    const batchSize = 500;
    for (let i = 0; i < recordIds.length; i += batchSize) {
      const chunk = recordIds.slice(i, i + batchSize);

      try {
        const response = await this.feishuApi.post<FeishuResponse>(
          `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_delete`,
          { records: chunk },
        );

        if (response.data.code === 0) {
          success += chunk.length;
        } else {
          failed += chunk.length;
          this.logger.error(`批量删除失败: ${response.data.msg}`);
        }
      } catch (error: any) {
        failed += chunk.length;
        this.logger.error(`批量删除异常: ${error.message}`);
      }
    }

    return { success, failed };
  }

  // ==================== 工具方法 ====================

  /**
   * 截断文本（飞书字段长度限制）
   */
  truncateText(text: string, maxLength = 2000): string {
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength)}...(truncated)` : text;
  }
}
