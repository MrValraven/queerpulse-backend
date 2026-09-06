import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import type { ModActionCode } from './mod-action.dto';

/**
 * The member-facing note rule for a moderation decision (PRD-287).
 *
 * ## The gap this closes
 *
 * `ModActionDto.note` is documented as "the exact member-facing text — the
 * reason the member reads", and it is what `notifyModerationOutcome` forwards
 * into the member's `moderation_outcome` notification. It was validated with
 * `@IsString()` and `@MaxLength(2000)` only, so `""` and `"   "` both passed.
 * A member could be told "you were restricted for 7 days" with a blank reason,
 * which §04 of the Code of Conduct says is always shared, and their appeal
 * (`CreateAppealDto.reason`, which demands 20 characters OF THEM) then had
 * nothing to argue against.
 *
 * ## Which actions the rule covers, and why those
 *
 * The actions that land a consequence on a member, and that a member may
 * therefore appeal:
 *
 *  - `warn`, `restrict`, `suspend`, `ban` — exactly
 *    `ModerationService.OUTCOME_ACTIONS`, the set that reaches the member's
 *    notification. A sanction announced with no reason is the whole finding.
 *  - `hide_content`, `remove_content` — these write no notification today, but
 *    they DO write the only durable statement of why the content went
 *    (`content_moderation.note` and `reports.resolution_note`), and
 *    `CreateAppealDto`'s own doc comment names content removal as appealable.
 *    A takedown whose recorded reason is the empty string cannot be reviewed by
 *    the second moderator who hears the appeal.
 *
 * And the two it deliberately does NOT cover:
 *
 *  - `dismiss` — nothing lands on anybody. Nobody is told, nothing is appealed,
 *    and the queue's most common outcome is "this was fine". Demanding twenty
 *    characters of prose to close a report that needed no action buys filler
 *    text and slows the queue.
 *  - `escalate` — an internal handoff. The report stays open and moves up; the
 *    moderator's position is precisely that they cannot settle it, so requiring
 *    them to write a member-facing explanation asks for a sentence they are not
 *    yet in a position to write. The moderator who eventually resolves it is
 *    held to this rule instead.
 *
 * `dismiss` and `escalate` keep their existing `@IsString()` requirement, so
 * the field is still always present on the wire and the frontend contract is
 * unchanged.
 */
export const MEMBER_FACING_MOD_ACTIONS: ReadonlySet<string> =
  new Set<ModActionCode>([
    'warn',
    'restrict',
    'suspend',
    'ban',
    'hide_content',
    'remove_content',
  ]);

/**
 * The floor for a note the member reads.
 *
 * Twenty characters, which is the number this codebase already uses for every
 * other "reason someone else has to be able to act on": `CreateAppealDto.reason`
 * (the member's case against this very decision), the community owner review
 * (`create-community-owner-review.dto.ts`) and the housing enquiry body all
 * sit at `@MinLength(20)`. Holding the moderator to the same bar as the member
 * appealing them is the only defensible symmetry: it would be strange to demand
 * twenty characters of the person contesting a sanction and none of the person
 * imposing it. In practice it is about three words, so it rules out `""`, `"."`
 * and `"spam"` while never getting in the way of a real sentence.
 */
export const MIN_MEMBER_FACING_NOTE_LENGTH = 20;

/** The existing cap, kept in one place now that three DTOs cite it. */
export const MAX_MOD_NOTE_LENGTH = 2000;

/**
 * Trims a string value before validation, so a note of nothing but spaces is
 * measured as the empty string it is and stored without its padding. Mirrors
 * `legal-requests/dto/create-legal-request.dto.ts`'s `trimmed`.
 */
export const trimmedText = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Whether `action` is one whose reason a member reads or appeals against. */
export function actionRequiresMemberFacingNote(action: unknown): boolean {
  return typeof action === 'string' && MEMBER_FACING_MOD_ACTIONS.has(action);
}

interface ModDecisionShape {
  action?: unknown;
  note?: unknown;
}

export const MEMBER_FACING_NOTE_MESSAGE =
  'This decision reaches the member, so the note is the reason they read and ' +
  `the thing their appeal answers. Write at least ${MIN_MEMBER_FACING_NOTE_LENGTH} characters saying why.`;

/**
 * Class-level rule for `ModActionDto` / `ModBulkActionDto`: when `action` is
 * one of {@link MEMBER_FACING_MOD_ACTIONS}, `note` must be a string of at least
 * {@link MIN_MEMBER_FACING_NOTE_LENGTH} characters once trimmed.
 *
 * ATTACHED TO `action`, NEVER TO `note`, and that placement is load-bearing.
 * class-validator's `@IsOptional()` skips EVERY decorator on the property it
 * sits on whenever that property's value is `undefined`, and
 * `ModBulkActionDto.note` is `@IsOptional()`. A rule attached to `note` would
 * therefore stop running in the one case it exists to catch: a bulk `suspend`
 * that sends no note at all. `action` is required on both DTOs, so a rule
 * attached there runs on every request and reads `note` off the whole object
 * through `args.object`. Same reasoning, and the same shape, as
 * `HasAtLeastOneContactField` in `resources/dto`.
 */
export function RequiresMemberFacingNote(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'requiresMemberFacingNote',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (!actionRequiresMemberFacingNote(value)) return true;
          const decision = args.object as ModDecisionShape;
          const note = decision.note;
          return (
            typeof note === 'string' &&
            note.trim().length >= MIN_MEMBER_FACING_NOTE_LENGTH
          );
        },
        defaultMessage(): string {
          return MEMBER_FACING_NOTE_MESSAGE;
        },
      },
    });
  };
}
