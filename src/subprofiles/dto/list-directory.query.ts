import { IsEnum, IsOptional, IsString } from 'class-validator';
import { SubprofileKind } from '../entities/subprofile.entity';

export class ListDirectoryQuery {
  @IsOptional() @IsEnum(SubprofileKind) kind?: SubprofileKind;

  @IsOptional() @IsString() query?: string;
}
