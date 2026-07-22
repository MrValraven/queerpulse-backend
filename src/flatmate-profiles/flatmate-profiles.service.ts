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
  "Hi! I saw your flatmate profile on QueerPulse and wanted to say hello.";

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } };
  return e?.code === '23505' || e?.driverError?.code === '23505';
}

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
    const saved = await this.createWithUniqueSlug(ownerId, dto);
    return this.buildDTO(saved);
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
    return toFlatmateProfileDTO(profile, refs.get(profile.ownerId) ?? null, null);
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
