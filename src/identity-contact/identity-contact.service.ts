import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Company } from '../companies/entities/company.entity';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentitiesService } from '../identities/identities.service';
import { Message } from '../messaging/entities/message.entity';
import {
  identityBlockedException,
  IdentityEnquiryBlockedReason,
  IdentityEnquiryContactability,
} from '../messaging/message-requests.service';
import { identityContactRefusalException } from '../messaging/messaging-core.service';
import { MessagingService } from '../messaging/messaging.service';
import { BlockFilterService } from '../social/block-filter.service';
import {
  Subprofile,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { isSubprofileUnderTakedown } from '../subprofiles/subprofile-takedown';
import { CreateIdentityEnquiryDto } from './dto/create-identity-enquiry.dto';
import {
  IdentityContactDTO,
  IdentityContactUnavailableReason,
  IdentityEnquirySentDTO,
} from './identity-contact-response';
import {
  coldEnquiryMailboxKey,
  evaluateIdentityEnquiryQuota,
  identityEnquiryLimitMessage,
  IdentityEnquiryQuotaState,
  loadColdEnquiries,
} from './identity-enquiry-quota';

/** Mirrors `CompaniesService.SUBJECT_TYPE`, which is private to it. */
const COMPANY_MODERATION_SUBJECT_TYPE = 'company';

/**
 * Task 18: "Message" on a persona or a company, the two mailbox entry points
 * beside the directory listing's (`ListingEnquiriesService`). Each resolves
 * the persona or company identity and delivers through
 * `MessagingService.deliverEnquiryToIdentity`, so the message lands in that
 * identity's mailbox, read by every staff member. The customer sees the
 * persona or company as the one they are talking to.
 *
 * Reaching a persona no longer goes through its owner's personal profile, so
 * an `unlinked` persona is contactable too: nothing in any answer here names
 * or implies the owner. What IS still required is that the member could see
 * the persona or company at all: a draft, a private persona, and anything
 * under a moderator takedown answer 404, as their public reads do. A persona
 * moderation removed answers with the coded `IDENTITY_REMOVED` refusal, which
 * its public read already discloses as `removed`.
 *
 * Gating and quotas take the directory's shape: one read (`get...Contact`)
 * that says in advance whether a send would go through, and a send that
 * re-checks everything and is the only authority.
 */
@Injectable()
export class IdentityContactService {
  constructor(
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(Company)
    private readonly companies: Repository<Company>,
    // Read-only: the counted caps, see `identity-enquiry-quota.ts`.
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
    private readonly identities: IdentitiesService,
    private readonly messaging: MessagingService,
    private readonly contentModeration: ContentModerationService,
    // Fix round 1: a persona is withheld from a member person-blocked with
    // its owner, as the persona page withholds it.
    private readonly blockFilter: BlockFilterService,
  ) {}

  async getPersonaContact(
    subprofileId: string,
    viewerUserId: string,
  ): Promise<IdentityContactDTO> {
    const identityId = await this.resolvePersonaIdentityId(
      subprofileId,
      viewerUserId,
    );
    return this.describeContact(identityId, viewerUserId);
  }

  async sendToPersona(
    subprofileId: string,
    senderUserId: string,
    dto: CreateIdentityEnquiryDto,
  ): Promise<IdentityEnquirySentDTO> {
    const identityId = await this.resolvePersonaIdentityId(
      subprofileId,
      senderUserId,
    );
    return this.send(identityId, senderUserId, dto);
  }

  async getCompanyContact(
    slug: string,
    viewerUserId: string,
  ): Promise<IdentityContactDTO> {
    const identityId = await this.resolveCompanyIdentityId(slug);
    return this.describeContact(identityId, viewerUserId);
  }

  async sendToCompany(
    slug: string,
    senderUserId: string,
    dto: CreateIdentityEnquiryDto,
  ): Promise<IdentityEnquirySentDTO> {
    const identityId = await this.resolveCompanyIdentityId(slug);
    return this.send(identityId, senderUserId, dto);
  }

  /** Whether the viewer can write to this mailbox, and what they would meet.
   *  A read, so "you cannot message this" comes back as an answer. */
  private async describeContact(
    identityId: string,
    viewerUserId: string,
  ): Promise<IdentityContactDTO> {
    const contactability = await this.messaging.identityEnquiryContactability(
      viewerUserId,
      identityId,
    );
    if (!contactability.canDeliver) {
      return {
        canMessage: false,
        unavailableReason: unavailableReasonFor(contactability.blockedReason),
        followUpAwaitsReply: false,
        existingConversationId: null,
        ...UNCAPPED,
      };
    }
    const quota = await this.evaluateQuota(
      viewerUserId,
      contactability.existingConversationId,
    );
    return {
      canMessage: true,
      unavailableReason: null,
      followUpAwaitsReply: contactability.followUpAwaitsReply,
      existingConversationId: contactability.existingConversationId,
      ...(quota.hasReachedLimit
        ? {
            hasReachedEnquiryLimit: true,
            enquiryLimitReason: quota.reason,
            enquiryLimitClearsAt: quota.clearsAt.toISOString(),
          }
        : UNCAPPED),
    };
  }

  /**
   * Refusals first, each with the coded body the delivery itself would
   * throw, then the caps, then the delivery, which checks every refusal once
   * more. No separate notification: the message is real, so every reachable
   * staff seat gets the ordinary live frame and push.
   */
  private async send(
    identityId: string,
    senderUserId: string,
    dto: CreateIdentityEnquiryDto,
  ): Promise<IdentityEnquirySentDTO> {
    const contactability = await this.messaging.identityEnquiryContactability(
      senderUserId,
      identityId,
    );
    if (!contactability.canDeliver) {
      throw refusalFor(contactability);
    }
    const quota = await this.evaluateQuota(
      senderUserId,
      contactability.existingConversationId,
    );
    if (quota.hasReachedLimit) {
      throw new HttpException(
        identityEnquiryLimitMessage(quota.reason),
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const { conversationId } = await this.messaging.deliverEnquiryToIdentity(
      senderUserId,
      identityId,
      dto.body.trim(),
      dto.asIdentityId,
    );
    return {
      conversationId,
      followUpAwaitsReply: contactability.followUpAwaitsReply,
    };
  }

  /** Both caps: 3 a day to this mailbox, and the one daily ceiling shared
   *  with directory enquiries (`loadColdEnquiries`). */
  private async evaluateQuota(
    userId: string,
    mailboxConversationId: string | null,
  ): Promise<IdentityEnquiryQuotaState> {
    const rows = await loadColdEnquiries(this.messages, userId);
    return evaluateIdentityEnquiryQuota(
      rows,
      mailboxConversationId
        ? coldEnquiryMailboxKey({ conversationId: mailboxConversationId })
        : null,
    );
  }

  /** The persona's mailbox identity, or 404 when the member could not see
   *  the persona: a draft, a private persona, a moderator takedown, or
   *  (fix round 1) a person block in either direction between the member and
   *  the persona's owner, the same 404 in the same order the persona page
   *  gives (`SubprofilePublicReadService.assertPublicViewVisible`). Co-owners
   *  are not consulted, as the page does not consult them. A removed persona
   *  resolves, and the contactability refuses it with its code. */
  private async resolvePersonaIdentityId(
    subprofileId: string,
    viewerUserId: string,
  ): Promise<string> {
    const persona = await this.subprofiles.findOne({
      where: {
        id: subprofileId,
        status: SubprofileStatus.Published,
        visibility: In([
          SubprofileVisibility.Open,
          SubprofileVisibility.Network,
        ]),
      },
      select: { id: true, slug: true, userId: true },
    });
    if (
      !persona ||
      (await isSubprofileUnderTakedown(this.contentModeration, persona.slug)) ||
      (await this.blockFilter.isBlockedEitherWay(viewerUserId, persona.userId))
    ) {
      throw new NotFoundException('Subprofile not found');
    }
    const identity = await this.identities.ensureIdentityFor(
      IdentityKind.Subprofile,
      persona.id,
    );
    return identity.id;
  }

  /** The company's mailbox identity, or 404 when it does not exist or is
   *  under a moderator takedown, as the public company read answers. */
  private async resolveCompanyIdentityId(slug: string): Promise<string> {
    const company = await this.companies.findOne({
      where: { slug },
      select: { id: true, slug: true },
    });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    const moderation = await this.contentModeration.stateFor(
      COMPANY_MODERATION_SUBJECT_TYPE,
      slug,
    );
    if (moderation.hidden || moderation.removed) {
      throw new NotFoundException('Company not found');
    }
    const identity = await this.identities.ensureIdentityFor(
      IdentityKind.Company,
      company.id,
    );
    return identity.id;
  }
}

const UNCAPPED = {
  hasReachedEnquiryLimit: false,
  enquiryLimitReason: null,
  enquiryLimitClearsAt: null,
} as const;

function unavailableReasonFor(
  blockedReason: IdentityEnquiryBlockedReason | null,
): IdentityContactUnavailableReason {
  switch (blockedReason) {
    case 'IDENTITY_IS_YOUR_OWN':
      return 'own_mailbox';
    case 'IDENTITY_HAS_NO_STAFF':
      return 'unstaffed';
    case 'IDENTITY_REMOVED':
      return 'removed';
    default:
      return 'unavailable';
  }
}

/** The refusal a send meets, the same the delivery throws: `blocked` as
 *  the coded `IDENTITY_BLOCKED` 403, and every other reason with its code. */
function refusalFor(contactability: IdentityEnquiryContactability) {
  if (
    !contactability.blockedReason ||
    contactability.blockedReason === 'blocked'
  ) {
    return identityBlockedException();
  }
  return identityContactRefusalException(contactability.blockedReason);
}
