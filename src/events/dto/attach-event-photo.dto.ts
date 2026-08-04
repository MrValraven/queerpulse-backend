import { IsOptional, IsString, MaxLength } from 'class-validator';

export class AttachEventPhotoDto {
  // A `gathering-photos/<uploaderId>/<uuid>.<ext>` storage key. Shape/kind is
  // checked in the service (`assertGatheringPhotoKey`); ownership is enforced
  // globally by `StorageKeyOwnershipInterceptor`.
  @IsString()
  @MaxLength(512)
  key!: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  caption?: string;
}
