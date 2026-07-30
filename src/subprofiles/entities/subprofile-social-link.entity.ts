import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// Mirrors `SocialLink` (main profile) but scoped to a persona: a subprofile
// owns its own set of social links, independent of the main profile's.
@Entity('subprofile_social_links')
export class SubprofileSocialLink {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_subprofile_social_links_subprofile_id')
  @Column({ type: 'uuid' })
  subprofileId: string;

  @Column({ type: 'varchar' })
  platform: string;

  @Column({ type: 'varchar' })
  urlOrHandle: string;

  @Column({ type: 'int', default: 0 })
  position: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
