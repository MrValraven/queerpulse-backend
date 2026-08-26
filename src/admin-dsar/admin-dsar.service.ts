import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  DsarRequest,
  DsarStatus,
} from '../account/entities/dsar-request.entity';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { PAGE_SIZE, normalizePage } from '../common/pagination';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import {
  AdminDsarPageDTO,
  AdminDsarRequestDTO,
  toAdminDsarRequestDTO,
} from './admin-dsar-response';
import { ListAdminDsarQuery } from './dto/list-admin-dsar.query';
import {
  AdminDsarTargetStatus,
  UpdateAdminDsarDto,
} from './dto/update-admin-dsar.dto';

/**
 * The status moves an operator is allowed to make, keyed by where the request
 * is now. `received -> in_review -> resolved | rejected` is the intended path;
 * `received -> resolved | rejected` is allowed too, because a request answered
 * the same hour it arrived should not need a bookkeeping stop in between.
 * Terminal states accept nothing: a DSAR that has been answered is answered,
 * and re-opening it would restart a statutory clock that has already stopped.
 */
const ALLOWED_TRANSITIONS: Record<DsarStatus, readonly DsarStatus[]> = {
  [DsarStatus.Received]: [
    DsarStatus.InReview,
    DsarStatus.Resolved,
    DsarStatus.Rejected,
  ],
  [DsarStatus.InReview]: [DsarStatus.Resolved, DsarStatus.Rejected],
  [DsarStatus.Resolved]: [],
  [DsarStatus.Rejected]: [],
};

/** The two statuses that stop the statutory clock and close the request. */
function isTerminal(status: DsarStatus): boolean {
  return status === DsarStatus.Resolved || status === DsarStatus.Rejected;
}

/**
 * Read model plus the review transitions behind the admin DSAR queue.
 *
 * A DSAR (`POST /account/dsar`) starts a 30-day statutory clock the moment it
 * is filed, and until this module existed nothing listed, reviewed or resolved
 * one: every row sat at `received` while its deadline passed unseen. The list
 * is therefore sorted by `dueBy` ASCENDING, closest deadline first, rather
 * than newest-first like every neighbouring admin queue, because here the
 * question is never "what just arrived", it is "what runs out next".
 *
 * Every row is hand-mapped to `AdminDsarRequestDTO` (never a raw entity), and
 * the requester refs for a whole page are resolved in ONE batched profile
 * lookup, mirroring `AdminInvitesService`.
 */
@Injectable()
export class AdminDsarService {
  private readonly logger = new Logger(AdminDsarService.name);

  constructor(
    @InjectRepository(DsarRequest)
    private readonly dsarRequests: Repository<DsarRequest>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly notifications: NotificationsService,
  ) {}

  async list(query: ListAdminDsarQuery): Promise<AdminDsarPageDTO> {
    const page = normalizePage(query.page);
    const now = new Date();

    const requestQueryBuilder = this.dsarRequests
      .createQueryBuilder('request')
      // The statutory deadline is the whole point of this queue, so it is the
      // sort. `submittedAt` breaks ties deterministically (two rows filed the
      // same day share a `dueBy` to the millisecond only by coincidence, but
      // an unstable sort would still shuffle a page under pagination).
      .orderBy('request.dueBy', 'ASC')
      .addOrderBy('request.submittedAt', 'ASC')
      .skip((page - 1) * PAGE_SIZE)
      .take(PAGE_SIZE);

    if (query.status) {
      requestQueryBuilder.andWhere('request.status = :status', {
        status: query.status,
      });
    }

    const [rows, total] = await requestQueryBuilder.getManyAndCount();
    if (!rows.length) {
      return { items: [], total, page, pageSize: PAGE_SIZE };
    }

    const refsByUserId = await this.membersFor(rows);
    const items = rows.map((row) =>
      toAdminDsarRequestDTO(row, refsByUserId.get(row.userId) ?? null, now),
    );
    return { items, total, page, pageSize: PAGE_SIZE };
  }

  /** One DSAR in full, for the queue's detail pane. */
  async findOne(id: string): Promise<AdminDsarRequestDTO> {
    const request = await this.dsarRequests.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException('DSAR request not found');
    }
    const refsByUserId = await this.membersFor([request]);
    return toAdminDsarRequestDTO(
      request,
      refsByUserId.get(request.userId) ?? null,
      new Date(),
    );
  }

  /**
   * Move a DSAR along and record what was decided.
   *
   *  - 404 when no request carries that id;
   *  - 409 when the move is not one `ALLOWED_TRANSITIONS` permits (including
   *    any move out of a terminal state, and any no-op re-application of the
   *    status the row already holds), so an operator acting on a stale pane is
   *    told the row moved rather than silently overwriting it;
   *  - 400 when a terminal move carries no outcome note. Closing a statutory
   *    request without saying what was done is the exact failure this whole
   *    module exists to end, so it is refused rather than defaulted.
   *
   * A terminal move stamps `respondedAt` and `resolvedByUserId`, then fires an
   * in-app notification to the member. The notification is best-effort: the
   * decision is already committed, so a flaky notifier is logged and never
   * rolls it back (same contract as
   * `AdminCommunityTagRequestsService.resolve`).
   */
  async update(
    id: string,
    dto: UpdateAdminDsarDto,
    operatorUserId: string,
  ): Promise<AdminDsarRequestDTO> {
    const request = await this.dsarRequests.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException('DSAR request not found');
    }

    const nextStatus: DsarStatus = dto.status;
    if (!ALLOWED_TRANSITIONS[request.status].includes(nextStatus)) {
      throw new ConflictException(
        `A DSAR that is ${request.status} cannot be moved to ${nextStatus}.`,
      );
    }

    const outcomeNote = dto.outcomeNote?.trim() ?? '';
    if (isTerminal(nextStatus) && !outcomeNote) {
      throw new BadRequestException(
        'Closing a data-subject request needs an outcome note saying what was done.',
      );
    }

    const now = new Date();
    request.status = nextStatus;
    if (outcomeNote) {
      request.outcomeNote = outcomeNote;
    }
    if (isTerminal(nextStatus)) {
      request.respondedAt = now;
      request.resolvedByUserId = operatorUserId;
    }
    const saved = await this.dsarRequests.save(request);

    if (isTerminal(nextStatus)) {
      await this.notifyMember(saved.userId, nextStatus, saved.reference);
    }

    const refsByUserId = await this.membersFor([saved]);
    return toAdminDsarRequestDTO(
      saved,
      refsByUserId.get(saved.userId) ?? null,
      now,
    );
  }

  /**
   * Tell the member their request reached an outcome, in the ONE channel this
   * platform has: an in-app QueerPulse notification. No email is sent, and the
   * member-facing copy no longer promises one.
   *
   * Uses the dedicated `DsarResolved` type. It used to borrow `ConcernUpdate`,
   * which meant a member who had exercised a statutory data right read "The
   * concern you raised has been reviewed and resolved" in their bell — a
   * different promise about a different thing, and no way to tell which of
   * their requests it was about.
   *
   * The payload carries the member's own case `reference` (the same string the
   * data-request page lists in their history) so the row is matchable to what
   * they filed, and `status` covers BOTH terminal outcomes: `resolved` and
   * `rejected`, each with its own copy. No `actorId`: an operator's decision is
   * the platform's word, so block/mute must not suppress it.
   */
  private async notifyMember(
    userId: string,
    status: AdminDsarTargetStatus,
    reference: string,
  ): Promise<void> {
    try {
      await this.notifications.create(userId, NotificationType.DsarResolved, {
        source: 'account_dsar',
        status: status === DsarStatus.Resolved ? 'resolved' : 'rejected',
        reference,
      });
    } catch (error) {
      this.logger.error(
        `DSAR ${reference} moved to ${status} but notifying the member ` +
          `failed: ${String(error)}`,
      );
    }
  }

  /** One batched profile lookup for a whole page of rows, never one per row. */
  private membersFor(rows: DsarRequest[]): Promise<Map<string, MemberRef>> {
    const userIds = [...new Set(rows.map((row) => row.userId))];
    return new MemberLookup(this.profiles).byUserIds(userIds);
  }
}
