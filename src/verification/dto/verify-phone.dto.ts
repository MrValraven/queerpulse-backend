import { IsString, Length } from 'class-validator';

/** POST /verification/phone/verify body. The six-digit OTP the member received. */
export class VerifyPhoneDto {
  @IsString()
  @Length(4, 8)
  code!: string;
}
