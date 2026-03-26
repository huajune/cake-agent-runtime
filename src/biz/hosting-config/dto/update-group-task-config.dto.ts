import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateGroupTaskConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
