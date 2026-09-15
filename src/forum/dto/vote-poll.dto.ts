import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';
import { MAX_POLL_OPTIONS } from './create-thread-poll.dto';

/**
 * `POST /forum/threads/:slug/poll/vote` body — the options the caller is
 * casting for, as a complete SELECTION rather than a delta.
 *
 * The whole array replaces whatever the member had picked before, which is why
 * there is no "remove this option" shape: a ballot is the set of boxes ticked
 * when it is handed in, and describing it as a set makes re-voting idempotent
 * (sending the same array twice changes nothing) instead of a toggle whose
 * result depends on how many times it arrived.
 *
 * At least one option, because clearing a vote is not something this endpoint
 * offers: a poll's counts are the record of who answered, and a member who
 * wants their answer withdrawn is asking for something the design has not
 * decided (does the bar shrink? does the thread say so?). One to
 * `MAX_POLL_OPTIONS` covers every legal ballot, single- or multi-choice; the
 * arity rule itself (exactly one for a single-choice poll) is enforced in the
 * service, which is the only place that knows the poll's `allowMultiple`.
 *
 * Duplicate ids are deduped by the service rather than rejected: a client that
 * sends the same option twice has still expressed one unambiguous choice.
 */
export class VotePollDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_POLL_OPTIONS)
  @IsUUID(undefined, { each: true })
  optionIds!: string[];
}
