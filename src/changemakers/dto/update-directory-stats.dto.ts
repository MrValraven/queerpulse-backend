import { IsInt, Min } from 'class-validator';

export class UpdateDirectoryStatsDto {
  @IsInt() @Min(0) peopleHelped: number;
  @IsInt() @Min(0) activeCampaigns: number;
}
