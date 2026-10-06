import type {
  PlatformLogCategory,
  PlatformLogPartyKind,
  PlatformLogSubject,
} from '../platform-log.types';

/**
 * One party on a log entry. `userId` is null whenever `kind` is `anonymous`,
 * `erased` or `system`, so an anonymous party's id never leaves the server.
 * `name` is empty for `anonymous` and `erased`; the client localizes those.
 */
export interface PlatformLogPartyDTO {
  userId: string | null;
  name: string;
  kind: PlatformLogPartyKind;
}

export interface PlatformLogEntryDTO {
  /** `<sourceKey>:<rowId>` */
  id: string;
  /** ISO, millisecond precision, for display only. */
  occurredAt: string;
  category: PlatformLogCategory;
  /** Stable code such as `mod.ban` or `member.vouch_given`. */
  kind: string;
  actor: PlatformLogPartyDTO;
  target: PlatformLogPartyDTO | null;
  subject: PlatformLogSubject | null;
  params: Record<string, string>;
  /** Staff rows only; always null on member rows. */
  note: string | null;
}
