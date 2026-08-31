import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { EntityManager, In, Repository } from 'typeorm';
import { Profile } from './entities/profile.entity';
import { User, UserRole, UserStatus } from './entities/user.entity';
import { Handle, HandleOwnerKind } from '../handles/entities/handle.entity';
import { handleWriteError } from '../handles/handles.service';
import { CURRENT_GUIDELINES_VERSION } from '../consent/policy-versions';

// Bounds the slug-collision retry loop (see insertProfileWithUniqueSlug). This
// caps CONCURRENT contention only — each retry recomputes the next slug from the
// current max, so it is NOT a ceiling on how many same-named members can exist.
// It would only be exhausted by this many sign-ups racing the exact same base
// slug in the same instant.
const MAX_SLUG_ATTEMPTS = 5;

/**
 * Longest base slug a sign-up builds before the collision suffix is appended.
 *
 * `HANDLE_RE` in `common/handles.ts` caps a handle at 30 characters, and every
 * candidate produced below is either the base itself or `base-<n>`. Holding the
 * base at 24 leaves six characters for `-99999`, so a hundred thousand members
 * could share one base name before a candidate reached the cap. A longer Google
 * display name is truncated rather than refused, because sign-up has nowhere to
 * send a person whose legal name happens to be long.
 */
const SIGNUP_HANDLE_BASE_MAX_LENGTH = 24;

/**
 * Base slug for a display name that survives slugification as nothing at all
 * (a name written entirely in a script `slugify` strips, say). Deliberately the
 * singular `member`: the plural `members` is a reserved route name, so a
 * fallback built on it would be withheld from every account that needed it.
 */
const SIGNUP_HANDLE_FALLBACK_BASE = 'member';

/**
 * How long a counted "N active members" figure is trusted.
 *
 * `countActiveMembers` is a `COUNT(*)` over `users` with no index on `status`,
 * and the public, unauthenticated `GET /invites/:code` runs it on every resolve
 * to render "join N members". At 20 requests/min/IP that was a sequential scan
 * of the whole table per request, growing linearly with the community.
 *
 * A minute of staleness is invisible on every surface that reads it: an invite
 * landing page, the press kit, the admin overview, and governance quorum math
 * (which is a threshold, not an exact tally). If a surface ever needs the
 * to-the-second number, it should count for itself rather than shortening this.
 */
const ACTIVE_MEMBER_COUNT_TTL_MS = 60_000;

/**
 * The community-guidelines revision a member agrees to when they finish
 * onboarding. It is the ONLY value `markOnboarded` ever writes to
 * `users.guidelines_version`; the request body has no say in it (ENG-23, and
 * see the essay on that method).
 *
 * DECLARED IN `consent/policy-versions.ts` and merely re-exported here, so that
 * every policy revision (Terms, Guidelines, Privacy) lives in one file instead
 * of three that can drift — see the essay in that file (ID-14). This re-export
 * keeps every existing importer (`PlatformStatusController`, `markOnboarded`,
 * the specs) working unchanged, and the frontend still reads the live value off
 * `GET /platform-status` rather than hardcoding its own copy.
 *
 * (Imported at the top of the file as well as re-exported here, because
 * `markOnboarded` below reads it — a bare `export … from` would re-publish the
 * name without binding it in this module's scope.)
 */
export { CURRENT_GUIDELINES_VERSION };

/**
 * The versions a policy acceptance stamped onto a member, plus what they had on
 * file immediately before it — the half `recordPolicyAcceptance` overwrites, and
 * the half `policy_acceptance` preserves.
 */
export interface PolicyAcceptanceStamp {
  termsVersion: string;
  guidelinesVersion: string;
  previousTermsVersion: string | null;
  previousGuidelinesVersion: string | null;
  acceptedAt: Date;
}

/** The outcome of `markOnboarded` — the effective onboarding + guidelines
 *  agreement stamps for the member. */
export interface OnboardingResult {
  onboardedAt: Date;
  guidelinesAcceptedAt: Date;
  guidelinesVersion: string;
}

export interface CreateGoogleUserInput {
  googleId: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
}

@Injectable()
export class UsersService {
  /** Backing store for `countActiveMembers`'s TTL cache. */
  private cachedActiveMemberCount: number | null = null;
  private cachedActiveMemberCountAt = 0;

  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
  ) {}

  // Sign-in lookup for a returning member. `addSelect('user.email')` re-includes
  // the `select: false` email column (see User.email) because the caller mints
  // an access token from the returned row, and the token embeds the email claim.
  findByGoogleId(googleId: string): Promise<User | null> {
    return this.usersRepo
      .createQueryBuilder('user')
      .addSelect('user.email')
      .where('user.googleId = :googleId', { googleId })
      .getOne();
  }

  /**
   * WHICH account already holds this verified Google address, if any? Signup
   * looks a returning member up by `googleId`; a MISS there with the same email
   * still happens (a re-created Workspace account presenting a new Google
   * subject, a seeded fixture, the documented HOUSE_EMAIL collision), and the
   * insert then violates the `email` unique constraint. `AuthService` checks
   * this first so that case becomes a sign-in error page instead of a raw 500
   * landing mid-OAuth-redirect.
   *
   * Returns the OWNER'S ID rather than a bare boolean (it was `existsByEmail`
   * until PRD-06). The colliding account is exactly the account that a
   * re-created Google identity is trying to get back into, so `AuthService`
   * records an `identity_relink_candidates` row against it before rejecting the
   * sign-in. That row is the ONLY thing the admin re-link lever will act on, so
   * this id is what makes locked-out members recoverable without a hand-written
   * UPDATE against production.
   *
   * Selects only the id: the caller never needs the row, and `email` stays
   * `select: false` everywhere it is not explicitly needed.
   */
  async findIdByEmail(email: string): Promise<string | null> {
    const found = await this.usersRepo
      .createQueryBuilder('user')
      .select('user.id')
      .where('user.email = :email', { email })
      .getOne();
    return found?.id ?? null;
  }

  findById(id: string): Promise<User | null> {
    return this.usersRepo.findOne({ where: { id } });
  }

  // Like `findById`, but re-includes the `select: false` email column — for the
  // token-refresh path, which re-mints an access token (with its email claim)
  // from a freshly loaded row. Ordinary `findById` deliberately omits email so
  // the PII stays unloaded everywhere that does not explicitly need it.
  findByIdWithEmail(id: string): Promise<User | null> {
    return this.usersRepo
      .createQueryBuilder('user')
      .addSelect('user.email')
      .where('user.id = :id', { id })
      .getOne();
  }

  findByIdWithProfile(id: string): Promise<User | null> {
    return this.usersRepo.findOne({
      where: { id },
      relations: { profile: true },
    });
  }

  // Batch variant of `findByIdWithProfile` for list views that need several
  // users at once (e.g. the "who accepted" column on a member's sent-invites
  // list). ONE query with `IN (...)`, avoiding an N+1 per row. Order is not
  // guaranteed, so callers should index the result by id. An empty input
  // short-circuits without hitting the DB.
  findByIdsWithProfile(ids: string[]): Promise<User[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.usersRepo.find({
      where: { id: In(ids) },
      relations: { profile: true },
    });
  }

  /**
   * Stamp the member as having finished the post-signup onboarding wizard, and
   * record their agreement to the community guidelines (the checkbox on the
   * welcome step) in the same act. Idempotent and monotonic: the FIRST
   * completion wins and is never overwritten, so a member who replays the wizard
   * (or whose second finish races the first) keeps their original stamps.
   * Returns the effective onboarding + guidelines stamps. The caller is always
   * the authenticated member (JwtStrategy has already confirmed the row exists),
   * so a missing row is treated as a no-op stamp rather than an error.
   *
   * The guidelines revision written here is ALWAYS the server's
   * `CURRENT_GUIDELINES_VERSION`, and never a version string carried on the
   * request body (ENG-23). `users.guidelines_version` is evidence: it is the
   * column an audit reads to answer "which revision of the community guidelines
   * did this member actually agree to". A string the caller invented answers
   * that question with whatever the caller felt like sending. A member cannot
   * have agreed to a revision the platform never published, and a client must
   * not be able to pin its own record to one. This is the rule
   * `PolicyAcceptanceService.accept` already follows, which is why that endpoint
   * takes no body at all.
   *
   * The wizard shows the revision it read from `GET /platform-status`, which is
   * this same constant, so the displayed version and the stored version agree in
   * every honest case. If a bump lands between the render and the click, the
   * member is recorded against the newer one and the wizard does not re-open,
   * matching how the re-acceptance sheet resolves the same race.
   *
   * `_opts` is accepted and deliberately discarded. `CompleteOnboardingDto`
   * still declares `guidelinesVersion` and the frontend still sends it (the
   * value it read from `GET /platform-status`), so the field has to keep
   * existing and keep validating: the global `ValidationPipe` runs with
   * `forbidNonWhitelisted`, so deleting it from the DTO would turn every
   * onboarding POST from a client that still sends it into a 400 and strand
   * members on the last wizard step. The field is therefore accepted, length
   * checked, and then ignored in favour of the constant. The `_` prefix is this
   * codebase's marker for an argument a signature must keep and a body has no
   * use for.
   */
  async markOnboarded(
    id: string,
    _opts: { guidelinesVersion?: string | null } = {},
  ): Promise<OnboardingResult> {
    const existing = await this.usersRepo.findOne({
      where: { id },
      select: {
        id: true,
        onboardedAt: true,
        guidelinesAcceptedAt: true,
        guidelinesVersion: true,
      },
    });
    if (existing?.onboardedAt) {
      // Already onboarded — return the stamps on record. `guidelinesAcceptedAt`
      // may be NULL for a member onboarded before this consent was captured
      // (never backfilled); fall back to `onboardedAt`/the current version so
      // the caller always gets a concrete answer.
      return {
        onboardedAt: existing.onboardedAt,
        guidelinesAcceptedAt:
          existing.guidelinesAcceptedAt ?? existing.onboardedAt,
        guidelinesVersion:
          existing.guidelinesVersion ?? CURRENT_GUIDELINES_VERSION,
      };
    }
    const now = new Date();
    await this.usersRepo.update(
      { id },
      {
        onboardedAt: now,
        guidelinesAcceptedAt: now,
        guidelinesVersion: CURRENT_GUIDELINES_VERSION,
      },
    );
    return {
      onboardedAt: now,
      guidelinesAcceptedAt: now,
      guidelinesVersion: CURRENT_GUIDELINES_VERSION,
    };
  }

  /**
   * Advance the member's stored policy revisions to the ones now in effect,
   * because they just agreed to them in the re-acceptance sheet (ID-14).
   *
   * The counterpart to `markOnboarded`, and deliberately the OPPOSITE of it in
   * one respect: `markOnboarded` is monotonic and first-write-wins, because
   * finishing onboarding happens once. Agreeing to the policies happens again
   * every time they materially change, so this OVERWRITES. Both columns move
   * together and `guidelinesAcceptedAt` is re-stamped, so "when did they last
   * agree to anything" stays answerable from the user row alone.
   *
   * `termsVersion` is the same column the 18+ attestation writes at signup. That
   * is correct rather than a collision: it has always meant "the Terms revision
   * this member has agreed to", and re-acceptance is exactly that act happening
   * again. The revision they attested against originally is not lost — it comes
   * back as `previousTermsVersion` and is written to the append-only
   * `policy_acceptance` row by `PolicyAcceptanceService`. `ageAttestedAt` is
   * never touched: they are not re-attesting their age, only re-agreeing to the
   * document.
   *
   * Returns the before/after pair. A missing row (impossible in practice — the
   * caller is the authenticated member) reports the new versions with no prior.
   *
   * `manager` lets a caller run the read and the overwrite inside its own
   * transaction. `PolicyAcceptanceService.accept` passes one so this stamp and
   * the `policy_acceptance` evidence row commit together: a stamp that moved
   * forward with no ledger row behind it would silently stop the re-acceptance
   * gate from ever re-prompting, which is the one failure nothing surfaces.
   * Omitted, it runs on the default connection as before.
   */
  async recordPolicyAcceptance(
    id: string,
    versions: { termsVersion: string; guidelinesVersion: string },
    manager?: EntityManager,
  ): Promise<PolicyAcceptanceStamp> {
    const usersRepo = manager ? manager.getRepository(User) : this.usersRepo;
    const existing = await usersRepo.findOne({
      where: { id },
      select: { id: true, termsVersion: true, guidelinesVersion: true },
    });
    const acceptedAt = new Date();
    await usersRepo.update(
      { id },
      {
        termsVersion: versions.termsVersion,
        guidelinesVersion: versions.guidelinesVersion,
        guidelinesAcceptedAt: acceptedAt,
      },
    );
    return {
      termsVersion: versions.termsVersion,
      guidelinesVersion: versions.guidelinesVersion,
      previousTermsVersion: existing?.termsVersion ?? null,
      previousGuidelinesVersion: existing?.guidelinesVersion ?? null,
      acceptedAt,
    };
  }

  /**
   * Current community size — active members only (suspended/deactivated
   * excluded). Cached for `ACTIVE_MEMBER_COUNT_TTL_MS`; see that constant for
   * why, and why the staleness is acceptable.
   *
   * In-process cache, like `PlatformSettingsService.get`. The app is
   * single-replica (enforced at boot by the REPLICA_COUNT check in
   * env.validation.ts), so there is no cross-process copy to invalidate.
   */
  async countActiveMembers(): Promise<number> {
    const now = Date.now();
    if (
      this.cachedActiveMemberCount !== null &&
      now - this.cachedActiveMemberCountAt < ACTIVE_MEMBER_COUNT_TTL_MS
    ) {
      return this.cachedActiveMemberCount;
    }
    const count = await this.usersRepo.count({
      where: { status: UserStatus.Active },
    });
    this.cachedActiveMemberCount = count;
    this.cachedActiveMemberCountAt = now;
    return count;
  }

  // NOTE: `promoteToActive` used to live here. It has been removed along with
  // `UserStatus.Pending` — with no pending state there is nothing to promote
  // FROM. A member is created `Active` in a single step by `createGoogleUser`
  // once their invite validates at sign-up.

  async createGoogleUser(
    manager: EntityManager,
    input: CreateGoogleUserInput & {
      status?: UserStatus;
      invitedBy?: string | null;
      ageAttestedAt?: Date | null;
      termsVersion?: string | null;
      isSystem?: boolean;
    },
  ): Promise<User> {
    const status = input.status ?? UserStatus.Active;
    const user = manager.create(User, {
      googleId: input.googleId,
      email: input.email,
      status,
      activatedAt: status === UserStatus.Active ? new Date() : null,
      ageAttestedAt: input.ageAttestedAt ?? null,
      termsVersion: input.termsVersion ?? null,
      isSystem: input.isSystem ?? false,
      ...(input.invitedBy
        ? { invitedBy: { id: input.invitedBy } as User }
        : {}),
    });
    const saved = await manager.save(user);

    // A `users.is_system` sign-up is the platform creating its own account, and
    // it is the ONE case allowed to keep a reserved name: the genesis bootstrap
    // creates the house account as "QueerPulse", whose slug `queerpulse` is in
    // the impersonation group that `common/handles.ts` withholds from everyone
    // else. Read off the same flag the row itself is stamped with, so an account
    // can only hold a reserved handle while it is genuinely a system account.
    const isSystemOwnedSignup = input.isSystem === true;
    const base = this.handleBaseForSignup(
      `${input.firstName} ${input.lastName}`,
    );
    const slug = await this.nextAvailableSlug(
      manager,
      base,
      isSystemOwnedSignup,
    );
    await this.insertProfileWithUniqueSlug(
      manager,
      saved.id,
      base,
      slug,
      input,
      isSystemOwnedSignup,
    );

    return saved;
  }

  // Inserts the profile, retrying with a bumped suffix if the slug collides on
  // insert (a 23505 the exists-check above raced past). Each attempt runs in a
  // SAVEPOINT (nested transaction) so a collision rolls back only this insert,
  // not the surrounding sign-up transaction.
  private async insertProfileWithUniqueSlug(
    manager: EntityManager,
    userId: string,
    base: string,
    slug: string,
    input: CreateGoogleUserInput,
    isSystemOwnedSignup: boolean,
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await manager.transaction(async (m) => {
          const profile = m.create(Profile, {
            userId,
            slug,
            firstName: input.firstName,
            lastName: input.lastName,
            avatarUrl: input.avatarUrl ?? null,
          });
          await m.save(profile);
          // Register the profile's username in the ONE global handle namespace
          // within the SAME savepoint (design plan PART C / UC2), so a collision
          // on the `handles` PK raises 23505 and reuses the existing suffix
          // retry below. `insert` (not `save`) guarantees an INSERT — `save`
          // would UPDATE an existing row and silently steal another user's
          // handle instead of colliding.
          //
          // Deliberately a direct insert rather than `HandlesService.claim`.
          // `claim` translates that same 23505 into a `ConflictException`, so
          // routing through it would hide the one signal the retry above reads
          // and turn an ordinary same-name collision into a failed sign-up. Its
          // reclaim-cooldown branch throws for the same reason, which a person
          // arriving with a Google display name can do nothing about. The
          // namespace rule `claim` exists to enforce is applied instead where
          // sign-up can act on it: `nextAvailableSlug` below asks the same
          // `handleWriteError` and steps PAST a withheld name onto the next
          // suffix, so every row this method writes honours the reserved rule
          // while the collision retry and the SAVEPOINT semantics stay intact.
          await m.insert(Handle, {
            name: slug,
            ownerKind: HandleOwnerKind.Profile,
            userId,
          });
        });
        return;
      } catch (err) {
        if (isUniqueViolation(err) && attempt < MAX_SLUG_ATTEMPTS) {
          // A concurrent sign-up claimed `slug` between our query and this
          // insert. Recompute from the CURRENT max and retry, so only true
          // contention — never the count of same-named members — bounds us.
          slug = await this.nextAvailableSlug(
            manager,
            base,
            isSystemOwnedSignup,
          );
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Picks the next free slug for `base` by finding the highest suffix already
   * taken and adding 1: `base`, then `base-1`, `base-2`, and so on, so the Nth
   * "Tiago Costa" is `tiago-costa-(N-1)` regardless of how many already exist,
   * in a single query rather than probing one candidate at a time. Queries the
   * `handles` registry (not just `profiles`) because that is the ONE global
   * username namespace: a subprofile handle can occupy a suffix no profile
   * holds.
   *
   * A name the namespace withholds counts here exactly like a name somebody
   * already holds. Sign-up is the one write into `handles` that a person does
   * not drive by typing a name, so refusing them is not an option: a member
   * whose Google display name is "Support" has to come out of this with a
   * handle, and the only question is which one. Treating `support` as occupied
   * hands them `support-1` through machinery that already exists, and leaves
   * `@support` unclaimable by anyone who is not the platform, which is the
   * whole point of the impersonation group in `common/handles.ts`: a DM from
   * `@support` reads as an official one long before a reader thinks to look for
   * a staff badge.
   */
  private async nextAvailableSlug(
    manager: EntityManager,
    base: string,
    isSystemOwnedSignup: boolean,
  ): Promise<string> {
    const taken = await manager
      .getRepository(Handle)
      .createQueryBuilder('handle')
      .select('handle.name', 'name')
      .where('handle.name = :base', { base })
      .orWhere('handle.name LIKE :prefix', { prefix: `${base}-%` })
      .getRawMany<{ name: string }>();

    // `base` itself counts as suffix 0; `base-<n>` counts as <n>. `base` is
    // slugified to [a-z0-9-] only, so it is safe to embed in the regex as-is.
    const suffixOf = new RegExp(`^${base}-(\\d+)$`);

    // Whether the bare `base` may be written at all, asked of the namespace
    // itself so this path and `HandlesService.claim` cannot answer differently.
    // `isSystemOwnedClaim` waives the reserved rule for the house account and
    // nothing else; the format rule holds for every account, which is why a base
    // that came back too short (`handleBaseForSignup` has already capped the
    // long end) also starts the search at 0. Starting at 0 is precisely "treat
    // it as taken": the first candidate becomes `base-1`, and a `base-<n>` can
    // never itself be withheld, because every reserved name is a bare word with
    // no numeric tail.
    const baseWriteError = handleWriteError(base, {
      isSystemOwnedClaim: isSystemOwnedSignup,
    });
    let maxSuffix = baseWriteError === null ? -1 : 0; // -1 => `base` is free
    for (const { name } of taken) {
      if (name === base) {
        maxSuffix = Math.max(maxSuffix, 0);
        continue;
      }
      const match = suffixOf.exec(name);
      if (match) maxSuffix = Math.max(maxSuffix, Number(match[1]));
    }

    return maxSuffix < 0 ? base : `${base}-${maxSuffix + 1}`;
  }

  /**
   * The base slug a new member's handle is built from: their display name,
   * slugified, cut to `SIGNUP_HANDLE_BASE_MAX_LENGTH` and stripped of a
   * trailing dash the cut may have exposed, so the base is always a well-formed
   * handle prefix that leaves room for a suffix.
   *
   * Everything here is about sign-up having no second chance. `slugify` can
   * return something the namespace would reject: nothing at all for a name it
   * strips entirely, one or two characters for a short name, more than thirty
   * for a long one. Every one of those used to reach the registry unexamined.
   * The long end is fixed by truncation here and the empty end by
   * `SIGNUP_HANDLE_FALLBACK_BASE`; the short end is left to
   * `nextAvailableSlug`, which turns a two-character base into `al-1` and so
   * keeps the person's own name instead of replacing it with a generic one.
   *
   * `slugify` strips leading and trailing dashes, so a non-empty result starts
   * with an alphanumeric; truncating from the right and trimming dashes off the
   * tail cannot take that first character away, which is what makes the result
   * a legal handle prefix rather than merely a shorter string.
   */
  private handleBaseForSignup(displayName: string): string {
    const slug = this.slugify(displayName)
      .slice(0, SIGNUP_HANDLE_BASE_MAX_LENGTH)
      .replace(/-+$/, '');
    return slug || SIGNUP_HANDLE_FALLBACK_BASE;
  }

  private slugify(value: string): string {
    return value
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip accents
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Count of members currently holding the Admin role. The shared guard
   * behind "never leave the platform with zero admins" — used both by
   * `AdminMembersService.updateRole` (never demote the last admin) and by
   * `AccountService.deactivate` / `requestDeletion` (never let the last admin
   * lock themselves out via ordinary member settings).
   *
   * Takes the caller's transaction `manager` rather than this service's own
   * repository, so the count is read inside the same transaction as the write
   * it gates — a concurrent action against a different admin can't slip past
   * a stale count.
   */
  countAdmins(manager: EntityManager): Promise<number> {
    return manager.count(User, { where: { role: UserRole.Admin } });
  }
}
