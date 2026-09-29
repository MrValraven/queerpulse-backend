import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export const CHECK_IN_STATUSES = ['here', 'left'] as const;
export type CheckInStatus = (typeof CHECK_IN_STATUSES)[number];

export class CheckInDto {
  @ApiProperty({ enum: CHECK_IN_STATUSES })
  @IsIn(CHECK_IN_STATUSES)
  status!: CheckInStatus;
}
