import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { MessagingService } from '../messaging/messaging.service';
import { Profile } from '../users/entities/profile.entity';
import { SayHelloDto } from './dto/say-hello.dto';
import { UpsertFlatmateProfileDto } from './dto/upsert-flatmate-profile.dto';
import { FlatmateProfile } from './entities/flatmate-profile.entity';
import {
  FlatmateProfileDTO,
  toFlatmateProfileDTO,
} from './flatmate-profile-response';

const DEFAULT_GREETING =
  'Hi! I saw your flatmate profile on QueerPulse and wanted to say hello.';

function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as {
    code?: string;
    constraint?: string;
    driverError?: { code?: string; constraint?: string };
  };
  const code = e?.code ?? e?.driverError?.code;
  if (code !== '23505') return false;
  if (!constraint) return true;
  return (
    e?.constraint === constraint || e?.driverError?.constraint === constraint
  );
}

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
  ) {}

  async upsertMine(
    ownerId: string,
    dto: UpsertFlatmateProfileDto,
  ): Promise<FlatmateProfileDTO> {
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
  ): Promise<{ conversationId: string }> {
    const profile = await this.flatmates.findOne({ where: { slug } });
    if (!profile) {
      throw new NotFoundException('Flatmate profile not found');
    }
    if (profile.ownerId === fromUserId) {
      throw new BadRequestException('You cannot say hello to your own profile');
    }
    const body = dto.body?.trim() || DEFAULT_GREETING;
    return this.messaging.deliverEnquiry(fromUserId, profile.ownerId, body);
  }

  // --- internals ---

  private async buildDTO(
    profile: FlatmateProfile,
  ): Promise<FlatmateProfileDTO> {
    const refs = await new MemberLookup(this.profiles).byUserIds([
      profile.ownerId,
    ]);
    // matchScore is null on the owner's own view — it is only computed on the
    // member directory browse relative to the viewer's profile.
    return toFlatmateProfileDTO(
      profile,
      refs.get(profile.ownerId) ?? null,
      null,
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
 * optional field resets to its default when omitted). */
function applyProfile(
  profile: FlatmateProfile,
  dto: UpsertFlatmateProfileDto,
): void {
  profile.type = dto.type;
  profile.pronouns = dto.pronouns ?? '';
  profile.neighbourhood = dto.neighbourhood ?? '';
  profile.budgetEuros = dto.budgetEuros;
  profile.moveInFrom = dto.moveInFrom ?? null;
  profile.flexibleTiming = dto.flexibleTiming ?? false;
  profile.about = dto.about ?? '';
  profile.lifestyleTags = dto.lifestyleTags ?? [];
}
