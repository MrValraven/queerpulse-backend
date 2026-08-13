import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { VerificationLevel } from '../verification-level';

/** PATCH /admin/verifications/:userId body — the manual-review override. */
export class OverrideVerificationDto {
  @IsEnum(VerificationLevel)
  level!: VerificationLevel;

  /** Optional reviewer note kept only for the admin's own context. */
  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}
