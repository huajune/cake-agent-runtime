import { Controller, Post, Param, HttpException, HttpStatus } from '@nestjs/common';
import { GroupTaskSchedulerService } from './services/group-task-scheduler.service';
import { GroupTaskType } from './group-task.types';

/**
 * 群任务 Controller
 *
 * 手动触发通知任务（调试用）。
 * 配置管理已合并到 /config/agent-config 和 /config/group-task-config。
 */
@Controller('group-task')
export class GroupTaskController {
  constructor(private readonly scheduler: GroupTaskSchedulerService) {}

  /**
   * 手动触发指定类型的通知任务
   *
   * POST /group-task/trigger/:type
   * type: order_grab | part_time | store_manager | work_tips
   */
  @Post('trigger/:type')
  async trigger(@Param('type') type: string) {
    const taskType = type as GroupTaskType;
    const strategy = this.scheduler.getStrategy(taskType);

    if (!strategy) {
      throw new HttpException(
        `未知的任务类型: ${type}，可选值: ${Object.values(GroupTaskType).join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = await this.scheduler.executeTask(strategy, true);
    return {
      type: result.type,
      totalGroups: result.totalGroups,
      successCount: result.successCount,
      failedCount: result.failedCount,
      skippedCount: result.skippedCount,
      details: result.details,
      errors: result.errors,
      durationMs: result.endTime.getTime() - result.startTime.getTime(),
    };
  }
}
