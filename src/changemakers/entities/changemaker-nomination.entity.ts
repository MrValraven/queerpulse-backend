import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A member nominating someone for the Change Makers directory (see the
 * "Nominate them" form in `ChangemakersPage.tsx`). The directory itself
 * (`CHANGEMAKERS`) is curated editorial content with no `changemaker` table
 * to reference — the form's only field is the nominee's name, so that's all
 * this row captures, denormalized the same way `CommissionInterest`
 * denormalizes its target.
 */
@Entity('changemaker_nomination')
export class ChangemakerNomination {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_changemaker_nomination_nominator_id')
  @Column({ type: 'uuid' })
  nominatorId: string;

  // The form's only field: "Their name…".
  @Column({ type: 'varchar', length: 200 })
  nomineeName: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
