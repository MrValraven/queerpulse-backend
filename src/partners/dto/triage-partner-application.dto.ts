import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class TriagePartnerApplicationDto {
  @IsIn(['approve', 'reject'])
  action: 'approve' | 'reject';

  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}
