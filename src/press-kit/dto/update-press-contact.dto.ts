import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

// Every field optional — a PATCH touches only what it sends. `position` is NOT
// here: order is changed exclusively through the reorder endpoint.
export class UpdatePressContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  role?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  languages?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  // Same validation as the create body, for the same reasons: a bare storage
  // key is accepted (an uploaded avatar was previously impossible to save) and
  // an arbitrary host is refused (this value is rendered by the unauthenticated
  // press-kit page). See `CreatePressContactDto.avatarUrl` for the long form.
  @IsOptional()
  @IsImageReference()
  avatarUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
