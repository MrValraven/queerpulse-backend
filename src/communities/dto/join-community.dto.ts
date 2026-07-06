import { IsOptional, IsString, MaxLength } from 'class-validator';

export class JoinCommunityDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
