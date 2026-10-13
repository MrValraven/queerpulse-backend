import { IsString, Matches } from 'class-validator';
import { STUDIO_AUDIO_KEY_PATTERN } from '../../storage/storage-key';

export class ConfirmStudioAudioDto {
  @IsString()
  @Matches(STUDIO_AUDIO_KEY_PATTERN)
  key!: string;
}
