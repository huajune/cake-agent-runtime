/**
 * 预约记录数据库格式
 * @table interview_booking_records
 */
export interface BookingDbRecord {
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
