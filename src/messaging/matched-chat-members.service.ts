import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ReportSubjectType } from '../reports/entities/report.entity';
import type { ReportDTO } from '../reports/report-response';
import { ReportsService } from '../reports/reports.service';
import type { BlockOptionsDto } from '../social/dto/block-options.dto';
import { SocialService } from '../social/social.service';
import { isStorageKey } from '../storage/storage-key';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import type { MatchedChatMemberReportDto } from './dto/matched-chat-member-report.dto';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { Conversation } from './entities/conversation.entity';
import { resolveMatchedChatMemberKeys } from './matched-member-key';
import { memberNameOptionsFor } from './message-response';
import { MessagingCoreService } from './messaging-core.service';

/** `POST /conversations/:id/members/:memberKey/block`. Names nobody: the
 *  caller already knows who they blocked by the first name the chat shows. */
export interface MatchedChatMemberBlockResponse {
  blocking: true;
}

/** `POST /conversations/:id/members/:memberKey/report`: the filed report
 *  (or the caller's open report on that member), without its subject, as Go
 *  together's member report answers. */
export type MatchedChatMemberReportResponse = Omit<ReportDTO, 'subjectId'>;

/** Where a matched chat member's visible avatar lives: a storage key the
 *  avatar route streams, or a provider https URL it streams on their
 *  behalf. Never handed to the client. */
export type MatchedChatMemberAvatarSource =
  { storageKey: string } | { externalUrl: string };

/**
 * PRD-423 (opaque member keys): the member actions a matched Go together
 * chat offers, addressed by the per-chat key the chat hands out for each
 * member. Every key resolves server-side, among that one
 * conversation's own seats, for a caller who holds a seat there, so a key
 * never works outside the chat it was minted for.
 */
@Injectable()
export class MatchedChatMembersService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(ConversationParticipant)
    private readonly participants: Repository<ConversationParticipant>,
    private readonly core: MessagingCoreService,
    private readonly social: SocialService,
    private readonly reports: ReportsService,
  ) {}

  /**
   * The user id behind `memberKey` in matched chat `conversationId`, for
   * `callerId`. The caller must hold a seat (a former member still reads
   * the chat's history, so the lenient `requireParticipant` gate). A
   * conversation that is not a matched chat, or a key naming none of its
   * seats, is the same 404, so the route confirms nothing it should not.
   */
  async resolveMemberKey(
    conversationId: string,
    callerId: string,
    memberKey: string,
  ): Promise<string> {
    await this.core.requireParticipant(conversationId, callerId);
    const conversation = await this.conversations.findOne({
      where: { id: conversationId },
      select: { id: true, isGoTogetherChat: true, eventMatchGroupId: true },
    });
    if (!memberNameOptionsFor(conversation).isMatchedGroup) {
      throw new NotFoundException('Member not found');
    }
    const seats = await this.participants.find({
      where: { conversationId },
      select: { userId: true },
    });
    const userId = resolveMatchedChatMemberKeys(
      conversationId,
      seats.map((seat) => seat.userId),
      [memberKey],
    ).get(memberKey);
    if (!userId) {
      throw new NotFoundException('Member not found');
    }
    return userId;
  }

  /**
   * Blocks the member behind `memberKey` (the report sheet's "also block",
   * PRD-368), through the same `SocialService.blockMember` the profile
   * route uses, so every side effect of a block (the severed connection,
   * the hidden group messages) is identical. Idempotent like that route.
   */
  async blockMember(
    conversationId: string,
    callerId: string,
    memberKey: string,
    options?: BlockOptionsDto,
  ): Promise<MatchedChatMemberBlockResponse> {
    const userId = await this.resolveOtherMember(
      conversationId,
      callerId,
      memberKey,
    );
    const profile = await this.participants.manager.findOne(Profile, {
      where: { userId },
      select: { userId: true, slug: true },
    });
    if (!profile) {
      throw new NotFoundException('Member not found');
    }
    // PRD-423: the block remembers the chat it came from, so the block list
    // names this member by first name alone.
    await this.social.blockMember(callerId, profile.slug, options, {
      matchedConversationId: conversationId,
    });
    return { blocking: true };
  }

  /**
   * Reports the member behind `memberKey` as a `member` subject, through the
   * same `ReportsService.create` pipeline `POST /reports` uses (flood caps
   * and severity included), exactly as Go together's member report does.
   * The answer leaves the subject out, so it names nobody back.
   */
  async reportMember(
    conversationId: string,
    callerId: string,
    memberKey: string,
    report: MatchedChatMemberReportDto,
  ): Promise<MatchedChatMemberReportResponse> {
    const userId = await this.resolveOtherMember(
      conversationId,
      callerId,
      memberKey,
    );
    const filed = await this.reports.create(callerId, {
      reasonCode: report.reasonCode,
      detail: report.detail,
      anonymous: report.anonymous,
      evidence: report.evidence,
      subjectType: ReportSubjectType.Member,
      subjectId: userId,
    });
    return {
      id: filed.id,
      subjectType: filed.subjectType,
      reasonCode: filed.reasonCode,
      severity: filed.severity,
      status: filed.status,
      createdAt: filed.createdAt,
      slaDueAt: filed.slaDueAt,
      acknowledgement: filed.acknowledgement,
    };
  }

  /**
   * The stored avatar behind `memberKey`, for the conversation-scoped avatar
   * route (`MatchedChatAvatarController`). The caller must hold a seat (the
   * caller's own key is fine). A hidden or missing photo, a value no image
   * route would serve, and a suspended or banned member's photo (withheld
   * from ordinary viewers exactly as `GET /files/*` withholds it) are the
   * same 404 an unknown key gets.
   */
  async resolveAvatar(
    conversationId: string,
    callerId: string,
    memberKey: string,
  ): Promise<MatchedChatMemberAvatarSource> {
    // An image route says nothing about why it refused: the seat check's
    // 403 for a caller with no seat becomes the 404 an unknown key gets.
    const userId = await this.resolveMemberKey(
      conversationId,
      callerId,
      memberKey,
    ).catch((error: unknown) => {
      if (error instanceof ForbiddenException) {
        throw new NotFoundException('Member not found');
      }
      throw error;
    });
    const profile = await this.participants.manager.findOne(Profile, {
      where: { userId },
      select: { userId: true, avatarUrl: true, photoVisible: true },
    });
    const storedAvatar = profile?.photoVisible ? profile.avatarUrl : null;
    if (!storedAvatar) {
      throw new NotFoundException('Member not found');
    }
    const owner = await this.participants.manager.findOne(User, {
      where: { id: userId },
      select: { id: true, status: true },
    });
    if (!owner || owner.status === UserStatus.Suspended) {
      throw new NotFoundException('Member not found');
    }
    if (isStorageKey(storedAvatar)) {
      return { storageKey: storedAvatar };
    }
    if (storedAvatar.startsWith('https://')) {
      return { externalUrl: storedAvatar };
    }
    throw new NotFoundException('Member not found');
  }

  /** {@link resolveMemberKey}, refusing the caller's own key with a 400. */
  private async resolveOtherMember(
    conversationId: string,
    callerId: string,
    memberKey: string,
  ): Promise<string> {
    const userId = await this.resolveMemberKey(
      conversationId,
      callerId,
      memberKey,
    );
    if (userId === callerId) {
      throw new BadRequestException('You cannot target yourself');
    }
    return userId;
  }
}
