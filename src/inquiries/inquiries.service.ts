import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { normalizePage, paginate } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { MailerService } from '../mailer/mailer.service';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import { ListInquiriesQuery } from './dto/list-inquiries.query';
import {
  InquiryAckDTO,
  InquiryDTO,
  InquiryListDTO,
  toInquiryAckDTO,
  toInquiryDTO,
} from './inquiries-response';
import { Inquiry, InquiryStatus } from './entities/inquiry.entity';

/**
 * Stores public marketing-form submissions (Contact + partnership) and pings
 * ops so a message is never lost between a member sending it and staff seeing
 * it in the admin list. The notification goes through the shared
 * {@link MailerService}, which is log-only until SMTP env is set — so in dev the
 * inquiry is persisted and its arrival logged, and the moment real SMTP creds
 * exist the same code delivers to the ops inbox.
 */
@Injectable()
export class InquiriesService {
  private readonly logger = new Logger(InquiriesService.name);

  constructor(
    @InjectRepository(Inquiry)
    private readonly inquiries: Repository<Inquiry>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly mailer: MailerService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Persist a new inquiry (`status = 'new'`) and notify ops. The row is saved
   * first; a mail failure is logged but never fails the request — the caller's
   * message is already safely stored for triage, so a flaky mailer must not tell
   * a visitor their message bounced.
   */
  async create(dto: CreateInquiryDto): Promise<InquiryAckDTO> {
    const inquiry = await this.inquiries.save(
      this.inquiries.create({
        kind: dto.kind,
        senderName: dto.name,
        email: dto.email,
        subject: dto.subject ?? null,
        body: dto.body,
        orgName: dto.orgName ?? null,
        status: 'new',
      }),
    );

    await this.notifyOps(inquiry);

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
   * Admin triage list, newest first, optionally filtered by kind/status.
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
      .orderBy('inquiry.createdAt', 'DESC');

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
        const refs = await this.resolveHandlers(
          rows.map((row) => row.handledById),
        );
        return rows.map((row) =>
          toInquiryDTO(
            row,
            row.handledById ? (refs.get(row.handledById) ?? null) : null,
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
    const refs = await this.resolveHandlers([saved.handledById]);
    return toInquiryDTO(
      saved,
      saved.handledById ? (refs.get(saved.handledById) ?? null) : null,
    );
  }

  private async notifyOps(inquiry: Inquiry): Promise<void> {
    const to =
      this.config.get<string>('mail.opsInbox') ??
      this.config.get<string>('mail.from');
    if (!to) {
      // No ops recipient configured and no MAIL_FROM fallback — the row is still
      // saved and visible in the admin list; skip the mail rather than throw.
      this.logger.warn(
        `Inquiry ${inquiry.id} saved but not emailed: no ops inbox configured.`,
      );
      return;
    }
    try {
      await this.mailer.send(to, 'ops_inquiry_received', {
        kind: inquiry.kind,
        senderName: inquiry.senderName,
        senderEmail: inquiry.email,
        subject: inquiry.subject ?? undefined,
        orgName: inquiry.orgName ?? undefined,
        body: inquiry.body,
      });
    } catch (error) {
      this.logger.error(
        `Inquiry ${inquiry.id} saved but ops email failed: ${String(error)}`,
      );
    }
  }
}
