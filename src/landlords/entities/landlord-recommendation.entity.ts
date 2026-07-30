import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One member's recommendation of a landlord (stars + text). One per member per
 * landlord (unique `(landlordId, authorUserId)`); re-posting upserts. Author
 * identity is hydrated live via `MemberLookup`, not snapshotted.
 */
@Entity('landlord_recommendations')
@Index('UQ_landlord_recommendations_author', ['landlordId', 'authorUserId'], {
  unique: true,
})
export class LandlordRecommendation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_landlord_recommendations_landlord_id')
  @Column({ type: 'uuid' })
  landlordId: string;

  @Index('IDX_landlord_recommendations_author_user_id')
  @Column({ type: 'uuid' })
  authorUserId: string;

  @Column({ type: 'int' })
  stars: number;

  @Column({ type: 'text' })
  text: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
