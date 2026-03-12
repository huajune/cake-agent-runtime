import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ModelService } from './model.service';

@Module({
  imports: [ConfigModule],
  providers: [ModelService],
  exports: [ModelService],
})
export class ModelModule {}
