import { Injectable } from '@nestjs/common';
import { BaseRepository } from '../base.repository';
import { SupabaseService } from '../supabase.service';

/**
 * 预约记录输入
 */
export interface BookingRecordInput {
  brandName?: string;
  storeName?: string;
  chatId?: string;
  userId?: string;
  userName?: string;
  managerId?: string;
  managerName?: string;
}

/**
 * 预约统计数据
 */
export interface BookingStats {
  date: string;
  brandName: string | null;
  storeName: string | null;
  bookingCount: number;
  chatId: string | null;
  userId: string | null;
  userName: string | null;
  managerId: string | null;
  managerName: string | null;
}

/**
 * 预约记录数据库格式
 */
interface BookingDbRecord {
  date: string;
  brand_name: string | null;
  store_name: string | null;
  booking_count: number;
  chat_id: string | null;
  user_id: string | null;
  user_name: string | null;
  manager_id: string | null;
  manager_name: string | null;
}

/**
 * 预约统计 Repository
 *
 * 负责管理 interview_booking_records 表：
 * - 新增预约记录
 * - 查询预约统计
 * - 获取今日预约数
 */
@Injectable()
export class BookingRepository extends BaseRepository {
  protected readonly tableName = 'interview_booking_records';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  // ==================== 预约记录操作 ====================

  /**
   * 增加预约统计计数
   * 每次预约成功都创建一条新记录，便于追溯每次预约的详细信息
   */
  async incrementBookingCount(params: BookingRecordInput): Promise<void> {
    if (!this.isAvailable()) {
      this.logger.warn('[预约统计] Supabase 未初始化，跳过更新');
      return;
    }

    const { brandName, storeName, chatId, userId, userName, managerId, managerName } = params;
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    try {
      await this.insert<BookingDbRecord>({
        date: today,
        brand_name: brandName || null,
        store_name: storeName || null,
        chat_id: chatId || null,
        user_id: userId || null,
        user_name: userName || null,
        manager_id: managerId || null,
        manager_name: managerName || null,
        booking_count: 1,
      });

      this.logger.debug(
        `[预约统计] 新增: ${brandName || '未知品牌'} - ${storeName || '未知门店'}, ` +
          `用户: ${userName || '未知'}, 招募经理: ${managerName || '未知'}`,
      );
    } catch (error) {
      this.logger.error('[预约统计] 更新失败:', error);
      // 不抛出异常，避免影响主流程
    }
  }

  /**
   * 获取预约统计数据
   */
  async getBookingStats(params: {
    startDate?: string;
    endDate?: string;
    brandName?: string;
  }): Promise<BookingStats[]> {
    if (!this.isAvailable()) {
      this.logger.warn('[预约统计] Supabase 未初始化，返回空数组');
      return [];
    }

    try {
      const results = await this.select<BookingDbRecord>('*', (q) => {
        let query = q.order('date', { ascending: false }).order('brand_name');

        // 构建日期范围过滤条件
        if (params.startDate && params.endDate) {
          query = query.gte('date', params.startDate).lte('date', params.endDate);
        } else if (params.startDate) {
          query = query.gte('date', params.startDate);
        } else if (params.endDate) {
          query = query.lte('date', params.endDate);
        }

        if (params.brandName) {
          query = query.eq('brand_name', params.brandName);
        }

        return query;
      });

      return results.map((row) => this.fromDbRecord(row));
    } catch (error) {
      this.logger.error('[预约统计] 查询失败:', error);
      return [];
    }
  }

  /**
   * 获取今日预约总数
   */
  async getTodayBookingCount(): Promise<number> {
    const today = new Date().toISOString().split('T')[0];
    const stats = await this.getBookingStats({ startDate: today, endDate: today });
    return stats.reduce((sum, item) => sum + item.bookingCount, 0);
  }

  // ==================== 私有方法 ====================

  /**
   * 从数据库记录格式转换
   */
  private fromDbRecord(record: BookingDbRecord): BookingStats {
    return {
      date: record.date,
      brandName: record.brand_name,
      storeName: record.store_name,
      bookingCount: record.booking_count,
      chatId: record.chat_id,
      userId: record.user_id,
      userName: record.user_name,
      managerId: record.manager_id,
      managerName: record.manager_name,
    };
  }
}
