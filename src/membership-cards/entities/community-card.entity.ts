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

  // The three-letter serial prefix, derived once from the community name at
  // programme creation and frozen thereafter so serials stay stable.
  @Column({ type: 'varchar', length: 3 })
  serialPrefix!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
