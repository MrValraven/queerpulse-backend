import { IsIn } from 'class-validator';
import { ConnectionAction } from '../connections.service';

export class RespondConnectionDto {
  @IsIn(['accept', 'decline', 'block', 'unblock'])
  action: ConnectionAction;
}
