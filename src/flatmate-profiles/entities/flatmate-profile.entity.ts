import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Whether the member wants a place (`seeking`) or has a room to fill
 * (`offering`). Mirrors the frontend's flatmate board type toggle. */
export enum FlatmateProfileType {
  Seeking = 'seeking',
  Offering = 'offering',
}

/**
 * Who is allowed to see a member's GDPR Art.9 special-category identity fields
 * (pronouns, gender identity, safe-space needs). `matches` = only members on the
 * opposite side of the board (a seeker sees an offerer's, and vice versa);
 * `hidden` = owner only. Only ever *widens* what an affirming match can see — it
 * never drives an exclusion filter (fair-housing).
 */
export enum IdentityVisibility {
  Public = 'public',
  Members = 'members',
  Matches = 'matches',
  Hidden = 'hidden',
}

/**
 * Optional shared-living preferences. Ordinary (non-special-category) data, so
 * not consent-gated — every key is optional and free-ish text. Feeds the
 * household-compatibility match factor.
 *
 * `outAtHome` USED to live here; it moved into the consent-gated
 * `FlatmateIdentityHousehold` below because being "out at home" can reveal
 * sexual orientation (CJEU C-184/20), which is Art.9 special-category.
 */
export interface FlatmateHouseholdNorms {
  smoking?: string;
  pets?: string;
  guests?: string;
  cleanliness?: string;
  sleepSchedule?: string;
  /** Noise tolerance (co-living questionnaire, P1.3). */
  noise?: string;
  /** Sharing vs. private preference (co-living questionnaire, P1.3). */
  sharing?: string;
}

/**
 * Consent-gated (GDPR Art.9) trans-affirming household prompts. Health-adjacent
 * (medication) and identity-adjacent (out-at-home, name privacy) data, so it is
 * stored/served under the SAME gate as the other special-category fields: only
 * while `specialCategoryConsentAt` is set AND the visibility check admits the
 * viewer. Every field is optional and framed as compatibility, never intrusion.
 */
export interface FlatmateIdentityHousehold {
  /** Whether the member is out at home (moved here from household norms). */
  outAtHome?: string;
  /** Comfort with sharing a bathroom, and any affirming preference. */
  bathroomComfort?: string;
  /** Whether post/deliveries should use a chosen name, not a legal one. */
  mailNamePrivacy?: string;
  /** Whether the household should be discreet about medication/health routines. */
  medicationPrivacy?: string;
}

/**
 * A member's flatmate profile. One per member (unique `ownerId`), published
 * immediately (no moderation status). Identity (name/avatar/member slug) is NOT
 * stored — it is hydrated from the member's `Profile` via `MemberLookup`.
 */
@Entity('flatmate_profiles')
export class FlatmateProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_flatmate_profiles_owner_id', { unique: true })
  @Column({ type: 'uuid' })
  ownerId!: string;

  @Index('UQ_flatmate_profiles_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  @Index('IDX_flatmate_profiles_type')
  @Column({
    type: 'enum',
    enum: FlatmateProfileType,
    enumName: 'flatmate_profiles_type_enum',
  })
  type!: FlatmateProfileType;

  @Column({ type: 'varchar', length: 60, default: '' })
  pronouns!: string;

  @Column({ type: 'varchar', length: 120, default: '' })
  neighbourhood!: string;

  // Seeker's max budget / offering's room rent (euros). Used for both the
  // budget filter and match scoring.
  @Column({ type: 'int' })
  budgetEuros!: number;

  @Column({ type: 'date', nullable: true })
  moveInFrom!: string | null;

  @Column({ type: 'boolean', default: false })
  flexibleTiming!: boolean;

  @Column({ type: 'text', default: '' })
  about!: string;

  @Column({ type: 'text', array: true, default: '{}' })
  lifestyleTags!: string[];

  // ── GDPR Art.9 special-category identity (opt-in, consent-gated) ──────────
  // These three fields are only ever served to a viewer the owner has permitted
  // AND only while `specialCategoryConsentAt` is set. Withdrawing consent clears
  // them. `pronouns` (above) is also part of this gated set.

  /** Free-ish self-described gender identity label. Never assigned, never used
   * as a filter — affirming display only. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  genderIdentity!: string | null;

  /** Affirming / values statements the member wants in a household, e.g.
   * `trans-inclusive-household`, `no-outing`, `affirming-flatmates`. Values, not
   * exclusions — no "trans-only" style filter is ever built from these. */
  @Column({ type: 'text', array: true, nullable: true })
  safeSpaceNeeds!: string[] | null;

  /** Ordinary shared-living preferences (not consent-gated). */
  @Column({ type: 'jsonb', nullable: true })
  householdNorms!: FlatmateHouseholdNorms | null;

  /** Consent-gated trans-affirming household prompts (Art.9). Only written while
   * consent is on the record; served only to a permitted viewer. Cleared when
   * consent is withdrawn, exactly like the other special-category fields. */
  @Column({ type: 'jsonb', nullable: true })
  identityHousehold!: FlatmateIdentityHousehold | null;

  /** Who may see the special-category fields. Defaults to the most private
   * still-useful audience (opposite-side matches). */
  @Column({ type: 'varchar', length: 20, nullable: true, default: 'matches' })
  identityVisibility!: IdentityVisibility | null;

  /** Stamped when the member grants explicit, purpose-scoped Art.9 consent.
   * `null` = no consent = the special-category fields are served to no one. */
  @Column({ type: 'timestamptz', nullable: true })
  specialCategoryConsentAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
