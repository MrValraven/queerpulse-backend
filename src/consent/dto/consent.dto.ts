import { Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ConsentSource } from '../entities/consent-record.entity';

export class ConsentCategoriesDto {
  // `necessary` is always on; the client sends `true` and we require it.
  @Equals(true) necessary!: true;
  @IsBoolean() analytics!: boolean;
  @IsBoolean() monitoring!: boolean;
}

export class ConsentDto {
  @IsOptional() @IsString() @MaxLength(200) anonId?: string;

  @ValidateNested()
  @Type(() => ConsentCategoriesDto)
  categories!: ConsentCategoriesDto;

  /**
   * The privacy-policy revision the banner or preference centre displayed.
   *
   * ACCEPTED AND IGNORED. `ConsentService.record` stamps the saved row with the
   * server's `CURRENT_PRIVACY_POLICY_VERSION` instead (ENG-23): `consent_record`
   * is the GDPR evidence trail, and evidence cannot be dictated by the party it
   * is evidence about. See the essay on that method.
   *
   * The field stays declared, stays required, and keeps its validators rather
   * than being deleted. The global `ValidationPipe` runs with
   * `forbidNonWhitelisted`, so an unrecognised key in the body is a 400, and the
   * frontend's `ConsentProvider` still sends this one on every banner and
   * preference-centre save. Dropping it would make every consent POST from a
   * client that has not shipped yet fail outright, and a consent banner that
   * 400s is a consent banner that has stopped recording consent, a worse
   * outcome than accepting a value and declining to trust it.
   */
  @IsString() @MinLength(1) @MaxLength(50) policyVersion!: string;

  @IsEnum(ConsentSource) source!: ConsentSource;
}
