import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

// Phase 1 only ever writes `Community`. `Collective` exists so the Phase 2
// collectives work is a data change rather than a schema change.
export enum CardIssuerType {
  Community = 'community',
  Collective = 'collective',
}

// How a member's photo is printed on the card. 'mono' desaturates it, which
// is a decision the ISSUING community makes about other people's faces — the
// member's own control stays the veto on `MembershipCard.isPhotoHidden`.
export type CardPhotoStyle = 'color' | 'mono';

export const CARD_PHOTO_STYLES: readonly CardPhotoStyle[] = [
  'color',
  'mono',
] as const;

// How a card with a flag or a photo ground keeps its own text readable. Not a
// choice about WHETHER the text is protected — a card must be readable at a
// door, so every value here protects it — only about which treatment suits
// the ground the community picked.
//
// 'shade' is the top-and-bottom gradient every ground has carried so far.
// 'panel' plates the two text blocks instead and leaves the rest of the
// artwork untouched, which is what a busy illustration needs. 'veil' dims the
// whole card evenly, for a ground with detail everywhere.
export type CardTextBackdrop = 'shade' | 'panel' | 'veil';

export const CARD_TEXT_BACKDROPS: readonly CardTextBackdrop[] = [
  'shade',
  'panel',
  'veil',
] as const;

// The curated skins. Each one's contrast is locked in the frontend so a
// community's colour choice can never fail the a11y build ratchet.
export enum CardSkin {
  Plum = 'plum',
  Cream = 'cream',
  Jade = 'jade',
  Coral = 'coral',
  Ink = 'ink',
}

@Entity('community_cards')
@Unique('UQ_community_cards_issuer', ['issuerType', 'issuerId'])
export class CommunityCard {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    type: 'enum',
    enum: CardIssuerType,
    enumName: 'community_cards_issuer_type_enum',
  })
  issuerType!: CardIssuerType;

  @Index('IDX_community_cards_issuer_id')
  @Column({ type: 'uuid' })
  issuerId!: string;

  @Column({ type: 'boolean', default: false })
  isEnabled!: boolean;

  @Column({
    type: 'enum',
    enum: CardSkin,
    enumName: 'community_cards_skin_enum',
    default: CardSkin.Plum,
  })
  skin!: CardSkin;

  // A design token NAME (e.g. 'accent', 'jade'), never a raw hex. Keeps
  // community colour inside the token system.
  @Column({ type: 'varchar', default: 'accent' })
  accentToken!: string;

  // Raw storage key for the crest, resolved through `toImageUrl` at the
  // response boundary. Never store the resolved URL.
  @Column({ type: 'varchar', nullable: true })
  crestMediaKey!: string | null;

  // The card's GROUND, when the community wants something other than a flat
  // skin colour. At most one of these two is ever set; both null means the
  // card paints `skin` as before.
  //
  // A preset NAME from a closed list (a pride flag), never raw colours —
  // same discipline as `accentToken`, and it keeps the rendering in the
  // frontend where the contrast scrim lives.
  @Column({ type: 'varchar', nullable: true })
  backgroundPreset!: string | null;

  // Raw storage key for an uploaded background, resolved through `toImageUrl`
  // at the response boundary. Never store the resolved URL.
  @Column({ type: 'varchar', length: 512, nullable: true })
  backgroundMediaKey!: string | null;

  // The word on the card, e.g. 'Sócie'. Community-authored.
  @Column({ type: 'varchar', default: 'Member' })
  cardName!: string;

  // Null means cards never expire.
  @Column({ type: 'int', nullable: true })
  validityMonths!: number | null;

  // Phase 3 formats. Stored now so the programme's intent is captured from
  // the start; nothing in Phase 1 reads them.
  @Column({ type: 'boolean', default: false })
  allowsPrint!: boolean;

  @Column({ type: 'boolean', default: false })
  allowsWallet!: boolean;

  @Column({ type: 'boolean', default: true })
  allowsPublicBadge!: boolean;

  // Whether this programme's cards carry the holder's photo at all. Off by
  // default: a card that pairs a face with a named LGBTQ+ community is a
  // different object from one that does not, and that is the community's
  // deliberate choice to make rather than a default it inherits. The member
  // keeps a veto on their own card (`MembershipCard.isPhotoHidden`).
  @Column({ type: 'boolean', default: false })
  allowsMemberPhoto!: boolean;

  // How those photos are printed. A closed list stored as varchar, the same
  // discipline `backgroundPreset` follows and for the same reason: the
  // frontend owns the rendering, and a two-value Postgres enum would have to
  // be altered rather than extended the first time a third style ships.
  //
  // Defaults to 'color', so a programme that already prints photos keeps
  // printing the photo its members uploaded.
  @Column({ type: 'varchar', length: 16, default: 'color' })
  photoStyle!: CardPhotoStyle;

  // Which legibility treatment this programme's cards use over a flag or an
  // uploaded photo. A closed list stored as varchar, the same discipline
  // `photoStyle` follows and for the same reasons.
  //
  // Read only when a ground is set: the five flat skins carry their own
  // curated contrast (see cardSkins.ts) and need no treatment at all. Defaults
  // to 'shade', so every card already in someone's wallet keeps exactly the
  // face it has today.
  @Column({ type: 'varchar', length: 16, default: 'shade' })
  textBackdrop!: CardTextBackdrop;

  // Whether this programme's cards print the holder's pronouns beside their
  // name. Off by default, on the same reasoning as the photo switch: what a
  // card says about the person carrying it is the community's deliberate
  // choice rather than a default it inherits, and an existing programme must
  // not start printing something new because the platform shipped a feature.
  // The value itself is never stored here: it is read from the holder's own
  // profile, so updating it in one place updates every card. The member keeps
  // a veto on their own card (`MembershipCard.isPronounsHidden`).
  @Column({ type: 'boolean', default: false })
  allowsPronouns!: boolean;

  // The three-letter serial prefix, derived once from the community name at
  // programme creation and frozen thereafter so serials stay stable.
  @Column({ type: 'varchar', length: 3 })
  serialPrefix!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
