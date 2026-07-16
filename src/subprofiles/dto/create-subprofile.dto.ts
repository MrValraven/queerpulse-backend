import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { SubprofileKind } from '../entities/subprofile.entity';

export class CreateSubprofileDTO {
  @IsEnum(SubprofileKind) kind: SubprofileKind;

  @IsString() @MinLength(1) @MaxLength(120) displayName: string;
}
