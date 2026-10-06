import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { isMatchedChatMemberKey } from './matched-member-key';

/** PRD-423: a route param that must be a per-chat member key in shape
 *  (`m-` and 24 lowercase hex characters). Whether it names anyone is the
 *  service's question, asked inside the conversation's own scope. */
@Injectable()
export class MatchedChatMemberKeyPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isMatchedChatMemberKey(value)) {
      throw new BadRequestException('Invalid member key');
    }
    return value;
  }
}
