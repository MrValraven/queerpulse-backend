import { IsInt, Max, Min } from 'class-validator';

export class ReportProgressDto {
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  positionSeconds: number;
}
