import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { isUniqueViolation } from '../common/db-errors';
import { In, IsNull, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import {
  optionalQueueAssigneeName,
  setQueueAssignment,
} from '../common/queue-assignment';
import {
  DEFAULT_LIST_LIMIT,
  normalizePage,
  paginate,
  Paginated,
} from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { SubmissionDecisionNotifier } from '../submissions/submission-decision-notifier.service';
import {
  SubmissionKind,
  SubmissionOutcome,
} from '../submissions/submission-kinds';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import { toStoredPlainText } from '../communities/community-plain-text';
import { partnerApplicationDueAt } from './partner-application-sla';
import {
  toStoredAtGlance,
  toStoredJointWork,
  toStoredLines,
  toStoredPartnerContact,
  toStoredSections,
  toStoredStats,
  toStoredTimeline,
} from './partner-plain-text';
import {
  MyPartnerApplicationDTO,
  OwnedPartnerDTO,
  PartnerApplicationDTO,
  PartnerCardDTO,
  PartnerDetailDTO,
  toMyPartnerApplication,
  toOwnedPartner,
  toPartnerApplication,
  toPartnerCard,
  toPartnerDetail,
} from './partner-response';
import {
  Partner,
  PartnerAtGlance,
  PartnerContact,
  PartnerJointWork,
  PartnerRegion,
  PartnerSection,
  PartnerStat,
  PartnerStatus,
  PartnerTimelineItem,
} from './entities/partner.entity';

// Postgres unique-violation SQLSTATE. Mirrors `CompaniesService`'s/
// `VolunteeringService`'s identical file-local helper (not shared/exported,
// kept consistent with that precedent).
/** `CreatePartnerApplicationDto.contact`'s shape at the service boundary —
 * every subfield optional on input, always normalized to `PartnerContact`
 * (`string | null`, never omitted) before it's persisted. */
export interface PartnerContactInput {
  phone?: string;
  phoneNote?: string;
  email?: string;
  website?: string;
  address?: string;
}

export interface CreatePartnerApplicationInput {
  name: string;
  logo: string;
  region: PartnerRegion;
  regionLabel: string;
  city: string;
  desc: string;
  tags?: string[];
  tier: string;
  since: string;
  eyebrow: string;
  tagline: string;
  about?: string[];
  stats?: PartnerStat[];
  aboutMore?: PartnerSection[];
  jointWork?: PartnerJointWork[];
  timeline?: PartnerTimelineItem[];
  how?: PartnerSection[];
  funding?: string;
  atGlance?: PartnerAtGlance[];
  contact?: PartnerContactInput;
  // Desired slug; `createWithUniqueSlug` slugifies + de-dupes it, defaulting
  // to `name` when omitted (mirrors `CreateCompanyInput.handle`).
  handle?: string;
}

export interface PartnerListQuery {
  region?: PartnerRegion;
  page?: number;
  featured?: boolean;
}

/**
 * The fields a partner may change about ITSELF (PRD-263). See
 * `UpdatePartnerProfileDto` for the reasoning behind where the line falls.
 */
export interface UpdatePartnerProfileInput {
  region?: PartnerRegion;
  regionLabel?: string;
  city?: string;
  desc?: string;
  tagline?: string;
  logo?: string;
  tags?: string[];
  about?: string[];
  stats?: PartnerStat[];
  aboutMore?: PartnerSection[];
  jointWork?: PartnerJointWork[];
  timeline?: PartnerTimelineItem[];
  how?: PartnerSection[];
  funding?: string;
  atGlance?: PartnerAtGlance[];
  contact?: PartnerContactInput;
}

/** Everything a partner may change, plus the fields that are QueerPulse's to
 *  set: the relationship claims (`tier`, `since`, `eyebrow`), the approved
 *  identity (`name`), and the marketing surface (`featured` + testimonial). */
export interface UpdatePartnerAdminInput extends UpdatePartnerProfileInput {
  name?: string;
  tier?: string;
  since?: string;
  eyebrow?: string;
  featured?: boolean;
  testimonialQuote?: string | null;
  testimonialAuthor?: string | null;
  testimonialRole?: string | null;
}

/** Bridges `PartnerContactInput`'s optional subfields to the entity column's
 * fully-populated `string | null` shape (mirrors `CompaniesService`'s
 * `normalizeWork`/`VolunteeringService`'s `normalizeDetail`). */
function normalizeContact(contact?: PartnerContactInput): PartnerContact {
  return toStoredPartnerContact({
    phone: contact?.phone ?? null,
    phoneNote: contact?.phoneNote ?? null,
    email: contact?.email ?? null,
    website: contact?.website ?? null,
    address: contact?.address ?? null,
  });
}

/**
 * Copy the profile fields a caller actually sent onto the row, stripping
 * markup on the way in (PRD-263).
 *
 * ONE write boundary, shared by the two paths that can reach these columns
 * (the partner's own editor and the staff console), so a value cannot be
 * laundered through whichever one was forgotten. `toStoredPlainText` and its
 * per-shape wrappers live in `partner-plain-text.ts`; the reasoning for
 * stripping here rather than at the render sites is the repo-wide one in
 * `communities/community-plain-text.ts`.
 *
 * `undefined` means "not sent" and leaves the column alone (PATCH). `contact`
 * is the deliberate exception: it is one jsonb document that the service keeps
 * fully populated, so sending it replaces the whole block.
 */
/** `toStoredPlainText` for a nullable column: a value that strips to nothing
 *  is stored as NULL rather than as an empty string every read site then has
 *  to treat as empty anyway (same rule as `toStoredPlainTextOrNull`). */
function toStoredNullableText(value: string | null): string | null {
  if (value === null) return null;
  const stored = toStoredPlainText(value);
  return stored.length ? stored : null;
}

function applyProfileFields(
  partner: Partner,
  input: UpdatePartnerProfileInput,
): void {
  if (input.region !== undefined) partner.region = input.region;
  if (input.regionLabel !== undefined) {
    partner.regionLabel = toStoredPlainText(input.regionLabel);
  }
  if (input.city !== undefined) partner.city = toStoredPlainText(input.city);
  if (input.desc !== undefined) partner.desc = toStoredPlainText(input.desc);
  if (input.tagline !== undefined) {
    partner.tagline = toStoredPlainText(input.tagline);
  }
  if (input.logo !== undefined) partner.logo = toStoredPlainText(input.logo);
  if (input.tags !== undefined) partner.tags = toStoredLines(input.tags);
  if (input.about !== undefined) partner.about = toStoredLines(input.about);
  if (input.stats !== undefined) partner.stats = toStoredStats(input.stats);
  if (input.aboutMore !== undefined) {
    partner.aboutMore = toStoredSections(input.aboutMore);
  }
  if (input.jointWork !== undefined) {
    partner.jointWork = toStoredJointWork(input.jointWork);
  }
  if (input.timeline !== undefined) {
    partner.timeline = toStoredTimeline(input.timeline);
  }
  if (input.how !== undefined) partner.how = toStoredSections(input.how);
  if (input.funding !== undefined) {
    partner.funding = toStoredPlainText(input.funding);
  }
  if (input.atGlance !== undefined) {
    partner.atGlance = toStoredAtGlance(input.atGlance);
  }
  if (input.contact !== undefined) {
    partner.contact = normalizeContact(input.contact);
  }
}

@Injectable()
export class PartnersService {
  constructor(
    @InjectRepository(Partner) private readonly partners: Repository<Partner>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    // PRD-37. The shared intake primitive (PRD-48), not a hand-rolled
    // notification: partner applications are one of the three black holes it
    // was built to close, and `SubmissionKind.PartnerApplication` already
    // exists there with its copy shipped in both languages.
    private readonly submissionDecisions: SubmissionDecisionNotifier,
    private readonly adminQueueNotifications: AdminQueueNotificationsService,
  ) {}

  // Public directory: approved partners only, optionally filtered by region.
  async list(query: PartnerListQuery): Promise<Paginated<PartnerCardDTO>> {
    const page = normalizePage(query.page);
    const qb = this.partners
      .createQueryBuilder('p')
      .where('p.status = :status', { status: PartnerStatus.Approved })
      .orderBy('p.created_at', 'DESC');

    if (query.region) {
      qb.andWhere('p.region = :region', { region: query.region });
    }

    if (query.featured) {
      qb.andWhere('p.featured = :featured', { featured: true });
    }

    return paginate(qb, page, (rows) => rows.map(toPartnerCard));
  }

  // 404s for anything non-approved — hides pending/rejected partners'
  // existence from the public rather than surfacing a distinct "not visible
  // yet" response (mirrors the spec's "404 for non-approved to the public").
  async getBySlug(slug: string): Promise<PartnerDetailDTO> {
    const partner = await this.partners.findOne({ where: { slug } });
    if (!partner || partner.status !== PartnerStatus.Approved) {
      throw new NotFoundException('Partner not found');
    }
    return toPartnerDetail(partner);
  }

  async submitApplication(
    memberId: string,
    dto: CreatePartnerApplicationInput,
  ): Promise<PartnerApplicationDTO> {
    const saved = await this.createWithUniqueSlug(memberId, dto);
    // Tell whoever works the partner-application queue that an application
    // landed. Awaited, but safe to await: `announce` catches everything
    // internally, so a notification failure can never fail the submission.
    await this.adminQueueNotifications.announce(
      AdminQueueKey.PartnerApplications,
      saved.id,
    );
    return this.buildApplication(saved);
  }

  /**
   * The caller's OWN partner applications, with their current status and, when
   * a decision has been made, when (PRD-37).
   *
   * Until this existed an organisation could apply, be approved or rejected,
   * and never find out: nothing notified them and no route would tell them.
   * This is the durable half of the fix — the notification is the nudge, this
   * is the place the answer stays. It is scoped by `submittedById` alone, so
   * it can only ever return rows the caller created.
   *
   * Hand-mapped to `MyPartnerApplicationDTO`, which is a much smaller shape
   * than the admin queue's `PartnerApplicationDTO`; see that interface for
   * exactly what is withheld and why.
   *
   * ORDERED `created_at DESC, id DESC`. The `created_at` tiebreak matters:
   * two applications submitted in the same millisecond would otherwise come
   * back in an order Postgres is free to change between calls, which would
   * make a paginated or diffed client show a row twice or not at all. The `id`
   * is unique, so the pair is a total order.
   */
  async listMine(memberId: string): Promise<MyPartnerApplicationDTO[]> {
    const rows = await this.partners.find({
      where: { submittedById: memberId },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return rows.map(toMyPartnerApplication);
  }

  /**
   * Admin queue: pending applications awaiting triage.
   *
   * `assignedTo` is OPS-04's "Assigned to me" narrowing, the same closed set
   * the join-request and verification queues take: a caller's own id (resolved
   * from the session by the controller, so the wire never carries a
   * reviewer's id) or the literal `'unassigned'`. Narrowing here rather than
   * in the browser keeps the answer honest against `DEFAULT_LIST_LIMIT`: a
   * client-side filter would silently omit claimed rows that fell off the end
   * of the page.
   */
  async listApplications(
    options: {
      /** A user id narrows to that reviewer's claimed applications; the
       *  literal `'unassigned'` narrows to the rows nobody has picked up.
       *  Typed as a plain `string` because the literal is a member of it. */
      assignedTo?: string;
    } = {},
  ): Promise<PartnerApplicationDTO[]> {
    const rows = await this.partners.find({
      where: {
        status: PartnerStatus.Pending,
        ...(options.assignedTo === 'unassigned'
          ? { assignedStaffId: IsNull() }
          : options.assignedTo
            ? { assignedStaffId: options.assignedTo }
            : {}),
      },
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    if (!rows.length) return [];
    return this.buildApplications(rows);
  }

  // Admin: every APPROVED partner, newest first — the editable directory for
  // setting featured/testimonial (unlike listApplications, which is the
  // pending-triage queue). Returns the full application shape so the admin UI
  // has each partner's id + featured + testimonial.
  async listApproved(): Promise<PartnerApplicationDTO[]> {
    const rows = await this.partners.find({
      where: { status: PartnerStatus.Approved },
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    if (!rows.length) return [];
    return this.buildApplications(rows);
  }

  /**
   * `approve` publishes the partner into the public directory; `reject`
   * records the admin's `note` as `reviewNote`. Mirrors the spec's endpoint
   * table verbatim: approve only flips `status`, reject flips `status` AND
   * sets `reviewNote` — an approval note isn't part of the contract.
   *
   * Both are TERMINAL: `pending` is the only open state, and approved and
   * rejected are the two ways an application ends. Landing on either for the
   * first time stamps `decidedAt` and tells the applicant (PRD-37).
   *
   * A re-triage to the status the row ALREADY holds is a no-op for both of
   * those. It still saves, because a repeated `reject` may be carrying a
   * corrected review note and that behaviour predates this change, but it
   * does not restamp `decidedAt` and it does not notify. That is what stops a
   * double-click, a retried request or a note edit from telling the same
   * organisation twice that it was rejected.
   */
  async triage(
    id: string,
    action: 'approve' | 'reject',
    note?: string,
    // The admin making the decision. Used only to avoid notifying somebody
    // about their own action (an admin who applied on behalf of their own
    // organisation), the same guard `notifyReporterOfOutcomeBestEffort` uses.
    actorId?: string,
  ): Promise<PartnerApplicationDTO> {
    const partner = await this.partners.findOne({ where: { id } });
    if (!partner) {
      throw new NotFoundException('Partner application not found');
    }

    const decidedStatus =
      action === 'approve' ? PartnerStatus.Approved : PartnerStatus.Rejected;
    const isNewDecision = partner.status !== decidedStatus;

    partner.status = decidedStatus;
    if (action === 'reject') {
      partner.reviewNote = note ?? null;
    }
    if (isNewDecision) {
      partner.decidedAt = new Date();
    }

    // PRD-263. Approval is the moment a row stops being an application and
    // becomes a public profile somebody has to keep true, so it is also the
    // moment the profile gets an owner: the member who applied.
    //
    // `??=`, never a plain assignment. A partner refused once, re-triaged and
    // then approved may already have had its seat moved to somebody else by
    // staff, and a second approve must not silently hand it back to the
    // original applicant. Refusal deliberately leaves the column alone: a
    // rejected row has no public profile to maintain.
    if (action === 'approve') {
      partner.ownerUserId ??= partner.submittedById;
    }

    const saved = await this.partners.save(partner);
    if (isNewDecision) {
      await this.notifyApplicantOfDecisionBestEffort(saved, actorId);
    }
    return this.buildApplication(saved);
  }

  /**
   * Claim or release one partner application (OPS-04).
   *
   * Mirrors `ModerationService.setAssignment`, including the property that
   * makes it safe when two people claim at once: a conditional UPDATE guarded
   * on the assignment this caller read, so the loser gets a 409 rather than
   * quietly taking the row. Additionally guarded on the row still being
   * `pending`, because a pending row IS the open application here — an
   * approved partner is a directory entry, not a queue item.
   *
   * `isAdmin` is the account TIER, not the `partnerships` staff grant: a
   * delegated partnerships reviewer claims and releases their own rows like
   * anyone else, while a platform admin can break a hold left by someone who
   * has gone, exactly as in the moderation queue.
   */
  async setApplicationAssignment(
    id: string,
    actorId: string,
    actorRole: string,
    assign: boolean,
  ): Promise<PartnerApplicationDTO> {
    const partner = await this.partners.findOne({ where: { id } });
    if (!partner) {
      throw new NotFoundException('Partner application not found');
    }

    await setQueueAssignment({
      repository: this.partners,
      id,
      currentAssigneeId: partner.assignedStaffId,
      actorId,
      // `actorRole` is a JWT claim, typed `string` on `CurrentUserData`.
      isAdmin: actorRole === (UserRole.Admin as string),
      assign,
      rowLabel: 'partner application',
      claimableStatuses: {
        column: 'status',
        values: [PartnerStatus.Pending],
      },
    });

    const saved = await this.partners.findOne({ where: { id } });
    if (!saved) {
      throw new NotFoundException('Partner application not found');
    }
    return this.buildApplication(saved);
  }

  /**
   * Staff edit of an approved partner (PRD-263).
   *
   * Was the featured flag and the testimonial and nothing else, which is why
   * `tier`, `since` and `eyebrow` were frozen at whatever the application form
   * defaulted them to and every partner in the directory showed the same tier.
   * It now reaches the whole profile: everything the partner itself may change
   * (`applyProfileFields`, one shared write boundary that strips markup) plus
   * the four things that are QueerPulse's to say rather than the partner's.
   *
   * Only the provided fields change (PATCH). A quote with no author is
   * rejected — the For Organisations card renders "<quote> — <author>, <role>"
   * and a dangling quote would print an orphaned dash.
   */
  async updateAdminFields(
    id: string,
    dto: UpdatePartnerAdminInput,
  ): Promise<PartnerApplicationDTO> {
    const partner = await this.partners.findOne({ where: { id } });
    if (!partner) {
      throw new NotFoundException('Partner not found');
    }

    applyProfileFields(partner, dto);
    // The slug is NOT recomputed from a new name: it is the address every
    // inbound link, every volunteering opportunity's `partnerSlug` and every
    // share already uses, and silently moving a live public page is a worse
    // outcome than a slug that no longer matches the display name.
    if (dto.name !== undefined) partner.name = toStoredPlainText(dto.name);
    if (dto.tier !== undefined) partner.tier = toStoredPlainText(dto.tier);
    if (dto.since !== undefined) partner.since = toStoredPlainText(dto.since);
    if (dto.eyebrow !== undefined) {
      partner.eyebrow = toStoredPlainText(dto.eyebrow);
    }
    if (dto.featured !== undefined) partner.featured = dto.featured;
    if (dto.testimonialQuote !== undefined)
      partner.testimonialQuote = toStoredNullableText(dto.testimonialQuote);
    if (dto.testimonialAuthor !== undefined)
      partner.testimonialAuthor = toStoredNullableText(dto.testimonialAuthor);
    if (dto.testimonialRole !== undefined)
      partner.testimonialRole = toStoredNullableText(dto.testimonialRole);

    if (partner.testimonialQuote && !partner.testimonialAuthor) {
      throw new ConflictException('A testimonial quote requires an author');
    }

    const saved = await this.partners.save(partner);
    return this.buildApplication(saved);
  }

  /**
   * The partner profiles this member MAINTAINS (PRD-263).
   *
   * Scoped by `ownerUserId` alone, so it can only ever return rows this caller
   * is the owner of — the session decides, never the wire. An approved partner
   * whose owning account was erased has `owner_user_id = NULL` (the FK is
   * `ON DELETE SET NULL`) and correctly belongs to nobody: it comes back for
   * no one and stays staff-editable until staff move the seat.
   *
   * Returns a list rather than a single row because one member can genuinely
   * run two organisations, and because a member who runs none must get an
   * empty list rather than a 404 the editor would have to special-case.
   */
  async listOwned(memberId: string): Promise<OwnedPartnerDTO[]> {
    const rows = await this.partners.find({
      where: { ownerUserId: memberId, status: PartnerStatus.Approved },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return rows.map(toOwnedPartner);
  }

  /**
   * A partner editing its OWN public profile (PRD-263).
   *
   * WHAT IT CAN REACH is decided by the type, not by a runtime check:
   * `UpdatePartnerProfileInput` simply has no `tier`, `since`, `eyebrow`,
   * `name`, `featured` or testimonial field, and the global validation pipe
   * runs `forbidNonWhitelisted`, so sending one is a 400 rather than a
   * silently ignored key. Nothing here needs re-review: every field is a fact
   * about the organisation that the organisation is the only reliable source
   * for, and a stale phone number on a public support page is a worse failure
   * than a partner mistyping its own address.
   *
   * THREE REFUSALS, deliberately different:
   *  - unknown id -> 404;
   *  - a real partner this member does not own -> 404 as well, not 403. A 403
   *    would confirm that a given id exists, which is exactly what the public
   *    `getBySlug` refuses to do for non-approved rows;
   *  - a partner they own that is no longer approved -> 403, because there is
   *    nothing to hide (they already know the row) and "you cannot edit this
   *    while it is not published" is the honest answer.
   */
  async updateOwnedProfile(
    memberId: string,
    id: string,
    dto: UpdatePartnerProfileInput,
  ): Promise<OwnedPartnerDTO> {
    const partner = await this.partners.findOne({ where: { id } });
    if (!partner || partner.ownerUserId !== memberId) {
      throw new NotFoundException('Partner not found');
    }
    if (partner.status !== PartnerStatus.Approved) {
      throw new ForbiddenException(
        'Only an approved partner profile can be edited',
      );
    }

    applyProfileFields(partner, dto);
    const saved = await this.partners.save(partner);
    return toOwnedPartner(saved);
  }

  // --- cross-domain accessors for VolunteeringService ---
  // `VolunteeringModule` never registers its own `Partner` repository (mirrors
  // `JobsModule` never registering `Company`/`CompanyTeamMember` — see
  // `.superpowers/sdd/spec-phaseB-companies-jobs.md`), so it reaches partner
  // data only through these two methods on the already-imported
  // `PartnersService`.

  /**
   * Resolves ANY partner (regardless of `status`) by slug to its id — used by
   * `VolunteeringService` to link an opportunity to a partner org. Unlike the
   * public `getBySlug`, this doesn't gate on `status === approved`: an
   * opportunity poster may reference a partner application that hasn't been
   * reviewed yet. Returns `null` for an unknown slug (never throws — the
   * caller treats "unresolved" the same as "no partner").
   */
  async idBySlug(slug: string): Promise<string | null> {
    const partner = await this.partners.findOne({ where: { slug } });
    return partner?.id ?? null;
  }

  /**
   * Batched partner-id -> `{slug,name}` ref lookup (mirrors
   * `CompaniesService.companyRefsByIds`'s shape) for `VolunteeringService`'s
   * list/detail views, so a page of opportunity cards resolves every
   * embedded partner ref in one query instead of N+1. Not status-gated, for
   * the same reason as `idBySlug`.
   */
  async refsByIds(
    ids: string[],
  ): Promise<Map<string, { slug: string; name: string }>> {
    const map = new Map<string, { slug: string; name: string }>();
    if (!ids.length) return map;

    const rows = await this.partners.find({
      where: { id: In(ids) },
      select: ['id', 'slug', 'name'],
    });
    for (const row of rows) {
      map.set(row.id, { slug: row.slug, name: row.name });
    }
    return map;
  }

  // --- internals ---

  /**
   * Tell the organisation that applied what was decided (PRD-37).
   *
   * This is the half of the finding that could not be fixed by adding a route:
   * before it, an application was approved or rejected and absolutely nothing
   * reached the person who submitted it, on a form that promised they would
   * hear back.
   *
   * MAPPING. `approved` -> `Accepted`, `rejected` -> `Declined`. Both are real
   * verdicts here: a partner application is only ever settled by a human in the
   * triage console who read it and decided, so neither is `Archived`, which
   * exists for a submission closed with nobody having weighed it. Pending is
   * the only non-terminal status, and it never reaches this method.
   *
   * THE NOTE RIDES ALONG ONLY ON A REFUSAL. `reviewNote` is written only by a
   * reject (`triage`), and `PRD-48` decided on the record that this kind's note
   * IS delivered, because the bell is the applicant's only channel and a
   * refusal with the reason withheld is a refusal with no reason. On an
   * approval it is passed as null rather than as whatever the column happens to
   * hold, so an application rejected once and later approved cannot mail the
   * old refusal out attached to the good news.
   *
   * BEST EFFORT, POST-COMMIT. Called after `save()` has returned, and wrapped
   * even though `SubmissionDecisionNotifier.notifyDecided` documents itself as
   * never throwing: the decision has already committed and the admin's request
   * must not fail because the bell did, and this call site should not have to
   * be re-audited if that guarantee ever changes. The same shape as
   * `ModerationService.notifyReporterOfOutcomeBestEffort`.
   */
  private async notifyApplicantOfDecisionBestEffort(
    partner: Partner,
    actorId?: string,
  ): Promise<void> {
    // An admin who applied on behalf of their own organisation and then decided
    // it themselves is not told about their own click.
    if (!partner.submittedById || partner.submittedById === actorId) return;
    const isRejected = partner.status === PartnerStatus.Rejected;
    try {
      await this.submissionDecisions.notifyDecided({
        recipientId: partner.submittedById,
        kind: SubmissionKind.PartnerApplication,
        outcome: isRejected
          ? SubmissionOutcome.Declined
          : SubmissionOutcome.Accepted,
        // The organisation's own name, so the row says WHICH application.
        subjectLabel: partner.name,
        reviewNote: isRejected ? partner.reviewNote : null,
      });
    } catch {
      // Intentionally ignored — the decision already committed.
    }
  }

  // The slug pre-check (`allocateUniqueSlug`) can lose a race to a concurrent
  // submission landing between the read and this INSERT; the unique index on
  // `slug` is the real backstop and turns that race into a 23505, forcing a
  // retry with a freshly recomputed slug (mirrors
  // `CompaniesService.createWithUniqueSlug`/
  // `VolunteeringService.createWithUniqueSlug`). No child rows are seeded
  // alongside a partner (unlike companies' team / volunteering's team), so
  // there's no need for `DataSource.transaction` here — a single `save()`
  // retry is enough.
  private async createWithUniqueSlug(
    memberId: string,
    dto: CreatePartnerApplicationInput,
  ): Promise<Partner> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(
        slugify(dto.handle ?? dto.name, 'partner'),
        (s) => this.partners.exists({ where: { slug: s } }),
      );

      try {
        return await this.partners.save(
          this.partners.create({
            slug,
            // Every free-text field is stripped of markup HERE, on the way in
            // (PRD-263), for the same reason the edit paths are: these strings
            // land verbatim on two `@Public()` pages, and the write boundary
            // is the one place that catches a crafted API call as well as the
            // form. `email`/`website` inside `contact` are left alone by
            // `normalizeContact` — their own validators already constrain them.
            name: toStoredPlainText(dto.name),
            logo: toStoredPlainText(dto.logo),
            region: dto.region,
            regionLabel: toStoredPlainText(dto.regionLabel),
            city: toStoredPlainText(dto.city),
            desc: toStoredPlainText(dto.desc),
            tags: toStoredLines(dto.tags ?? []),
            tier: toStoredPlainText(dto.tier),
            since: toStoredPlainText(dto.since),
            eyebrow: toStoredPlainText(dto.eyebrow),
            tagline: toStoredPlainText(dto.tagline),
            about: toStoredLines(dto.about ?? []),
            stats: toStoredStats(dto.stats ?? []),
            aboutMore: toStoredSections(dto.aboutMore ?? []),
            jointWork: toStoredJointWork(dto.jointWork ?? []),
            timeline: toStoredTimeline(dto.timeline ?? []),
            how: toStoredSections(dto.how ?? []),
            funding: toStoredPlainText(dto.funding ?? ''),
            atGlance: toStoredAtGlance(dto.atGlance ?? []),
            contact: normalizeContact(dto.contact),
            status: PartnerStatus.Pending,
            // A pending application has no public profile to maintain, so it
            // has no owner. `triage` stamps one on approval.
            ownerUserId: null,
            submittedById: memberId,
            reviewNote: null,
            // OPS-04. Stamped once, from the single window in
            // `partner-application-sla.ts`. Fourteen days is slow and honest;
            // the point is that six weeks now goes red.
            dueAt: partnerApplicationDueAt(new Date()),
          }),
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          if (attempt < MAX_ATTEMPTS) {
            // Lost the slug race — recompute and retry.
            continue;
          }
          throw new ConflictException(
            'Could not allocate a unique partner slug',
          );
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns a saved partner or throws above.
    throw new ConflictException('Could not allocate a unique partner slug');
  }

  private async buildApplication(
    partner: Partner,
  ): Promise<PartnerApplicationDTO> {
    const refs = await new MemberLookup(this.profiles).byUserIds(
      partnerRefUserIds([partner]),
    );
    return toPartnerApplication(
      partner,
      refs.get(partner.submittedById) ?? null,
      optionalQueueAssigneeName(partner.assignedStaffId, refs),
    );
  }

  private async buildApplications(
    partners: Partner[],
  ): Promise<PartnerApplicationDTO[]> {
    const refs = await new MemberLookup(this.profiles).byUserIds(
      partnerRefUserIds(partners),
    );
    return partners.map((partner) =>
      toPartnerApplication(
        partner,
        refs.get(partner.submittedById) ?? null,
        optionalQueueAssigneeName(partner.assignedStaffId, refs),
      ),
    );
  }
}

/** Every user id a page of applications needs a display name for: the member
 *  who applied, plus whoever is holding the row (OPS-04). One list, so the
 *  page stays ONE profile query. */
function partnerRefUserIds(partners: Partner[]): string[] {
  return [
    ...new Set([
      ...partners.map((partner) => partner.submittedById),
      ...partners
        .map((partner) => partner.assignedStaffId)
        .filter((id): id is string => id !== null),
    ]),
  ];
}
