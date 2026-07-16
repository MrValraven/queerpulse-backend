import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// Union of every kind's content sections plus the universal `links` section.
// Kept in lockstep with `KIND_SECTIONS` in `../subprofile-kinds.ts`.
export enum SubprofileSection {
  // developer
  Projects = 'projects',
  OpenSource = 'open_source',
  // writer
  Publications = 'publications',
  Readings = 'readings',
  // musician
  Discography = 'discography',
  Gigs = 'gigs',
  // visual_artist
  Portfolio = 'portfolio',
  Exhibitions = 'exhibitions',
  // filmmaker
  Filmography = 'filmography',
  Screenings = 'screenings',
  // designer
  SelectedWork = 'selected_work',
  Clients = 'clients',
  // maker
  Collections = 'collections',
  Workshops = 'workshops',
  // generic
  Showcase = 'showcase',
  // every kind
  Links = 'links',
}

@Entity('subprofile_items')
export class SubprofileItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_subprofile_items_subprofile_id')
  @Column({ type: 'uuid' })
  subprofileId: string;

  @Column({
    type: 'enum',
    enum: SubprofileSection,
    enumName: 'subprofile_items_section_enum',
  })
  section: SubprofileSection;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'varchar', nullable: true })
  subtitle: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', nullable: true })
  url: string | null;

  @Column({ type: 'varchar', nullable: true })
  imageUrl: string | null;

  // Freeform, e.g. "2025".
  @Column({ type: 'varchar', nullable: true })
  date: string | null;

  // Short supporting line (role, stars, client, …).
  @Column({ type: 'varchar', nullable: true })
  meta: string | null;

  @Column({ type: 'text', array: true, default: '{}' })
  tags: string[];

  @Column({ type: 'int', default: 0 })
  position: number;
}
