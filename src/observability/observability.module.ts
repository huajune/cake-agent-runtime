import { Module } from '@nestjs/common';
import { LoggerObserver } from './logger-observer';
import { OBSERVER } from './observer.interface';

@Module({
  providers: [{ provide: OBSERVER, useClass: LoggerObserver }],
  exports: [OBSERVER],
})
export class ObservabilityModule {}
