import { IsIn } from 'class-validator';

export const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export class PresignUploadDto {
  @IsIn(ALLOWED_IMAGE_TYPES as unknown as string[])
  contentType: string;
}
