import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Seeded section config powering Issue-plan gap counts (spec §3.5). Rows are
 * seeded by the migration (Cover, Features, Reported, Interview, Essays,
 * Service, Photo, Review, Column, Last word) and are otherwise static
 * reference data, not user-editable in Phase 1.
 */
@Entity('magazine_section')
export class MagazineSection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_magazine_section_name', { unique: true })
  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'int' })
  target!: number;

  @Column({ type: 'varchar' })
  note!: string;

  @Column({ type: 'int' })
  orderIndex!: number;
}
