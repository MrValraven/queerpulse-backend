import { IsString, MaxLength } from 'class-validator';
import { TrimMessageBody } from './trim-message-body';

export class EditMessageDto {
  /**
   * The edited text. May be empty (ENG-405) so the author of a photo,
   * document or GIF can clear its caption; `MessagesService.editMessage`
   * refuses an empty edit on every other kind with a 400, so a text message
   * still cannot be emptied through an edit.
   */
  @TrimMessageBody()
  @IsString()
  @MaxLength(5000)
  body!: string;
}
