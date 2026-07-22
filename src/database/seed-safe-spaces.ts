import 'dotenv/config';
import { DataSource, EntityManager } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import {
  Listing,
  ListingDayHours,
  ListingPhotoSet,
  ListingSocial,
  ListingStatus,
  SafeSpacePromise,
  SafeSpaceRemoval,
  SafeSpaceStatus,
  SafeSpaceVouch,
} from '../listings/entities/listing.entity';

/**
 * Dedicated seed for Task 5 ("Safe Spaces live data"): marks a handful of
 * real business listings as safe spaces so `GET /directory/safe-spaces` shows
 * genuine data in live mode, instead of the frontend's static mock
 * (`queerpulse/src/features/safety/safeSpaces.ts` — `VERIFIED_SPACES` /
 * `REMOVED_SPACES`). Run this AFTER the safe-space columns' migration has
 * been applied (`pnpm run migration:run`). Running `pnpm run seed` first is
 * NOT required — this script is fully self-contained and falls back to a
 * placeholder owner account if the database has no members yet (see
 * `resolveSafeSpaceListingOwnerId` below) — but if `pnpm run seed`'s fixture
 * members already exist, one of them is reused as the listing owner instead.
 *
 * Mirrors `seed.ts`'s bootstrap exactly: same production guard, same
 * `DataSource` construction style, same `SnakeNamingStrategy`. Kept as its
 * own runnable script (rather than folded into `seed.ts`) because it targets
 * a narrower, later-added slice of the schema and is meant to be run
 * independently once the Safe Spaces migration lands.
 */

// `listings.owner_id` is a NOT NULL column with a real FK to `users(id)`
// (`ON DELETE CASCADE` — see migration `AddListings`), so a bare placeholder
// UUID with no backing row would fail the insert; some real user row must
// back it. These are moderator-vetted safe spaces, not member-run
// businesses (`linkToProfile: false` below), so WHO owns the row doesn't
// matter to the product — it only needs to be a valid, existing member.
// This intentionally reuses any existing member rather than minting a
// dedicated account: `User.isSystem` has one specific meaning in this
// codebase — the single genesis house account (`src/genesis/genesis.service.ts`,
// editable by admins via `admin/bots`) — and a second `isSystem` row would
// blur that and incorrectly surface these fixture listings in the bots admin
// surface. Only when the database has no user at all (a from-scratch dev DB
// that skipped `pnpm run seed`) does this fall back to creating one plain,
// clearly-dev-only, `isSystem: false` placeholder account.
const PLACEHOLDER_OWNER = {
  googleId: 'seed-safe-spaces-placeholder-owner',
  email: 'safe-spaces-seed@queerpulse.internal',
  slug: 'queerpulse-directory-seed',
  firstName: 'QueerPulse Directory Seed',
  lastName: '(dev fixture — not a real member)',
};

async function resolveSafeSpaceListingOwnerId(
  manager: EntityManager,
): Promise<string> {
  const users = manager.getRepository(User);
  const profiles = manager.getRepository(Profile);

  const [anyExistingUser] = await users.find({ take: 1 });
  if (anyExistingUser) {
    return anyExistingUser.id;
  }

  const existingPlaceholder = await users.findOne({
    where: { googleId: PLACEHOLDER_OWNER.googleId },
  });
  if (existingPlaceholder) {
    return existingPlaceholder.id;
  }

  const user = await users.save(
    users.create({
      googleId: PLACEHOLDER_OWNER.googleId,
      email: PLACEHOLDER_OWNER.email,
      status: UserStatus.Active,
      activatedAt: new Date(),
      isSystem: false,
    }),
  );
  await profiles.save(
    profiles.create({
      userId: user.id,
      slug: PLACEHOLDER_OWNER.slug,
      firstName: PLACEHOLDER_OWNER.firstName,
      lastName: PLACEHOLDER_OWNER.lastName,
      visibility: ProfileVisibility.Private,
      avatarUrl: null,
    }),
  );
  console.log(
    `No existing user found — created placeholder owner account (${PLACEHOLDER_OWNER.email})`,
  );
  return user.id;
}

const EMPTY_PHOTO_SET: ListingPhotoSet = { wide: '', d1: '', d2: '', vibe: '' };

const EMPTY_SOCIAL: ListingSocial = {
  instagram: '',
  website: '',
  email: '',
  phone: '',
};

const OPEN_LATE_WED_TO_SUN: Record<string, ListingDayHours> = {
  Mon: { open: false, from: '', to: '' },
  Tue: { open: false, from: '', to: '' },
  Wed: { open: true, from: '21:00', to: '03:00' },
  Thu: { open: true, from: '21:00', to: '03:00' },
  Fri: { open: true, from: '21:00', to: '03:00' },
  Sat: { open: true, from: '21:00', to: '03:00' },
  Sun: { open: true, from: '21:00', to: '03:00' },
};

const OPEN_DAILY_MORNING_TO_EVENING: Record<string, ListingDayHours> = {
  Mon: { open: true, from: '08:00', to: '19:00' },
  Tue: { open: true, from: '08:00', to: '19:00' },
  Wed: { open: true, from: '08:00', to: '19:00' },
  Thu: { open: true, from: '08:00', to: '19:00' },
  Fri: { open: true, from: '08:00', to: '19:00' },
  Sat: { open: true, from: '08:00', to: '19:00' },
  Sun: { open: true, from: '08:00', to: '19:00' },
};

/**
 * Ported from the frontend mock's `VERIFIED_SPACES` / `REMOVED_SPACES`
 * (`queerpulse/src/features/safety/safeSpaces.ts`). `cats`/`tags` are chosen
 * so `mapSafeSpaceCategory` (`src/listings/listing-response.ts`) derives the
 * same facet the frontend hardcoded: primary cat `food` + a tag containing
 * "bar" -> Bar; primary cat `food` with no bar/club tag -> Cafe.
 */
interface SafeSpaceListingSeed {
  ref: string;
  slug: string;
  name: string;
  cats: string[];
  hood: string;
  tags: string[];
  blurb: string;
  address: string;
  langs: string[];
  hoursNote: string;
  hours: Record<string, ListingDayHours>;
  safeSpaceStatus: SafeSpaceStatus;
  safeSpaceTier: number | null;
  safeSpaceVerifier: string;
  safeSpaceReVerifiedAt: string | null;
  safeSpaceSub: string;
  safeSpacePromises: SafeSpacePromise[];
  safeSpaceVouches: SafeSpaceVouch[];
  safeSpaceRemoval: SafeSpaceRemoval | null;
}

const SAFE_SPACE_LISTINGS: SafeSpaceListingSeed[] = [
  // Verified — Bar. Ported from VERIFIED_SPACES[slug="purex"].
  {
    ref: 'QPL-2026-9001',
    slug: 'purex',
    name: 'Purex',
    cats: ['food'],
    hood: 'Intendente',
    tags: ['Bar', 'Gender-neutral bathrooms', 'Accessible', 'Trans-welcoming'],
    blurb:
      "One of Lisbon's longest-running queer bars — staff step in fast, bathrooms are gender-neutral, entrance is step-free.",
    address: 'R. de São Lázaro 11, Intendente, Lisbon',
    langs: ['pt', 'en'],
    hoursNote: 'Open late, Wed–Sun',
    hours: OPEN_LATE_WED_TO_SUN,
    safeSpaceStatus: SafeSpaceStatus.Verified,
    safeSpaceTier: 1,
    safeSpaceVerifier: 'Mod team · 2 visits',
    safeSpaceReVerifiedAt: '2026-05-02',
    safeSpaceSub:
      'A long-running queer bar that never let one crowd take it over. Mixed, easy, and staffed by people who step in before you have to ask.',
    safeSpacePromises: [
      {
        title: 'Staff intervene, every time.',
        desc: 'Bar staff are briefed to step in on harassment without waiting to be asked. They will remove a customer before they remove you.',
      },
      {
        title: 'Gender-neutral, single-stall bathrooms.',
        desc: 'No gendered doors, no queue politics, locks that work. Cleaned through the night.',
      },
      {
        title: 'Quick exit on request.',
        desc: 'Ask any bartender for the side door to Rua dos Anjos. They will walk you out and call you a taxi.',
      },
      {
        title: 'Incidents reported to moderation within 48h.',
        desc: 'Anything that happens here reaches the QueerPulse moderation team within two days.',
      },
    ],
    safeSpaceVouches: [
      {
        name: 'Kai L.',
        byline: 'Member 2 years · vouched 4×',
        text: "A guy started filming people on the dancefloor. I pointed him out to the bar and he was gone in ninety seconds, no drama, no making me explain. That's the whole point of this place.",
        when: 'Vouched 18 Apr 2026',
      },
      {
        name: 'Rita V.',
        byline: 'Regular',
        text: "It's the one bar I'll go to alone and still feel held. The bathrooms are genuinely fine and the staff clock when someone's not okay.",
        when: 'Vouched 2 Mar 2026',
      },
    ],
    safeSpaceRemoval: null,
  },
  // Verified — Cafe. Ported from VERIFIED_SPACES[slug="linha-dagua"].
  {
    ref: 'QPL-2026-9002',
    slug: 'linha-dagua',
    name: "Linha d'Água",
    cats: ['food'],
    hood: 'Príncipe Real',
    tags: ['Queer-owned', 'Sober-friendly', 'Accessible', 'Community board'],
    blurb:
      'A calm, queer-owned café good for laptop work or a quiet coffee, with a community notice board and a fully accessible room.',
    address: 'R. da Escola Politécnica 56, Príncipe Real, Lisbon',
    langs: ['pt', 'en', 'es'],
    hoursNote: 'Open 7 days',
    hours: OPEN_DAILY_MORNING_TO_EVENING,
    safeSpaceStatus: SafeSpaceStatus.Verified,
    safeSpaceTier: 1,
    safeSpaceVerifier: 'Mod team · 2 visits',
    safeSpaceReVerifiedAt: '2026-05-06',
    safeSpaceSub:
      'A queer-owned, sober-friendly café built for the long stay — laptop mornings, quiet first dates, a community board that actually gets read. Fully step-free.',
    safeSpacePromises: [
      {
        title: 'Names & pronouns honoured.',
        desc: 'Show your QueerPulse card and staff use that name on your cup. Legal name never asked.',
      },
      {
        title: 'A safe table to wait at.',
        desc: 'Meeting a stranger from a date or a sale? Tell staff — they keep an eye and will intervene if it goes wrong.',
      },
      {
        title: 'Fully step-free + accessible bathroom.',
        desc: 'Level entrance, wide aisles, a genuine accessible single-stall bathroom.',
      },
      {
        title: 'Sober by default.',
        desc: 'No alcohol, no pressure — a rare quiet option in a nightlife neighbourhood.',
      },
    ],
    safeSpaceVouches: [
      {
        name: 'Jonas F.',
        byline: 'Member 3 years',
        text: 'I run my recovery meet-ups out of the corner here. Staff hold the table, keep it sober, never make it weird. Quietly one of the safest rooms in the city.',
        when: 'Vouched 28 Apr 2026',
      },
      {
        name: 'Rita V.',
        byline: 'Regular',
        text: 'Did all my scary first dates here on purpose. The staff clock it and hover just enough. Cup always says Rita, never the other name.',
        when: 'Vouched 12 Apr 2026',
      },
    ],
    safeSpaceRemoval: null,
  },
  // Removed — Bar. Ported from REMOVED_SPACES[slug="bar-atlas"].
  {
    ref: 'QPL-2026-9003',
    slug: 'bar-atlas',
    name: 'Bar Atlas',
    cats: ['food'],
    hood: 'Santos',
    tags: ['Bar'],
    blurb:
      'Formerly a listed queer bar in Santos; the safe-space badge was removed in May 2026 after a door-discrimination incident.',
    address: 'R. de Santos-o-Velho 22, Santos, Lisbon',
    langs: ['pt', 'en'],
    hoursNote: '',
    hours: {},
    safeSpaceStatus: SafeSpaceStatus.Removed,
    safeSpaceTier: null,
    safeSpaceVerifier: '',
    safeSpaceReVerifiedAt: null,
    safeSpaceSub: '',
    safeSpacePromises: [],
    safeSpaceVouches: [],
    safeSpaceRemoval: {
      reason:
        'Door staff refused entry to a trans member, then management defended it.',
      removedDate: '8 May 2026',
      listedSince: 'March 2024',
      flags: 5,
      reasonLong: [
        'In April 2026 a verified member was refused entry after a doorman challenged whether the photo on their ID "matched". A second member witnessed it. Both filed reports the same night.',
        'What moved this from a flag to a removal was the response. When moderators raised it, the owner defended the doorman and declined to retrain the door team or apologise. A verified space can survive a bad night; it cannot survive management that stands behind one.',
      ],
      timeline: [
        {
          date: '18 Apr 2026',
          event: 'First incident reported by two members independently.',
        },
        {
          date: '19 Apr 2026',
          event: 'Badge suspended pending review (3-flag threshold passed).',
        },
        {
          date: '2 May 2026',
          event:
            'Moderators met the owner; no commitment to retrain or apologise.',
        },
        {
          date: '8 May 2026',
          event: 'Listing permanently removed. Owner notified in writing.',
        },
      ],
      whatNow:
        'Bar Atlas is no longer a verified safe space and the venue may not display the badge. If you have a recent experience here — good or bad — you can still file a report; the record stays open in case the venue applies to be re-reviewed in future, which requires demonstrable change.',
    },
  },
];

async function seedSafeSpaces(): Promise<void> {
  // Guard: this seed writes fixture business listings and must never touch a
  // production database. Refuse to run when NODE_ENV signals production.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run the seed with NODE_ENV=production. The seed is for local/dev fixtures only.',
    );
  }

  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    entities: [User, Profile, Listing],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
  });
  await dataSource.initialize();
  try {
    await dataSource.transaction(async (manager) => {
      const ownerId = await resolveSafeSpaceListingOwnerId(manager);
      const listings = manager.getRepository(Listing);

      for (const seed of SAFE_SPACE_LISTINGS) {
        const existing = await listings.findOne({
          where: { slug: seed.slug },
        });

        const safeSpaceFields = {
          safeSpaceStatus: seed.safeSpaceStatus,
          safeSpaceTier: seed.safeSpaceTier,
          safeSpaceVerifier: seed.safeSpaceVerifier,
          safeSpaceReVerifiedAt: seed.safeSpaceReVerifiedAt,
          safeSpaceSub: seed.safeSpaceSub,
          safeSpacePromises: seed.safeSpacePromises,
          safeSpaceVouches: seed.safeSpaceVouches,
          safeSpaceRemoval: seed.safeSpaceRemoval,
        };

        if (existing) {
          // Upsert path: an already-seeded (or member-submitted) listing with
          // this slug exists — bring its safe-space fields and status up to
          // date without touching the rest of its listing data. NOTE: this
          // intentionally only refreshes `status` + the `safeSpace*` columns.
          // Core listing fields (`cats`/`tags`/`blurb`/`hours`/etc.) are
          // NEVER re-applied on an existing row, so if you edit those fields
          // in `SAFE_SPACE_LISTINGS` above, re-running this seed against a
          // database that already has the row will NOT propagate the change
          // — you'd need to update the row directly or delete it first.
          await listings.update(
            { id: existing.id },
            { status: ListingStatus.Live, ...safeSpaceFields },
          );
          console.log(`Updated safe-space listing ${seed.slug}`);
          continue;
        }

        await listings.save(
          listings.create({
            ref: seed.ref,
            slug: seed.slug,
            ownerId,
            status: ListingStatus.Live,
            name: seed.name,
            cats: seed.cats,
            hood: seed.hood,
            tags: seed.tags,
            blurb: seed.blurb,
            address: seed.address,
            langs: seed.langs,
            hoursNote: seed.hoursNote,
            hours: seed.hours,
            // Fully shaped jsonb objects — a plain `{}` (the raw column
            // default) makes `toDirectoryDetail`'s `listing.alt.wide.length`
            // (src/listings/listing-response.ts) throw on the public
            // `GET /directory/:slug` route, since these live listings also
            // surface in the general directory alongside the safe-space page.
            alt: EMPTY_PHOTO_SET,
            photos: EMPTY_PHOTO_SET,
            social: EMPTY_SOCIAL,
            // These are moderator-vetted safe spaces, not member-submitted
            // businesses — there is no member profile to link to, so the
            // "run by a member" affordance must stay off and `ownerName`/
            // `ownerRole`/`ownerBio` stay at their empty-string defaults.
            linkToProfile: false,
            ...safeSpaceFields,
          }),
        );
        console.log(`Seeded safe-space listing ${seed.slug}`);
      }
    });

    console.log('Safe-space seed complete.');
  } finally {
    await dataSource.destroy();
  }
}

seedSafeSpaces().catch((err) => {
  console.error('Safe-space seed failed:', err);
  process.exit(1);
});
