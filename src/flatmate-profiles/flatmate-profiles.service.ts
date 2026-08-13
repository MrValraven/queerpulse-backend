import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { MessagingService } from '../messaging/messaging.service';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { SayHelloDto } from './dto/say-hello.dto';
import { UpsertFlatmateProfileDto } from './dto/upsert-flatmate-profile.dto';
import {
  FlatmateProfile,
  IdentityVisibility,
} from './entities/flatmate-profile.entity';
import {
  FlatmateProfileDTO,
  toFlatmateProfileDTO,
} from './flatmate-profile-response';

const DEFAULT_GREETING =
  'Hi! I saw your flatmate profile on QueerPulse and wanted to say hello.';

/** Affirming line appended to a greeting when the sender opts to pre-share their
 * pronouns. Kept English here to match the (currently English-only) default
 * greeting; localizing BE-composed message bodies is a shared follow-up. */
const PRONOUN_PRESHARE_LINE = (pronouns: string) =>
  `By the way, my pronouns are ${pronouns}.`;

const OWNER_ID_UNIQUE_CONSTRAINT = 'UQ_flatmate_profiles_owner_id';

/**
 * A member's single flatmate profile. `PUT /mine` is an upsert (create-then-
 * replace); the profile is addressed publicly by its `slug`.
 */
@Injectable()
export class FlatmateProfilesService {
  constructor(
    @InjectRepository(FlatmateProfile)
    private readonly flatmates: Repository<FlatmateProfile>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly messaging: MessagingService,
    private readonly verification: VerificationService,
    private readonly affirmingPledge: AffirmingPledgeService,
  ) {}

  async upsertMine(
    ownerId: string,
    dto: UpsertFlatmateProfileDto,
  ): Promise<FlatmateProfileDTO> {
    // Baseline gate: publishing a flatmate profile means committing to the
    // LGBTQ+ affirming pledge (throws a typed AFFIRMING_PLEDGE_REQUIRED 403).
    await this.affirmingPledge.requireAccepted(ownerId);
    // Step-up gate: a publicly-browsable flatmate profile needs at least a
    // phone-verified account (throws a typed VERIFICATION_REQUIRED 403).
    await this.verification.requireLevel(ownerId, VerificationLevel.Phone);
    const existing = await this.flatmates.findOne({ where: { ownerId } });
    if (existing) {
      applyProfile(existing, dto);
      const saved = await this.flatmates.save(existing);
      return this.buildDTO(saved);
    }
    try {
      const saved = await this.createWithUniqueSlug(ownerId, dto);
      return this.buildDTO(saved);
    } catch (err) {
      // A concurrent first-upsert by the same owner can 23505 on the unique
      // ownerId index (not the slug). Treat that as a lost create-vs-create
      // race and fall back to updating the row the winner just inserted.
      if (isUniqueViolation(err, OWNER_ID_UNIQUE_CONSTRAINT)) {
        const raced = await this.flatmates.findOne({ where: { ownerId } });
        if (raced) {
          applyProfile(raced, dto);
          const saved = await this.flatmates.save(raced);
          return this.buildDTO(saved);
        }
      }
      throw err;
    }
  }

  async getMine(ownerId: string): Promise<FlatmateProfileDTO | null> {
    const profile = await this.flatmates.findOne({ where: { ownerId } });
    if (!profile) return null;
    return this.buildDTO(profile);
  }

  async deleteMine(ownerId: string): Promise<void> {
    const profile = await this.flatmates.findOne({ where: { ownerId } });
    // Idempotent: deleting when you have no profile is a no-op (still 204).
    if (profile) {
      await this.flatmates.remove(profile);
    }
  }

  async sayHello(
    slug: string,
    fromUserId: string,
    dto: SayHelloDto,
  ): Promise<{ conversationId: string; pronounsShared: boolean }> {
    const profile = await this.flatmates.findOne({ where: { slug } });
    if (!profile) {
      throw new NotFoundException('Flatmate profile not found');
    }
    if (profile.ownerId === fromUserId) {
      throw new BadRequestException('You cannot say hello to your own profile');
    }
    // Baseline gate: reaching out requires the affirming pledge.
    await this.affirmingPledge.requireAccepted(fromUserId);
    // Step-up gate: reaching out needs a phone-verified account.
    await this.verification.requireLevel(fromUserId, VerificationLevel.Phone);
    const greeting = dto.body?.trim() || DEFAULT_GREETING;

    // Opt-in pronoun pre-share (Art.9). We NEVER trust a pronoun from the wire —
    // the flag only ever surfaces the sender's OWN consent-stored pronoun, so a
    // client can't inject arbitrary special-category text or share on behalf of
    // someone else. `pronounsShared` reports whether it actually took effect.
    let pronounsShared = false;
    let body = greeting;
    if (dto.sharePronouns) {
      const pronouns = await this.resolveSharablePronouns(fromUserId);
      if (pronouns) {
        body = `${greeting}\n\n${PRONOUN_PRESHARE_LINE(pronouns)}`;
        pronounsShared = true;
      }
    }

    const { conversationId } = await this.messaging.deliverEnquiry(
      fromUserId,
      profile.ownerId,
      body,
    );
    return { conversationId, pronounsShared };
  }

  // --- internals ---

  /**
   * The sender's own pronoun, but ONLY when it is safe to reveal: it must be
   * stored under a live Art.9 consent (`specialCategoryConsentAt`) and be
   * non-empty. This is the same consent chokepoint that gates the profile's
   * special-category fields — pronoun pre-share never bypasses it. Returns
   * `null` (→ nothing appended, `pronounsShared: false`) when consent is absent,
   * withdrawn, or no pronoun is on record, so the FE can prompt to add one.
   */
  private async resolveSharablePronouns(
    userId: string,
  ): Promise<string | null> {
    const own = await this.flatmates.findOne({ where: { ownerId: userId } });
    if (!own || !own.specialCategoryConsentAt) return null;
    const pronouns = own.pronouns?.trim();
    return pronouns ? pronouns : null;
  }

  private async buildDTO(
    profile: FlatmateProfile,
  ): Promise<FlatmateProfileDTO> {
    const refs = await new MemberLookup(this.profiles).byUserIds([
      profile.ownerId,
    ]);
    const level = await this.verification.levelForUser(profile.ownerId);
    // matchScore is null on the owner's own view — it is only computed on the
    // member directory browse relative to the viewer's profile. The owner
    // always sees their own special-category fields + consent state.
    return toFlatmateProfileDTO(
      profile,
      refs.get(profile.ownerId) ?? null,
      null,
      { isOwner: true, viewerProfileType: null },
      level,
    );
  }

  /** Seeds the slug from the owner's display name (the profile has no name of
   * its own), then relies on the unique index as the 23505 backstop. */
  private async createWithUniqueSlug(
    ownerId: string,
    dto: UpsertFlatmateProfileDto,
  ): Promise<FlatmateProfile> {
    const owner = await this.profiles.findOne({ where: { userId: ownerId } });
    const base = slugify(
      `${owner?.firstName ?? ''} ${owner?.lastName ?? ''}`,
      'flatmate',
    );
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(base, (candidate) =>
        this.flatmates.exists({ where: { slug: candidate } }),
      );
      try {
        const created = this.flatmates.create({ ownerId, slug });
        applyProfile(created, dto);
        return await this.flatmates.save(created);
      } catch (err) {
        // A conflict on the owner-id unique index isn't a slug collision — a
        // new slug will never resolve it, so let it propagate to upsertMine,
        // which re-runs this as an update against the profile that won the
        // race.
        if (isUniqueViolation(err, OWNER_ID_UNIQUE_CONSTRAINT)) {
          throw err;
        }
        if (isUniqueViolation(err)) {
          if (attempt < MAX_ATTEMPTS) continue;
          throw new ConflictException(
            'Could not allocate a unique flatmate profile slug',
          );
        }
        throw err;
      }
    }
    throw new ConflictException(
      'Could not allocate a unique flatmate profile slug',
    );
  }
}

/** Writes the full desired state onto a profile entity (PUT semantics: every
 * optional field resets to its default when omitted).
 *
 * The special-category identity fields (`pronouns`, `genderIdentity`,
 * `safeSpaceNeeds`) are only written when `specialCategoryConsent` is `true`.
 * Otherwise this is a consent withdrawal: those fields and the stored consent
 * timestamp are cleared. `householdNorms` is ordinary data, always applied. */
function applyProfile(
  profile: FlatmateProfile,
  dto: UpsertFlatmateProfileDto,
): void {
  profile.type = dto.type;
  profile.neighbourhood = dto.neighbourhood ?? '';
  profile.budgetEuros = dto.budgetEuros;
  profile.moveInFrom = dto.moveInFrom ?? null;
  profile.flexibleTiming = dto.flexibleTiming ?? false;
  profile.about = dto.about ?? '';
  profile.lifestyleTags = dto.lifestyleTags ?? [];
  profile.identityVisibility =
    dto.identityVisibility ?? IdentityVisibility.Matches;
  profile.householdNorms = dto.householdNorms ?? null;

  if (dto.specialCategoryConsent) {
    // Stamp consent on first grant; keep the original timestamp on later edits.
    profile.specialCategoryConsentAt =
      profile.specialCategoryConsentAt ?? new Date();
    profile.pronouns = dto.pronouns ?? '';
    profile.genderIdentity = dto.genderIdentity ?? null;
    profile.safeSpaceNeeds = dto.safeSpaceNeeds ?? null;
    // Trans-affirming household prompts share the same Art.9 gate.
    profile.identityHousehold = dto.identityHousehold ?? null;
  } else {
    // No consent (or withdrawn): purge every special-category field.
    profile.specialCategoryConsentAt = null;
    profile.pronouns = '';
    profile.genderIdentity = null;
    profile.safeSpaceNeeds = null;
    profile.identityHousehold = null;
  }
}
