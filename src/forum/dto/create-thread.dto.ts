import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { CreateThreadPollDto } from './create-thread-poll.dto';
import { ForumPostPhotoDto, MAX_POST_PHOTOS } from './forum-post-photo.dto';

// `POST /forum/threads` body — matches `CreateThreadDto` in the frontend's
// `forum.api.ts` (`title`, `body`, `category`, optional `tags`).
export class CreateThreadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body!: string;

  // `"all"` (any case) is reserved: `ThreadCategoryCounts` returns a flat
  // `{ all, ...perCategory }` map, so a category literally named `all` would
  // overwrite the total and corrupt the counts response. Reject it here so it
  // can never become a real category. (There is no `category` field on
  // `UpdateThreadDto`, so create is the only path a category is set.)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^(?!all$).+/i, { message: '"all" is a reserved category' })
  category!: string;

  // Up to 5 free-text tags, each ≤ 24 chars. The service normalizes them
  // (trim, lowercase, strip `#`, dedupe, drop empties) before persisting.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(24, { each: true })
  tags?: string[];

  // One optional photo on the opening post, as a storage key from the
  // presigned upload pipeline (SOC-13). Same validator + global ownership
  // interceptor as `CreatePostDto.image`; persisted on the OP `forum_post`
  // row, not on the thread.
  @IsOptional()
  @IsImageReference()
  image?: string;

  // Optional community to attach this thread to. When present, the service
  // resolves it via `CommunityMembershipService.assertMemberBySlug` — 404 if
  // missing/archived, 403 if the author isn't on its roster — mirroring
  // `CreateEventDto.communitySlug`.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  communitySlug?: string;

  // Post this thread as "QueerPulse Official" instead of the caller. Only an
  // admin can actually set this — `ForumThreadsService.create` silently
  // coerces it to `false` for anyone else, since the composer only ever
  // shows the checkbox to admins.
  @IsOptional()
  @IsBoolean()
  isOfficial?: boolean;

  // What the thread IS. A CLOSED vocabulary (`@IsIn`, not `@IsString`) because
  // the four values drive rendering and the `unanswered` sort's meaning — a
  // fifth kind is a product decision that has to land in the composer, the card
  // and here together, and a free-text column would let one client invent one
  // on its own. Optional, and omitting it stores NULL: "unclassified" is a real
  // state (every thread written before the composer asked is in it), so the DTO
  // does not default a guess into the column. See `ForumThread.kind`.
  @IsOptional()
  @IsIn(['question', 'guide', 'proposal', 'share'])
  kind?: string;

  // The author's own warnings about what is inside. Capped at 8 because they
  // render ahead of the body and a wall of labels warns nobody about anything;
  // 40 characters each because a warning is a label ("discussion of medical
  // transition"), and anything longer is the post's own first sentence being
  // written twice. The service normalizes them (trim, dedupe, drop empties)
  // exactly as it does `tags`.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  contentWarnings?: string[];

  // Post without the byline (`ForumThread.isAnonymous` masks the rendered
  // author; `author_id` stays the real member). TWO SERVER-ENFORCED RULES sit
  // behind this flag, both applied in `ForumThreadsService.create` and both
  // silent coercions rather than 400s, the way `isOfficial` above is already
  // handled — the composer only offers the checkbox where it applies, so a
  // value arriving outside that is a stale client, not a member to argue with:
  //
  //  1. Only the categories where anonymity is the difference between asking
  //     and not asking (`health`, `housing`, `trans`) accept it. Everywhere
  //     else it coerces to false: an anonymous byline on a general thread costs
  //     the forum accountability and buys the author nothing they needed.
  //  2. It is mutually exclusive with `isOfficial`, and `isOfficial` wins. The
  //     platform posting under its own name and a member hiding theirs are
  //     opposite acts, and a row claiming both would have to render one byline
  //     anyway (see `toThreadBylineAuthor`).
  @IsOptional()
  @IsBoolean()
  isAnonymous?: boolean;

  // A second member to credit on the thread, by HANDLE — the same identifier a
  // member can actually read off a profile, never an internal user id, which
  // the composer has no way to know and which would let a caller probe id
  // existence. Resolved to a user id in `ForumThreadsService.create`: a handle
  // that matches no active member is a 400 (silently dropping it would publish
  // a co-written guide with one name on it), and the caller's own handle is a
  // 400 too, because `author_id` already credits them and a self-co-author
  // would render their name twice.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  coAuthorHandle?: string;

  // The part of the city the thread is about. Free text at 60 characters, which
  // is the column's width: neighbourhood names are contested, overlapping and
  // member-defined, so there is no list to validate against — see
  // `ForumThread.neighbourhood` for why a curated one would drift.
  @IsOptional()
  @IsString()
  @MaxLength(60)
  neighbourhood?: string;

  // Which language the thread is in. A closed three-value vocabulary, not a
  // locale tag: the forum is read by people who have exactly one of the two
  // languages, and 'both' is a real answer rather than a pair of tags.
  @IsOptional()
  @IsIn(['pt', 'en', 'both'])
  language?: string;

  // Carry a community's thread out to the town square as well. Only meaningful
  // alongside `communitySlug` — a thread that belongs to no community is
  // already in the town square, so there is nothing to cross-post. Coerced to
  // false without one (`ForumThreadsService.create`) rather than 400'd, for the
  // same reason `isOfficial` is: it is a checkbox the composer only shows in
  // the community composer.
  @IsOptional()
  @IsBoolean()
  crossPosted?: boolean;

  // When this thread stops taking new replies (the author's own deadline, not a
  // moderator's lock). ISO-8601 on the wire; the WINDOW — strictly future, at
  // most a year out — is enforced in `ForumThreadsService.create`, not here,
  // because a class-validator decorator is evaluated against a clock the
  // validator cannot see at decoration time. `EventsService.assertScheduleValid`
  // is the precedent: `@IsISO8601()` on the DTO, the window in the service.
  //
  // A year is the ceiling because a deadline further out than that is not a
  // deadline, and an accidental extra digit in a year field should not close a
  // thread in 2126.
  @IsOptional()
  @IsISO8601()
  closesAt?: string;

  // Publish the thread later instead of now. Maps to `ForumThread.publishedAt`
  // (which defaults to `now()` when this is omitted), and every member-facing
  // read path hides a row until that instant arrives. Same ISO-8601 shape and
  // the same service-enforced future/one-year window as `closesAt` above, for
  // the same reasons.
  @IsOptional()
  @IsISO8601()
  publishAt?: string;

  // Send the thread to the editors (a guide) or the council (a proposal)
  // instead of publishing it straight away: the service creates it with
  // `reviewState: 'pending'`, which keeps it out of every member-facing read
  // until it is approved.
  //
  // A boolean rather than a `reviewState` string, deliberately: 'approved' and
  // 'rejected' are the REVIEWER's words, and a DTO that accepted them would let
  // an author approve their own thread.
  @IsOptional()
  @IsBoolean()
  submitForReview?: boolean;

  // An optional poll on the thread, 2 to 6 options. Created inside the SAME
  // transaction as the thread and its opening post
  // (`ForumThreadsService.createWithUniqueSlug`), so a thread can never exist
  // carrying half a ballot -- a poll whose options failed to insert would
  // render as a question with nothing to pick.
  //
  // `@ValidateNested` + `@Type` are load-bearing, not decoration: the global
  // pipe runs `whitelist: true, forbidNonWhitelisted: true`, so without the
  // `@Type` telling class-transformer what this object IS, every field inside
  // it is stripped as unknown and the poll arrives empty. `@IsObject` is what
  // makes an array or a string here a 400 rather than something
  // `plainToInstance` quietly coerces.
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CreateThreadPollDto)
  poll?: CreateThreadPollDto;

  // Up to four photos on the opening post, in the order the author arranged
  // them, persisted as `forum_post_photo` rows inside the same transaction.
  //
  // This is the successor to `image` above, which stays exactly as it is: it
  // remains the home of every already-published single photo, and the read path
  // presents a post holding one as a one-photo gallery so nothing has to be
  // backfilled (see `toPostPhotoViews`). Sending BOTH a non-empty `image` and a
  // non-empty `photos` is a 400 rather than a silent winner, because the two
  // are the same field spelled twice and guessing which one the author meant
  // would drop a photo they attached.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_POST_PHOTOS)
  @ValidateNested({ each: true })
  @Type(() => ForumPostPhotoDto)
  photos?: ForumPostPhotoDto[];
}
