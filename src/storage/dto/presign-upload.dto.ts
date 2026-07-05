import { IsIn } from 'class-validator';
import { ALLOWED_IMAGE_TYPES } from '../upload-content-types';

export class PresignUploadDto {
  @IsIn(ALLOWED_IMAGE_TYPES)
  contentType: string;
}
