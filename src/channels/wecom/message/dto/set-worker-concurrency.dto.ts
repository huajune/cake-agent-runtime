import { IsInt, Min } from 'class-validator';

export class SetWorkerConcurrencyDto {
  @IsInt()
  @Min(1)
  concurrency: number;
}
