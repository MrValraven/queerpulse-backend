import { IsString, Matches, MaxLength } from 'class-validator';

/** POST /verification/phone/start body. E.164-ish phone number; we never store
 * it beyond the dev provider's in-memory challenge. */
export class StartPhoneVerificationDto {
  @IsString()
  @MaxLength(32)
  @Matches(/^\+?[0-9 ()-]{6,}$/, {
    message: 'That phone number does not look right',
  })
  phoneNumber!: string;
}
