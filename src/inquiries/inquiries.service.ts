import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { normalizePage, paginate } from '../common/pagination';
import { Listing, ListingStatus } from '../listings/entities/listing.entity';
import { Profile } from '../users/entities/profile.entity';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import { ListInquiriesQuery } from './dto/list-inquiries.query';
import {
  InquiryAckDTO,
  InquiryDTO,
  InquiryListDTO,
  InquiryListingDTO,
  toInquiryAckDTO,
  toInquiryDTO,
} from './inquiries-response';
import {
  Inquiry,
  InquiryStatus,
  PRIORITY_INQUIRY_TOPICS,
} from './entities/inquiry.entity';

/**
 * Stores public marketing-form submissions (Contact + partnership) so staff can
 * triage them in the admin list.
 *
 * The admin list is where every inquiry is read. QueerPulse delivers no email,
 * so nothing pings an ops inbox: a submission waits in the list to be read.
 *
 * A safety concern (PRD-452) is the exception on two counts. It is stored
 * with `isPriority`, which sorts it above every other waiting inquiry, and its
 * arrival rings the staff bell through the admin-queue registry, so the
 * Contact page's promise that safety messages are read first is something the
 * inbox actually does. It rings on its own `safety_inquiries` queue, so the
 * bell names it as a safety message and the console counts it apart from the
 * intake forms.
 *
 * A `listing_correction` (PRD-434) is a Contact message about one directory
 * listing. It stores the listing's ref, and the admin list resolves that ref
 * to the listing so staff can open it from the row.
 */
@Injectable()
export class InquiriesService {
  constructor(
    @InjectRepository(Inquiry)
    private readonly inquiries: Repository<Inquiry>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    // PRD-434. Read-only: resolves a correction's stored ref to the listing
    // for the admin row's link.
    @InjectRepository(Listing)
    private readonly listings: Repository<Listing>,
    private readonly adminQueueNotifications: AdminQueueNotificationsService,
  ) {}

  /**
   * Persist a new inquiry (`status = 'new'`). Staff pick it up from the admin
   * triage list.
   *
   * A Contact message whose `topic` is in `PRIORITY_INQUIRY_TOPICS` is stored
   * as priority and announced on the `safety_inquiries` queue, whose bell row
   * deep links to /admin/intakes where this inbox lives, and reaches the same
   * admin tier the list's own guard allows. The announce runs after the save
   * commits and is best effort (it catches and logs), so a bell failure never
   * fails the sender's submit.
   *
   * `listingRef` is kept only on a `listing_correction`; any other kind drops
   * it, so a stray field can never make a press request look like a listing
   * correction in the console.
   */
  async create(dto: CreateInquiryDto): Promise<InquiryAckDTO> {
    const isPriority =
      dto.kind === 'contact' &&
      !!dto.topic &&
      PRIORITY_INQUIRY_TOPICS.includes(dto.topic);
    const inquiry = await this.inquiries.save(
      this.inquiries.create({
        kind: dto.kind,
        senderName: dto.name,
        email: dto.email,
        subject: dto.subject ?? null,
        body: dto.body,
        orgName: dto.orgName ?? null,
        status: 'new',
        isPriority,
        listingRef:
          dto.kind === 'listing_correction' ? (dto.listingRef ?? null) : null,
      }),
    );

    if (isPriority) {
      await this.adminQueueNotifications.announce(
        AdminQueueKey.SafetyInquiries,
        inquiry.id,
      );
    }

    return toInquiryAckDTO(inquiry);
  }

  /**
   * Batch-resolve a set of handler user-ids to member display refs (ONE query
   * for the whole page — never one per row). Skips the lookup entirely when
   * nothing on the page has been handled yet.
   */
  private async resolveHandlers(
    handlerIds: (string | null)[],
  ): Promise<Map<string, MemberRef>> {
    const ids = [...new Set(handlerIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map<string, MemberRef>();
    return new MemberLookup(this.profiles).byUserIds(ids);
  }

  /**
   * Batch-resolve the listing refs on a page of corrections (PRD-434). ONE
   * query for the whole page, and none when the page carries no ref. A ref
   * that no listing has any more simply does not resolve.
   */
  private async resolveListings(
    listingRefs: (string | null)[],
  ): Promise<Map<string, InquiryListingDTO>> {
    const refs = [
      ...new Set(listingRefs.filter((ref): ref is string => !!ref)),
    ];
    if (refs.length === 0) return new Map<string, InquiryListingDTO>();
    const rows = await this.listings.find({
      where: { ref: In(refs) },
      select: {
        ref: true,
        name: true,
        slug: true,
        status: true,
        isHiddenByOwner: true,
      },
    });
    return new Map(
      rows.map((row) => [
        row.ref,
        {
          ref: row.ref,
          name: row.name,
          slug: row.slug,
          isPublic: row.status === ListingStatus.Live && !row.isHiddenByOwner,
        },
      ]),
    );
  }

  /**
   * Admin triage list, newest first, optionally filtered by kind/status.
   * A priority inquiry that is still `new` sorts above everything else
   * (PRD-452); once handled it falls back into date order, so the archive
   * reads chronologically. The CASE is written in quoted snake_case so
   * TypeORM passes it through verbatim.
   * Paginated with the shared page/`PAGE_SIZE` idiom so the admin console codes
   * against ONE envelope for this inbox and the intakes one.
   *
   * `unhandledCount` rides along so the console's badge needs no second
   * request. It applies the same `kind` filter as the page but ignores
   * `status`, so opening the "handled" tab doesn't zero the badge. No join
   * anywhere in either query, so the plain `skip`/`take` in `paginate` is safe
   * (the `.offset()/.limit()` rule only bites a joined, ordered query).
   */
  async list(query: ListInquiriesQuery): Promise<InquiryListDTO> {
    const page = normalizePage(query.page);
    const queryBuilder = this.inquiries
      .createQueryBuilder('inquiry')
      .orderBy(
        `CASE WHEN "inquiry"."is_priority" AND "inquiry"."status" = 'new' THEN 0 ELSE 1 END`,
        'ASC',
      )
      .addOrderBy('inquiry.createdAt', 'DESC');

    if (query.kind) {
      queryBuilder.andWhere('inquiry.kind = :kind', { kind: query.kind });
    }
    if (query.status) {
      queryBuilder.andWhere('inquiry.status = :status', {
        status: query.status,
      });
    }

    const [pageResult, unhandledCount] = await Promise.all([
      paginate(queryBuilder, page, async (rows) => {
        const [refs, listings] = await Promise.all([
          this.resolveHandlers(rows.map((row) => row.handledById)),
          this.resolveListings(rows.map((row) => row.listingRef)),
        ]);
        return rows.map((row) =>
          toInquiryDTO(
            row,
            row.handledById ? (refs.get(row.handledById) ?? null) : null,
            row.listingRef ? (listings.get(row.listingRef) ?? null) : null,
          ),
        );
      }),
      this.inquiries.count({
        where: {
          status: 'new',
          ...(query.kind ? { kind: query.kind } : {}),
        },
      }),
    ]);

    return { ...pageResult, unhandledCount };
  }

  /**
   * Admin triage action: take an inquiry off the pile, or put it back.
   *
   * Moving to `handled` stamps WHO and WHEN, so a second admin can see the
   * message is already someone's. Moving back to `new` CLEARS both: a
   * re-opened inquiry has no handler, and a stale name on it would read as
   * "already dealt with" to the next person through the queue.
   *
   * Re-sending `handled` on an already-handled row keeps the original stamp
   * rather than moving the clock to the current admin — a console refresh must
   * not rewrite who took it. A row that is somehow `handled` with no handler
   * (flipped in SQL before this existed) does get stamped, so the gap can be
   * closed from the console. 404s on an unknown id so a stale console doesn't
   * silently no-op.
   */
  async updateStatus(
    id: string,
    status: InquiryStatus,
    adminUserId: string,
  ): Promise<InquiryDTO> {
    const inquiry = await this.inquiries.findOne({ where: { id } });
    if (!inquiry) {
      throw new NotFoundException('No inquiry with that id.');
    }

    if (status === 'handled') {
      const isAlreadyAttributed =
        inquiry.status === 'handled' && inquiry.handledById !== null;
      if (!isAlreadyAttributed) {
        inquiry.handledById = adminUserId;
        inquiry.handledAt = new Date();
      }
    } else {
      inquiry.handledById = null;
      inquiry.handledAt = null;
    }
    inquiry.status = status;

    const saved = await this.inquiries.save(inquiry);
    const [refs, listings] = await Promise.all([
      this.resolveHandlers([saved.handledById]),
      this.resolveListings([saved.listingRef]),
    ]);
    return toInquiryDTO(
      saved,
      saved.handledById ? (refs.get(saved.handledById) ?? null) : null,
      saved.listingRef ? (listings.get(saved.listingRef) ?? null) : null,
    );
  }
}
