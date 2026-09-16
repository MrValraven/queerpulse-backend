import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * ENG-258: one row per LIVE chat-gateway process, upserted on a short
 * interval by {@link ChatSingleInstanceGuard}'s own heartbeat, and read back
 * by that same guard to detect a Railway scale-out at RUNTIME.
 *
 * Railway sets `RAILWAY_REPLICA_ID` on every instance (this row's
 * `instanceId`) but exposes no variable naming how MANY replicas exist (see
 * `chat-replica-signals.ts`'s doc for the full explanation), so an
 * environment-variable check can never see a scale-out done from the Railway
 * dashboard. Two or more DISTINCT `instanceId`s with a recent `lastSeenAt`
 * means two or more processes are actually alive right now, which is the one
 * fact that matters: every piece of live-chat state this app holds
 * (presence, WS rate limits, socket.io rooms) is process-local, so a second
 * live process silently splits all three, regardless of what any config
 * variable claims.
 *
 * DELIBERATELY MINIMAL: no `createdAt`, no foreign keys, no index beyond the
 * primary key. The table holds at most a small handful of rows (one per live
 * replica this app will ever actually run), every read is a full scan of a
 * table that small, and `lastSeenAt` is the only column either the heartbeat
 * write or the detection read ever touches.
 */
@Entity('chat_gateway_instance_heartbeats')
export class ChatGatewayInstanceHeartbeat {
  /** `RAILWAY_REPLICA_ID` where present, otherwise a generated id minted
   *  once per process boot (see `ChatSingleInstanceGuard`). Never reused
   *  across two different live processes, including two overlapping
   *  processes on the exact same host. */
  @PrimaryColumn({ type: 'varchar', length: 128 })
  instanceId!: string;

  /** Stamped to `now()` on every heartbeat upsert. A row older than the
   *  guard's staleness threshold is treated as a crashed/replaced instance,
   *  never as evidence of a live sibling; see `ChatSingleInstanceGuard`'s own
   *  doc for why that distinction is the whole point of this table. */
  @Column({ type: 'timestamptz' })
  lastSeenAt!: Date;
}
