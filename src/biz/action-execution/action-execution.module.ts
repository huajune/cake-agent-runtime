import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ActionExecutorService } from './action-executor.service';
import { ActionRecordsRepository } from './action-records.repository';
import { ActionRecoveryRegistry } from './action-recovery.registry';
import { ActionRecoveryService } from './action-recovery.service';
import {
  ACTION_REPAIR_QUEUE,
  ActionRepairQueue,
  ActionRepairProcessor,
} from './action-repair.queue';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: ACTION_REPAIR_QUEUE })],
  providers: [
    ActionExecutorService,
    ActionRecordsRepository,
    ActionRecoveryRegistry,
    ActionRecoveryService,
    ActionRepairQueue,
    ActionRepairProcessor,
  ],
  exports: [ActionExecutorService, ActionRecordsRepository, ActionRecoveryRegistry],
})
export class ActionExecutionModule {}
