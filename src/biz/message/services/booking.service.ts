import { Injectable, Logger } from '@nestjs/common';
import { BookingRepository } from '../repositories/booking.repository';
import { BookingRecordInput, BookingStats } from '../types/message.types';

/**
 * 预约统计服务
 * 负责预约记录的写入与查询
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(private readonly bookingRepository: BookingRepository) {}

  /**
   * 增加预约统计计数（供 channels 层使用）
   */
  async incrementBookingCount(params: BookingRecordInput): Promise<void> {
    this.logger.debug(
      `记录预约: ${params.brandName || '未知品牌'} - ${params.storeName || '未知门店'}`,
    );
    return this.bookingRepository.incrementBookingCount(params);
  }

  /**
   * 获取预约统计数据（供监控分析服务使用）
   */
  async getBookingStats(params: {
    startDate?: string;
    endDate?: string;
    brandName?: string;
  }): Promise<BookingStats[]> {
    return this.bookingRepository.getBookingStats(params);
  }

  /**
   * 获取今日预约总数
   */
  async getTodayBookingCount(): Promise<number> {
    return this.bookingRepository.getTodayBookingCount();
  }
}
