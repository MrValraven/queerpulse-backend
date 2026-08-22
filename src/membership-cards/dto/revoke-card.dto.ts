import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SetCardStatusDto {
  @IsIn(['active', 'suspended', 'revoked'])
  status!: 'active' | 'suspended' | 'revoked';

  // Required for suspend and revoke, ignored for reinstate. The service
  // enforces the conditional requirement, since class-validator cannot see
  // across fields without a custom validator.
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(280)
  reason?: string;
}
