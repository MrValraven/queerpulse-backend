import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';
import { CompanyOpenRolesService } from '../jobs/company-open-roles.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { ReviewReplyNotifier } from '../submissions/review-reply-notifier.service';
import { actorFromLookup, presentActorIds } from '../common/nullable-actor';
import { MemberLookup, MemberRef, toMemberRef } from '../common/member-ref';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { JobCardDTO, JobCompanyRef } from '../jobs/job-response';
import { Profile } from '../users/entities/profile.entity';
import {
  CompanyCardDTO,
  CompanyDetailDTO,
  CompanyReviewAggregates,
  CompanyReviewDTO,
  computeReviewAggregates,
  EMPTY_REVIEW_AGGREGATES,
  toCompanyCard,
  toCompanyDetail,
  toCompanyReview,
} from './company-response';
import { CompanyReview } from './entities/company-review.entity';
import { CompanyTeamMember } from './entities/company-team-member.entity';
import {
  Company,
  CompanyHiringContact,
  CompanyInfoItem,
  CompanyValue,
  CompanyWorkItem,
} from './entities/company.entity';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';

// `imageUrl` is optional on the request shape (`CompanyWorkItemDto`) but
// non-nullable-and-required-to-be-`null`-or-`string` on the entity column —
// this is the input-side shape (structurally matches `CompanyWorkItemDto`);
// `normalizeWork` below bridges the two at the persistence boundary.
export interface CompanyWorkItemInput {
  label: string;
  imageUrl?: string;
}

// Postgres unique-violation SQLSTATE. TypeORM surfaces it either directly on
// the QueryFailedError or on the wrapped driverError depending on the path.
// Mirrors `CommunitiesService`'s identical helper (file-local there too, not
// shared/exported — kept consistent with that precedent).
export interface CreateCompanyInput {
  nameText: string;
  tagline: string;
  about: string;
  queerRun?: boolean;
  queerLed?: boolean;
  values?: CompanyValue[];
  info?: CompanyInfoItem[];
  team?: string[]; // member slugs -> seeded as `company_team_members` rows
  hiringContact?: CompanyHiringContact;
  work?: CompanyWorkItemInput[];
  handle?: string; // desired slug; defaults from nameText
}

/** Bridges `CompanyWorkItemInput`'s optional `imageUrl` to the entity
 * column's `string | null`. */
function normalizeWork(items?: CompanyWorkItemInput[]): CompanyWorkItem[] {
  return (items ?? []).map((w) => ({
    label: w.label,
    imageUrl: w.imageUrl ?? null,
  }));
}

// `handle` only ever applies at creation time (mirrors
// `UpdateCommunityInput`'s identical "handle ignored on patch" precedent).
// `team` is creation-time roster seeding too — there's no re-seed semantics
// in the spec's endpoint table for PATCH, so `update()` never reads it even
// though `UpdateCompanyDto` carries it (same precedent as
// `CommunitiesService.update` never reading `stewards`/`invites`).
export type UpdateCompanyInput = Partial<
  Omit<CreateCompanyInput, 'handle' | 'team'>
>;

export interface CompanyListQuery {
  page?: number;
}

export interface CreateReviewInput {
  title: string;
  stars: number;
  byline: string;
  body: string[];
}

/** An edit replaces the whole review, so it carries the same four fields the
 *  composer submitted. Deliberately no reply field: the employer's answer is a
 *  different person's part of the same row. */
export type UpdateReviewInput = CreateReviewInput;

export interface ReplyToReviewInput {
  text: string;
}

@Injectable()
export class CompaniesService {
  constructor(
    @InjectRepository(Company)
    private readonly companies: Repository<Company>,
    @InjectRepository(CompanyTeamMember)
    private readonly team: Repository<CompanyTeamMember>,
    @InjectRepository(CompanyReview)
    private readonly reviews: Repository<CompanyReview>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    // Open-role counts/lists for company cards + detail. Depends only on the
    // `Job` repository (via `CompanyOpenRolesModule`), never on `JobsService`,
    // so this direction of the old Companies <-> Jobs cycle is gone: no
    // `forwardRef` needed here (`JobsService` still injects `CompaniesService`,
    // but that edge is now one-directional).
    private readonly openRoles: CompanyOpenRolesService,
    // Read-only: a `hide_content`/`remove_content` takedown on a `company`
    // subject (keyed by the company slug — matching what the frontend report
    // control sends) withholds the company from every public read below.
    private readonly contentModeration: ContentModerationService,
    // The one shared "the subject of your review answered it" emit (PRD-48).
    // Companies must not grow their own notification type for this: the same
    // silence was being shipped once per vertical, which is the whole finding.
    private readonly reviewReplyNotifier: ReviewReplyNotifier,
  ) {}

  // A company is reported (and taken down) under the `company` subject code,
  // keyed by the company slug. A hidden OR removed company vanishes from the
  // public list/detail/reviews for everyone — this service is a public surface
  // with no per-viewer staff role, so (like the directory) a takedown withholds
  // it entirely rather than rendering a tombstone. The owner still manages it
  // through the owner-gated write routes, which don't re-check this state.
  private static readonly SUBJECT_TYPE = 'company';

  // A REVIEW (and, with it, the employer reply written under it) is reported
  // and taken down under the `review` code, keyed by the review's uuid — the
  // same code and the same shape the directory uses for its own reviews
  // (`DirectoryService.REVIEW_SUBJECT_TYPE`). One subject covers the pair on
  // purpose: an employer's reply read without the review it answers is not the
  // same statement, which is exactly the reasoning `ReportSubjectType.Review`
  // already records for listing reviews.
  //
  // A hidden OR removed review is dropped from every public read here and from
  // the star aggregate with it, so a taken-down review cannot go on scoring the
  // employer. This surface is public with no per-viewer staff role, so there is
  // no tombstone: it simply stops rendering.
  //
  // KNOWN GAP, deliberately not papered over here: `ReportSubjectType.Review`
  // resolves its moderator-queue excerpt through `LISTING_REVIEW_SQL` only, so
  // a report filed against a COMPANY review reaches the queue and is actionable
  // but shows no excerpt or author. Closing that is a `mergeSources` arm in
  // `moderation/report-subject-resolver.service.ts` (the `post` subject already
  // merges two tables this way); it is not a new taxonomy value, and inventing
  // one here would be exactly the curated-list-beside-a-taxonomy drift this
  // codebase has already paid for once.
  private static readonly REVIEW_SUBJECT_TYPE = 'review';

  async create(
    ownerId: string,
    dto: CreateCompanyInput,
  ): Promise<CompanyDetailDTO> {
    const saved = await this.createWithUniqueSlug(ownerId, dto);
    return this.buildDetail(saved, ownerId);
  }

  // The slug pre-check (`allocateUniqueSlug`) can lose a race to a concurrent
  // create landing between the read and this INSERT; the unique index on
  // `slug` is the real backstop and turns that race into a 23505. A 23505
  // aborts the whole transaction (Postgres poisons it on any statement
  // error), so the retry has to re-run the *entire* transaction with a
  // freshly recomputed slug, not just the failed insert. Mirrors
  // `CommunitiesService.createWithUniqueRef`'s retry loop.
  private async createWithUniqueSlug(
    ownerId: string,
    dto: CreateCompanyInput,
  ): Promise<Company> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(
        slugify(dto.handle ?? dto.nameText, 'company'),
        (s) => this.companies.exists({ where: { slug: s } }),
      );

      try {
        return await this.dataSource.transaction(async (manager) => {
          const companiesRepo = manager.getRepository(Company);
          const teamRepo = manager.getRepository(CompanyTeamMember);

          const teamUserIds = await this.resolveTeamUserIds(
            manager.getRepository(Profile),
            dto.team ?? [],
            ownerId,
          );

          const company = await companiesRepo.save(
            companiesRepo.create({
              slug,
              nameText: dto.nameText,
              tagline: dto.tagline,
              about: dto.about,
              queerRun: dto.queerRun ?? false,
              queerLed: dto.queerLed ?? false,
              // Forced false regardless of input — verification is
              // admin-only and isn't even a field on `CreateCompanyDto`.
              verified: false,
              values: dto.values ?? [],
              info: dto.info ?? [],
              teamCount: teamUserIds.size,
              hiringContact: dto.hiringContact ?? null,
              work: normalizeWork(dto.work),
              ownerId,
            }),
          );

          if (teamUserIds.size) {
            await teamRepo.save(
              [...teamUserIds].map((userId) =>
                teamRepo.create({ companyId: company.id, userId }),
              ),
            );
          }

          return company;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          if (attempt < MAX_ATTEMPTS) {
            // Lost the slug race — recompute and retry a fresh transaction
            // (the aborted one can't be resumed).
            continue;
          }
          throw new ConflictException(
            'Could not allocate a unique company slug',
          );
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns a saved company or throws above.
    throw new ConflictException('Could not allocate a unique company slug');
  }

  async list(query: CompanyListQuery): Promise<Paginated<CompanyCardDTO>> {
    const page = normalizePage(query.page);
    const qb = this.companies
      .createQueryBuilder('c')
      .orderBy('c.created_at', 'DESC');
    this.excludeModeratedCompanies(qb);

    return paginate(qb, page, async (rows) => {
      if (!rows.length) return [];
      const ids = rows.map((c) => c.id);
      const [aggregates, openRoleCounts] = await Promise.all([
        this.reviewAggregatesForMany(ids),
        this.openRoles.openRoleCountsForMany(ids),
      ]);
      return rows.map((c) =>
        toCompanyCard(
          c,
          aggregates.get(c.id) ?? EMPTY_REVIEW_AGGREGATES,
          openRoleCounts.get(c.id) ?? 0,
        ),
      );
    });
  }

  async getBySlug(slug: string, viewerId: string): Promise<CompanyDetailDTO> {
    const company = await this.loadOr404(slug);
    await this.assertNotModerated(slug);
    return this.buildDetail(company, viewerId);
  }

  async update(
    slug: string,
    userId: string,
    dto: UpdateCompanyInput,
  ): Promise<CompanyDetailDTO> {
    const company = await this.loadOr404(slug);
    if (company.ownerId !== userId) {
      throw new ForbiddenException('Only the owner can update this company');
    }

    // Runs BEFORE any mutation (`CompaniesController.update` is on
    // `SHARED_UPLOAD_HANDLERS`, so the interceptor's foreign-upload check is
    // exempted for this handler): a co-manager may re-save a work item whose
    // image a different collaborator uploaded, but may not point any work
    // item's image at a NEW upload that is not theirs. Each incoming per-item
    // image is compared against the full set of currently stored work-item
    // image keys, so a re-sent stored key passes while a brand-new foreign key
    // is refused.
    if (dto.work !== undefined) {
      const alreadyStoredWorkImageKeys = (company.work ?? []).map(
        (workItem) => workItem.imageUrl,
      );
      for (const incomingWorkItem of dto.work) {
        assertNoForeignUploadIntroduced(
          userId,
          incomingWorkItem.imageUrl,
          alreadyStoredWorkImageKeys,
        );
      }
    }

    Object.assign(company, {
      ...(dto.nameText !== undefined ? { nameText: dto.nameText } : {}),
      ...(dto.tagline !== undefined ? { tagline: dto.tagline } : {}),
      ...(dto.about !== undefined ? { about: dto.about } : {}),
      ...(dto.queerRun !== undefined ? { queerRun: dto.queerRun } : {}),
      ...(dto.queerLed !== undefined ? { queerLed: dto.queerLed } : {}),
      ...(dto.values !== undefined ? { values: dto.values } : {}),
      ...(dto.info !== undefined ? { info: dto.info } : {}),
      ...(dto.hiringContact !== undefined
        ? { hiringContact: dto.hiringContact }
        : {}),
      ...(dto.work !== undefined ? { work: normalizeWork(dto.work) } : {}),
    });

    const saved = await this.companies.save(company);
    return this.buildDetail(saved, userId);
  }

  async listReviews(
    slug: string,
    query: CompanyListQuery,
  ): Promise<Paginated<CompanyReviewDTO>> {
    const company = await this.loadOr404(slug);
    // A taken-down company's reviews are not publicly readable either — the
    // company itself has been withheld, so its sub-resources 404 too.
    await this.assertNotModerated(slug);
    const page = normalizePage(query.page);

    const qb = this.reviews
      .createQueryBuilder('r')
      .where('r.company_id = :companyId', { companyId: company.id })
      .orderBy('r.created_at', 'DESC');
    // In-query, so the paginated count and the page agree with each other.
    this.excludeModeratedReviews(qb, 'r.id');

    return paginate(qb, page, async (rows) => {
      if (!rows.length) return [];
      const refs = await new MemberLookup(this.profiles).byUserIds(
        presentActorIds(rows.map((r) => r.authorId)),
      );
      return rows.map((r) =>
        toCompanyReview(r, actorFromLookup(refs, r.authorId) ?? null),
      );
    });
  }

  // UNIQUE per (company, author) — a repeat review from the same member
  // surfaces as 23505, mapped to Conflict rather than a 500 (mirrors
  // `CommunitiesService.join`'s pending-request 23505 -> Conflict mapping).
  async createReview(
    slug: string,
    authorId: string,
    dto: CreateReviewInput,
  ): Promise<CompanyReviewDTO> {
    const company = await this.loadOr404(slug);
    await this.assertNotOwnCompany(company, authorId);

    try {
      const saved = await this.reviews.save(
        this.reviews.create({
          companyId: company.id,
          authorId,
          title: dto.title,
          stars: dto.stars,
          byline: dto.byline,
          body: dto.body,
        }),
      );
      const author = await this.memberRefFor(authorId);
      return toCompanyReview(saved, author);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('You have already reviewed this company');
      }
      throw err;
    }
  }

  /**
   * The EMPLOYER answers one review of them, in public. Posting again
   * overwrites the previous reply (idempotent update, never a thread).
   *
   * WHO. The company's owner, and nobody else. `companies.owner_id` is
   * nullable and NULL means the company profile is UNCLAIMED, so an unclaimed
   * company has no one who can speak for it and every reply attempt on it is
   * refused. That is the whole gate, and it is the honest one: a company is
   * claimed by being CREATED (`create()` writes the caller onto `ownerId`), and
   * there is no endpoint anywhere that transfers or claims an existing
   * company's ownership afterwards, so `ownerId` is either the member who made
   * the profile or NULL because that member's account was erased
   * (`SetNullContentAuthorFksOnUserErasure1794610000000`).
   *
   * DELIBERATE DEVIATION FROM THE DIRECTORY. `ListingsService.replyToReview` is
   * owner-OR-co-manager, because listings have a co-manager role. Companies
   * have no such role: `update()` — editing the public profile, which is a
   * strictly larger power than answering one review — is owner-only, and a
   * `company_team_members` row means "may post jobs under this company"
   * (`getCompanyForJobPosting`), not "may speak for it". So the reply follows
   * this module's own ownership rule rather than importing the directory's.
   *
   * WHICH IDENTIFIER, and the other deviation. The directory splits the two
   * writers across two namespaces: the owner replies through the owner-scoped
   * `ref`, the reviewer edits through the public `slug`. A company has ONE
   * identifier, its slug, so both writes are addressed by it and the two people
   * are separated by the gate instead: `ownerId === userId` here,
   * `authorId === userId` in `updateReview`. Two different people, editing two
   * different parts of one row.
   *
   * The review is looked up SCOPED TO THIS COMPANY, so a reply cannot be
   * attached to a review of somebody else's company via a guessed id.
   *
   * NOT gated on `assertNotModerated`, matching `update`/`createReview`: a
   * takedown of the company must not also silence its owner's management.
   */
  async replyToReview(
    slug: string,
    userId: string,
    reviewId: string,
    dto: ReplyToReviewInput,
  ): Promise<CompanyReviewDTO> {
    const company = await this.loadOr404(slug);
    if (!company.ownerId) {
      // Unclaimed. Deliberately a 403 and not a 404: the company plainly
      // exists (its page is public), so pretending otherwise would only
      // confuse. There is nobody entitled to reply, which is what this says.
      throw new ForbiddenException(
        'This company profile is unclaimed, so it has no owner who can reply',
      );
    }
    if (company.ownerId !== userId) {
      throw new ForbiddenException('Only the owner can reply to this review');
    }

    const review = await this.reviews.findOne({
      where: { id: reviewId, companyId: company.id },
    });
    if (!review) {
      throw new NotFoundException('Review not found');
    }

    // `@IsNotEmpty` rejects `""` but not `" "`. A whitespace-only reply trims
    // to `""`, and `toCompanyReview`'s truthy check on `ownerReplyText` would
    // then serialize `ownerReply: null` while a real `ownerRepliedAt` stranded
    // in the row: a reply that exists in the database and nowhere on screen.
    // Re-check post-trim (mirrors `ListingsService.replyToReview`).
    const text = dto.text.trim();
    if (!text) {
      throw new BadRequestException('Reply cannot be empty');
    }

    review.ownerReplyText = text;
    review.ownerRepliedAt = new Date();
    const saved = await this.reviews.save(review);

    // Tell the reviewer their employer answered them, through the ONE shared
    // notifier (PRD-48) rather than a company-specific notification type. Best
    // effort by that method's contract: it never throws, so the reply the
    // employer just wrote cannot fail on a bell failure. The self-reply and
    // missing-author guards live inside it, and the block/mute gate fires there
    // too, so a reviewer who has blocked this employer is not reached.
    //
    // NO DEEP LINK, on purpose. `SubmissionDeepLinkSource` has no `company`
    // member, so the notifier is called without a source, and the row reads as
    // an honest text-only line naming the employer instead of a link the client
    // would silently fail to build. Adding `company` there (plus the matching
    // `sourceHrefFromPayload` branch on the frontend) is what would let this row
    // point at the reviews tab.
    await this.reviewReplyNotifier.notifyReviewReplied({
      reviewAuthorId: saved.authorId,
      replyingSubjectId: userId,
      subjectLabel: company.nameText,
    });

    // The reply's author is the employer, but the returned row still represents
    // the REVIEWER, so resolve their profile to keep the DTO's author ref.
    const author = saved.authorId
      ? await this.memberRefOrNull(saved.authorId)
      : null;
    return toCompanyReview(saved, author);
  }

  /**
   * The REVIEW'S AUTHOR edits their own review.
   *
   * A member gets exactly one review per company (`UQ_company_reviews`).
   * Without an edit path that one review stood unchanged forever: a complaint
   * about a practice the employer has since fixed, a warm note about a team
   * that has since gone, a typo. The one-review rule is worth keeping, and this
   * is what makes it fair to keep. It matters more here than on a cafe, because
   * an employer review follows a real employment relationship that changes.
   *
   * Gated on being the AUTHOR, and 403 rather than 404 for somebody else's
   * review: a company review id is a uuid already published in the public
   * reviews payload, so there is no existence to protect and a 403 says what
   * actually happened.
   *
   * WHAT AN EDIT DOES TO THE EMPLOYER'S REPLY, which is the interesting case:
   *
   *  - The reply is KEPT, always, and both its text and `ownerRepliedAt` are
   *    untouched. Clearing it on edit would hand the reviewer a delete button
   *    for the employer's public response, usable by changing one character.
   *  - `editedAt` is stamped, and `isEditedAfterOwnerReply` goes true whenever
   *    it lands after `ownerRepliedAt`. Silence here is the real hazard:
   *    without it a reviewer could post something mild, collect a warm reply,
   *    then rewrite the review into an accusation, leaving the employer
   *    apparently replying agreeably to words they never saw. The page can now
   *    say the review changed after the reply, so a reader can weigh both.
   *  - Nothing is hidden and nothing is versioned. Publishing prior revisions
   *    of a review would mean republishing text a member has actively
   *    withdrawn, which on this platform is a worse failure than the ordering
   *    problem it would solve.
   *
   * The edit stamp is applied ONLY when something actually changed, so
   * re-saving an identical body cannot manufacture an "edited after the reply"
   * flag against an employer. A genuine one-character change still can, and
   * that is the honest reading: the review did change after the reply.
   *
   * The star aggregate needs no maintenance here, by design. Nothing on
   * `companies` is denormalized: `reviewAggregatesForMany` recomputes from the
   * review rows themselves, so changing `stars` on this row IS the aggregate
   * update and it cannot drift.
   */
  async updateReview(
    slug: string,
    reviewId: string,
    userId: string,
    dto: UpdateReviewInput,
  ): Promise<CompanyReviewDTO> {
    const company = await this.loadOr404(slug);
    const review = await this.reviews.findOne({
      where: { id: reviewId, companyId: company.id },
    });
    if (!review) {
      throw new NotFoundException('Review not found');
    }
    if (!review.authorId || review.authorId !== userId) {
      throw new ForbiddenException('You can only edit your own review');
    }

    const title = dto.title.trim();
    const byline = dto.byline.trim();
    // Blank paragraphs are dropped rather than stored: the composer submits an
    // array of paragraphs, and an empty one renders as a gap nobody typed.
    const body = dto.body.map((paragraph) => paragraph.trim()).filter(Boolean);
    if (!title || !body.length) {
      throw new BadRequestException('Review cannot be empty');
    }

    const isChanged =
      review.title !== title ||
      review.stars !== dto.stars ||
      review.byline !== byline ||
      review.body.length !== body.length ||
      review.body.some((paragraph, index) => paragraph !== body[index]);

    review.title = title;
    review.stars = dto.stars;
    review.byline = byline;
    review.body = body;
    // `ownerReplyText` / `ownerRepliedAt` are pointedly untouched. See above.
    if (isChanged) {
      review.editedAt = new Date();
    }
    const saved = await this.reviews.save(review);

    return toCompanyReview(saved, await this.memberRefOrNull(userId));
  }

  /**
   * BE-HSG-15: nobody reviews the company they run. The owner AND anyone on the
   * company's team are blocked, because both can speak for the company on its
   * own page. The `UQ_company_reviews (company_id, author_id)` constraint only
   * ever stopped the same person reviewing TWICE; it never stopped the first,
   * self-authored one, which counted toward the `reviewScore`/`reviewBars`
   * shown on every card. Mirrors the equivalent block on business listings
   * (`DirectoryService.addReview`).
   */
  private async assertNotOwnCompany(
    company: Company,
    authorId: string,
  ): Promise<void> {
    if (company.ownerId === authorId) {
      throw new ForbiddenException('You cannot review your own company');
    }
    const onTeam = await this.team.exists({
      where: { companyId: company.id, userId: authorId },
    });
    if (onTeam) {
      throw new ForbiddenException(
        'You cannot review a company you are on the team of',
      );
    }
  }

  // --- internals ---

  private async loadOr404(slug: string): Promise<Company> {
    const company = await this.companies.findOne({ where: { slug } });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company;
  }

  // Public reads treat a moderator takedown as a 404 — a hidden OR removed
  // company is withheld entirely (no tombstone on this surface). Deliberately
  // NOT called from the owner-gated write paths (`update`/`createReview`) so a
  // takedown never blocks the owner's own management, mirroring the directory.
  private async assertNotModerated(slug: string): Promise<void> {
    const state = await this.contentModeration.stateFor(
      CompaniesService.SUBJECT_TYPE,
      slug,
    );
    if (state.hidden || state.removed) {
      throw new NotFoundException('Company not found');
    }
  }

  // NOT EXISTS predicate dropping any company under a `company` takedown
  // (hidden OR removed) from a company query builder, in-query so the paginated
  // count stays consistent. Mirrors `DirectoryService.excludeModeratedListings`.
  private excludeModeratedCompanies(qb: SelectQueryBuilder<Company>): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "cm"
        WHERE "cm"."subject_type" = :companySubjectType
          AND "cm"."subject_id" = c.slug
          AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
      )`,
      { companySubjectType: CompaniesService.SUBJECT_TYPE },
    );
  }

  // NOT EXISTS predicate dropping any review under a `review` takedown (hidden
  // OR removed) from a review query builder, in-query so pagination AND the
  // star aggregate stay consistent with each other. `reviewIdColumn` is spliced
  // verbatim into raw SQL, so pass an actual column reference and never user
  // input; it is cast to text because `content_moderation.subject_id` is
  // varchar while a review id is uuid. Mirrors
  // `DirectoryService.excludeModeratedReviews`.
  private excludeModeratedReviews(
    qb: SelectQueryBuilder<CompanyReview>,
    reviewIdColumn: string,
  ): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "cmr"
        WHERE "cmr"."subject_type" = :reviewSubjectType
          AND "cmr"."subject_id" = ${reviewIdColumn}::text
          AND ("cmr"."hidden_at" IS NOT NULL OR "cmr"."removed_at" IS NOT NULL)
      )`,
      { reviewSubjectType: CompaniesService.REVIEW_SUBJECT_TYPE },
    );
  }

  // Resolves a userId to a `MemberRef`, or `null` when there is no profile
  // behind it. Used on the review write paths, where a missing profile must
  // degrade to an unattributed review rather than fail the write that already
  // committed — unlike `memberRefFor` below, whose caller is creating the row
  // and can still refuse.
  private async memberRefOrNull(userId: string): Promise<MemberRef | null> {
    const refs = await new MemberLookup(this.profiles).byUserIds([userId]);
    return refs.get(userId) ?? null;
  }

  // Resolves a single userId to a MemberRef for an actor who just created a
  // row (a miss here would mean a data-integrity bug — an authenticated
  // member without a profile — not a legitimate empty state). Mirrors
  // `CommunitiesService.memberRefFor`.
  private async memberRefFor(userId: string): Promise<MemberRef> {
    const refs = await new MemberLookup(this.profiles).byUserIds([userId]);
    const ref = refs.get(userId);
    if (!ref) {
      throw new NotFoundException('Member profile not found');
    }
    return ref;
  }

  private async resolveTeamUserIds(
    profilesRepo: Repository<Profile>,
    slugs: string[],
    ownerId: string,
  ): Promise<Set<string>> {
    if (!slugs.length) return new Set();

    const lookup = new MemberLookup(profilesRepo);
    const idBySlug = await lookup.userIdsForSlugs(slugs);
    const seen = new Set<string>([ownerId]);
    const result = new Set<string>();

    for (const s of slugs) {
      const uid = idBySlug.get(s);
      if (uid && !seen.has(uid)) {
        seen.add(uid);
        result.add(uid);
      }
    }
    return result;
  }

  private async buildDetail(
    company: Company,
    viewerId: string,
  ): Promise<CompanyDetailDTO> {
    const [aggregates, teamRows, ownerProfile, openRoles] = await Promise.all([
      this.reviewAggregatesFor(company.id),
      this.team.find({ where: { companyId: company.id } }),
      // `company.ownerId` is NULL once the owner's account is erased
      // (`SetNullContentAuthorFksOnUserErasure1794610000000`), which is an
      // unclaimed company profile rather than a missing one. Skip the lookup
      // and let the mapper serialize `owner: null`.
      company.ownerId === null
        ? null
        : this.profiles.findOne({ where: { userId: company.ownerId } }),
      this.getOpenRoles(company),
    ]);

    const teamRefs = teamRows.length
      ? await new MemberLookup(this.profiles).byUserIds(
          teamRows.map((t) => t.userId),
        )
      : new Map<string, MemberRef>();
    const team = teamRows
      .map((t) => teamRefs.get(t.userId))
      .filter((ref): ref is MemberRef => !!ref);

    return toCompanyDetail(
      company,
      aggregates,
      team,
      toMemberRef(ownerProfile),
      company.ownerId === viewerId,
      openRoles,
    );
  }

  private async reviewAggregatesFor(
    companyId: string,
  ): Promise<CompanyReviewAggregates> {
    const map = await this.reviewAggregatesForMany([companyId]);
    return map.get(companyId) ?? EMPTY_REVIEW_AGGREGATES;
  }

  // Grouped pattern (mirrors `CommunitiesService.statsForMany`): one query
  // across the whole page/id-set instead of N+1 per-row lookups.
  private async reviewAggregatesForMany(
    companyIds: string[],
  ): Promise<Map<string, CompanyReviewAggregates>> {
    const result = new Map<string, CompanyReviewAggregates>(
      companyIds.map((id) => [id, EMPTY_REVIEW_AGGREGATES]),
    );
    if (!companyIds.length) return result;

    const aggregateQb = this.reviews
      .createQueryBuilder('r')
      .select('r.company_id', 'companyId')
      .addSelect('r.stars', 'stars')
      .where('r.company_id IN (:...ids)', { ids: companyIds });
    // A review a moderator has taken down must stop scoring the employer too,
    // not just stop rendering. Filtered HERE rather than only in `listReviews`
    // so the star average, the histogram and the visible list are computed over
    // the same set of rows and cannot disagree.
    this.excludeModeratedReviews(aggregateQb, 'r.id');
    const rows = await aggregateQb.getRawMany<{
      companyId: string;
      stars: number | string;
    }>();

    const starsByCompany = new Map<string, number[]>(
      companyIds.map((id) => [id, []]),
    );
    for (const row of rows) {
      starsByCompany.get(row.companyId)?.push(Number(row.stars));
    }

    for (const [id, starsValues] of starsByCompany) {
      result.set(id, computeReviewAggregates(starsValues));
    }
    return result;
  }

  // Delegates to `CompanyOpenRolesService` (Job-repo only, no `JobsService`
  // dependency). We already hold the `Company` entity, so we pass its ref down
  // rather than have the open-roles service look the company up again — the
  // result is the same `JobCardDTO[]` for `CompanyDetailDTO.openRoles`.
  private async getOpenRoles(company: Company): Promise<JobCardDTO[]> {
    return this.openRoles.listForCompany(company.id, {
      slug: company.slug,
      nameText: company.nameText,
    });
  }

  // --- cross-domain accessors for JobsService ---
  // `JobsModule` never registers its own `Company`/`CompanyTeamMember`
  // repositories (see `.superpowers/sdd/spec-phaseB-companies-jobs.md`), so
  // it reaches company data only through these two methods on the already
  // circularly-wired `CompaniesService`.

  /**
   * Resolves a company by slug and confirms `userId` may post/manage jobs
   * under it — the owner or a `company_team_members` row. Returns `null`
   * when the slug doesn't exist (`JobsService` maps that to its own 404);
   * throws `ForbiddenException` when it exists but `userId` isn't
   * affiliated, keeping "what counts as affiliated" owned here rather than
   * duplicated in Jobs.
   */
  async getCompanyForJobPosting(
    slug: string,
    userId: string,
  ): Promise<(JobCompanyRef & { id: string }) | null> {
    const company = await this.companies.findOne({ where: { slug } });
    if (!company) return null;

    if (company.ownerId !== userId) {
      const isTeamMember = await this.team.exists({
        where: { companyId: company.id, userId },
      });
      if (!isTeamMember) {
        throw new ForbiddenException(
          'Only the company owner or team can post jobs for this company',
        );
      }
    }

    return { id: company.id, slug: company.slug, nameText: company.nameText };
  }

  /**
   * Batched company-id -> `{slug,nameText}` ref lookup (mirrors
   * `MemberLookup.byUserIds`'s shape) for `JobsService`'s list/detail views,
   * so a page of job cards resolves every embedded company ref in one query
   * instead of N+1.
   */
  async companyRefsByIds(
    companyIds: string[],
  ): Promise<Map<string, JobCompanyRef>> {
    const map = new Map<string, JobCompanyRef>();
    if (!companyIds.length) return map;

    const rows = await this.companies.find({
      where: { id: In(companyIds) },
      select: ['id', 'slug', 'nameText'],
    });
    for (const row of rows) {
      map.set(row.id, { slug: row.slug, nameText: row.nameText });
    }
    return map;
  }
}
