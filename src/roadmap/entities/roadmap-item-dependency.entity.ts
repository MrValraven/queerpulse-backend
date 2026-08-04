import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * A directed "depends on" edge between two roadmap items, backing the item
 * drawer's Dependencies section (`deps: string[]` on `AdminRoadmapItemDTO`
 * is `itemId`'s outgoing edges). No relation/FK declared here — declared in
 * the migration (Task A2) — matching how `roadmap-vote.entity.ts` models
 * plain-column refs. The unique pair prevents duplicate edges.
 */
@Entity('roadmap_item_dependencies')
@Unique('UQ_roadmap_item_dependencies_pair', ['itemId', 'dependsOnId'])
export class RoadmapItemDependency {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  itemId!: string;

  @Column({ type: 'uuid' })
  dependsOnId!: string;
}
