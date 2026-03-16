import { Module } from '@nestjs/common';
import { CustomerController } from './customer.controller';
import { CustomerService } from './customer.service';
import { HttpModule } from '@core/client-http';
import { ApiConfigModule } from '@core/config';

@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [CustomerController],
  providers: [CustomerService],
  exports: [CustomerService],
})
export class CustomerModule {}
