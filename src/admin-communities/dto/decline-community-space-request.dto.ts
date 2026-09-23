import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DeclineCommunitySpaceRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
