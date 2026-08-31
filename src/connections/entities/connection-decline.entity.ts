import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * The durable record of one member refusing another member's connection
 * requests (PRD-20).
 *
 * WHY IT IS NOT A COLUMN ON `connections`. Two reasons, and both are the whole
 * point of the row existing:
 *
 *  1. DIRECTION. A `connections` row is a canonical unordered pair
 *     (`user_low`/`user_high`), so a counter living on it could not tell "A
 *     asked B three times" apart from "B asked A three times". Declining is
 *     one-directional: refusing someone's request must never cost you the
 *     ability to reach out to them yourself. Keying on
 *     `(requester_id, addressee_id)` makes that structural.
 *  2. DURABILITY. `ConnectionsService.remove` DELETEs the `connections` row,
 *     and either party may call it on a declined pair. A counter stored there
 *     would be erasable by the very person it constrains: decline, delete,
 *     request again, forever. This table is never touched by `remove`, so the
 *     history outlives the edge.
 *
 * The record is cleared when the pair reaches `accepted` in either direction:
 * a connection that both members ended up wanting resolves whatever the
 * refusals were about, so the count starts from nothing if they ever part.
 *
 * No foreign keys, matching `connections` itself, which denormalizes
 * `requester_id`/`addressee_id` the same way.
 */
@Entity('connection_declines')
@Unique('UQ_connection_declines_pair', ['requesterId', 'addresseeId'])
export class ConnectionDecline {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The member whose requests were refused. */
  @Column({ type: 'uuid' })
  requesterId!: string;

  /**
   * The member who refused. Indexed on its own so a future "who have I asked
   * not to contact me" screen can read the decliner's side without scanning.
   */
  @Index('IDX_connection_declines_addressee_id')
  @Column({ type: 'uuid' })
  addresseeId!: string;

  /**
   * How many times this addressee has declined this requester. Incremented
   * atomically inside the same transaction that flips the connection to
   * `declined`, so a decline can never land without the count that guards it.
   */
  @Column({ type: 'integer', default: 1 })
  declineCount!: number;

  /** When the most recent refusal happened. The cooldown counts from here. */
  @Column({ type: 'timestamptz' })
  lastDeclinedAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
