import { Injectable } from '@nestjs/common';
import { OfficialConversationsService } from '../official-messages/official-conversations.service';

/** The house account that owns every matched chat and hosts official events. */
@Injectable()
export class GoTogetherHouseService {
  constructor(private readonly official: OfficialConversationsService) {}

  houseUserId(): Promise<string> {
    return this.official.resolveOfficialSenderId();
  }
}
