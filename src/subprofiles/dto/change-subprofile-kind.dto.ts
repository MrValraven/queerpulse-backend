import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { SubprofileKind } from '../entities/subprofile.entity';

// Body of `POST /subprofiles/:id/kind`. The family rule and the Studio guard
// run in the service, which answers each refusal with its own reason code.
export class ChangeSubprofileKindDTO {
  @ApiProperty({ enum: SubprofileKind })
  @IsEnum(SubprofileKind)
  kind!: SubprofileKind;
}
