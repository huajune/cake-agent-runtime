import { Controller, Post, Get, Body, Param, UseGuards, ParseEnumPipe } from '@nestjs/common';
import { ApiTokenGuard } from '@infra/server/guards/api-token.guard';
import { GroupTaskAdminService } from './services/group-task-admin.service';
import { GroupTaskType } from './group-task.types';

/**
 * 群任务 Controller
 *
 * 面向 dashboard / 运维的入口：
 *   POST /group-task/trigger/:type  → 将任务入 Bull plan 队列（不阻塞）
 *   POST /group-task/retry/:type    → 把该类型下失败的 send job 重新排队（补发差集）
 *   GET  /group-task/status/:type   → 查看该类型当前队列状态（排障）
 *   POST /group-task/test-send      → 单群测试（飞书预览 / 真实发送）
 *
 * 显式声明 ApiTokenGuard，防止全局 Guard 配置变更时意外暴露。
 */
@UseGuards(ApiTokenGuard)
@Controller('group-task')
export class GroupTaskController {
  constructor(private readonly adminService: GroupTaskAdminService) {}

  /**
   * 手动触发指定类型的通知任务（入队后立即返回 execId）。
   *
   * forceEnabled=true 绕过 enabled 开关（即使定时任务关闭也能执行），
   * 但仍遵守 DB 中的 dryRun 设置（试运行时只发飞书不发企微）。
   */
  @Post('trigger/:type')
  async trigger(@Param('type', new ParseEnumPipe(GroupTaskType)) type: GroupTaskType) {
    return this.adminService.trigger(type);
  }

  /**
   * 补发：把该类型下 failed 的 send job 整体 retry 一遍。
   *
   * 由于 send 任务带有 `group-task:sent:${type}:${date}[:timeSlot]:${groupId}` 的日内幂等键，
   * 已发送成功的群不会被重发；失败的群会走新一轮 attempts + backoff。
   */
  @Post('retry/:type')
  async retry(@Param('type', new ParseEnumPipe(GroupTaskType)) type: GroupTaskType) {
    return this.adminService.retry(type);
  }

  /**
   * 查询某类型当前队列状态（粗粒度聚合 + 可选详情）。
   * 供 dashboard 判断"今天到底发到哪一步了 / 还有多少待发"。
   */
  @Get('status/:type')
  async status(@Param('type', new ParseEnumPipe(GroupTaskType)) type: GroupTaskType) {
    return this.adminService.status(type);
  }

  /**
   * 测试端点：向指定群发送模拟群任务通知
   *
   * 从已配置的小组 token 中查找目标群（按群名匹配），
   * 运行策略的完整流程（fetchData → 生成消息 → 发送）。
   * 不走 Bull，直接同步执行便于调试。
   */
  @Post('test-send')
  async testSend(
    @Body()
    body: {
      type: GroupTaskType;
      groupName: string;
      city?: string;
      industry?: string;
      forceSend?: boolean;
    },
  ) {
    return this.adminService.testSend(body);
  }
}
