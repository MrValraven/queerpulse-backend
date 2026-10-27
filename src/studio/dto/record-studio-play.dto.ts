import { IsUUID } from 'class-validator';

/** `POST /studio/plays`: the track the listener just played. */
export class RecordStudioPlayDto {
  @IsUUID()
  trackId!: string;
}
