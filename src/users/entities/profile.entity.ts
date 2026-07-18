import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import { OpenToEntry } from '../../profiles/open-to';

export enum ProfileVisibility {
  Open = 'open',
  Network = 'network',
  Private = 'private',
}

@Entity('profiles')
export class Profile {
  // user_id is BOTH the primary key and the FK to users (1:1).
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @OneToOne(() => User, (user) => user.profile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', unique: true })
  slug: string;

  @Column({ type: 'varchar' })
  firstName: string;

  @Column({ type: 'varchar' })
  lastName: string;

  @Column({ type: 'varchar', nullable: true })
  pronouns: string | null;

  @Column({ type: 'varchar', nullable: true })
  tagline: string | null;

  @Column({ type: 'text', nullable: true })
  bio: string | null;

  @Column({ type: 'varchar', nullable: true })
  location: string | null;

  @Column({ type: 'varchar', nullable: true })
  avatarUrl: string | null;

  @Column({
    type: 'enum',
    enum: ProfileVisibility,
    enumName: 'profiles_visibility_enum',
    default: ProfileVisibility.Open,
  })
  visibility: ProfileVisibility;

  // Availability chips — a preset/custom union stored verbatim as jsonb so the
  // member's chip order and their exact custom wording both survive a
  // round-trip. See src/profiles/open-to.ts for the shared vocabulary.
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  openTo: OpenToEntry[];

  // Private Settings → Interests preferences — never shown on the public profile,
  // only returned to the owner (see toFullProfile). Distinct from the public
  // `openTo` blurbs.
  @Column({ type: 'text', array: true, default: '{}' })
  identities: string[];

  // The subset of `identities` the member has explicitly PUBLISHED for
  // member-directory discovery — same vocabulary, opt-in per identity, empty by
  // default. This is the ONLY identity column the directory may filter on
  // (`GET /members?identities=`); `identities` above stays private.
  //
  // A DB CHECK constraint (`CHK_profiles_discoverable_subset`) enforces
  // `discoverable_identities <@ identities`, so un-declaring a private identity
  // MUST un-publish it in the same write — see `ProfilesService.updateMe` and
  // `pruneDiscoverable` in src/profiles/identities.ts.
  @Column({ type: 'text', array: true, default: '{}' })
  discoverableIdentities: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  lookingFor: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  tags: string[];

  @Column({ type: 'boolean', default: false })
  verified: boolean;

  @Column({ type: 'text', nullable: true })
  now: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  joinedAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
