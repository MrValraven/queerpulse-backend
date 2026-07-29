# API surface ownership — housing / directory / listings domain

**Status:** documentation only. No code is moved by this document. The physical
convergence it proposes is **deferred** (see [Why the merge is deferred](#why-the-merge-is-deferred)).

**Scope:** the overlapping "places you can browse and list" corner of the API —
business listings, the public business directory, housing co-ops, housing
listings (rooms/flats), community landlords, and flatmate profiles. Concretely,
the modules `listings`, `housing`, `housing-listings`, `landlords`,
`flatmate-profiles`, and the three top-level browse controllers
(`directory` at `/directory/*`, `housing-directory` at `/housing-directory/*`,
`flatmate-directory` at `/flatmate-directory/*`).

Everything below was read from the controllers/modules as they stand today; the
route inventory is the source of truth, not memory.

---

## 1. Current inventory

Guard shorthand: **Public** = `@Public()` opts out of the global `JwtAuthGuard`;
**ActiveMember** = `ActiveMemberGuard` (JWT + `status === 'active'`); **Mod/Admin**
= `RolesGuard` + `@Roles(Moderator, Admin)`; **Admin** = `@Roles(Admin)`. Every
controller is also behind a `@Feature(...)` launch flag (the `LaunchedFeaturesGuard`
returns 404 when the feature is off); the flag key is listed per controller.

### 1a. `listings` module (`src/listings/`)

Bounded context: **member business listings** (spec §3 Tier 4). Entities
`Listing`, `ListingReview` (plus a read-only `Event` registration to surface a
listing's upcoming events). Two deliberately-separate controllers:

| Controller | `@Controller` | Feature | Routes | Guard |
| --- | --- | --- | --- | --- |
| `ListingsController` | `listings` | `listings` | `POST /listings`; `GET /listings/mine`; `GET /listings/admin/safe-space-candidates`; `GET /listings/admin/queue`; `GET /listings/:ref`; `PATCH /listings/:ref`; `DELETE /listings/:ref`; `PATCH /listings/:ref/status`; `PATCH /listings/:ref/safe-space` | class **ActiveMember**; the four `admin/*` and `:ref/status`, `:ref/safe-space` routes layer **Mod/Admin** |
| `DirectoryController` | `directory` | `listings` | `GET /directory/spaces`; `GET /directory`; `GET /directory/safe-spaces`; `GET /directory/safe-spaces/:slug`; `GET /directory/by-member/:slug`; `GET /directory/:slug`; `GET /directory/:slug/reviews`; `POST /directory/:slug/reviews` | no class guard; every read is **Public**; only `POST …/reviews` is **ActiveMember** |

**Key fact — `listings` and `directory` are already one module, split on purpose.**
`ListingsController` carries a class-level `ActiveMemberGuard`, and that guard does
**not** honor `@Public()` — it unconditionally rejects non-active callers. Public,
logged-out reads therefore cannot live under it, so the public browse of the very
same `Listing` table was given its own guardless `DirectoryController` at
`/directory`. This is not accidental duplication; it is the reference pattern for
"public read surface + member write surface over one table". Do **not** treat
`directory` as a legacy alias of `listings`.

### 1b. `housing` module (`src/housing/`)

Bounded context: **housing co-ops** (organizations), distinct from rooms/flats.
Entities `HousingCoop`, `CoopJoinRequest`. Exports `HousingService`.

| Controller | `@Controller` | Feature | Routes | Guard |
| --- | --- | --- | --- | --- |
| `HousingController` | `housing` | `housing` | `GET /housing/coops`; `POST /housing/coops/:slug/join-requests` | both **Public** (join requests are deliberately open to anonymous non-members; `userId` is always passed as `null`) |

### 1c. `housing-listings` module (`src/housing-listings/`)

Bounded context: **member housing listings** (rooms/flats to let). Entity
`HousingListing`. Imports `UsersModule` (Profile repo for member-ref hydration) and
`MessagingModule` (enquiry delivery). Three controllers following the standard
three-part shape:

| Controller | `@Controller` | Feature | Routes | Guard |
| --- | --- | --- | --- | --- |
| `HousingListingsController` | `housing-listings` | `housingListings` | `POST /housing-listings`; `GET /housing-listings/mine`; `GET /housing-listings/:ref`; `PATCH /housing-listings/:ref`; `DELETE /housing-listings/:ref`; `POST /housing-listings/:ref/enquiries` | class **ActiveMember** |
| `HousingDirectoryController` | `housing-directory` | `housingListings` | `GET /housing-directory`; `GET /housing-directory/:slug` | class **ActiveMember** |
| `AdminHousingListingsController` | `admin/housing-listings` | `housingListings` | `GET /admin/housing-listings`; `PATCH /admin/housing-listings/:ref/status` | class **Mod/Admin** |

### 1d. `landlords` module (`src/landlords/`)

Bounded context: **community landlord directory**. Entities `Landlord`,
`LandlordRecommendation`, `LandlordIntroRequest`. Imports `UsersModule`.

| Controller | `@Controller` | Feature | Routes | Guard |
| --- | --- | --- | --- | --- |
| `LandlordsController` | `landlords` | `landlords` | `GET /landlords`; `GET /landlords/:slug`; `POST /landlords`; `POST /landlords/:slug/recommendations`; `POST /landlords/:slug/intro-requests` | class **ActiveMember** |
| `AdminLandlordsController` | `admin/landlords` | `landlords` | `GET /admin/landlords`; `POST /admin/landlords`; `GET /admin/landlords/intro-requests`; `PATCH /admin/landlords/intro-requests/:id`; `DELETE /admin/landlords/recommendations/:id`; `PATCH /admin/landlords/:id/status`; `PATCH /admin/landlords/:id`; `DELETE /admin/landlords/:id` | class **Mod/Admin** |

Note: unlike housing-listings and flatmates, the landlord **browse** lives at the
CRUD controller root (`GET /landlords`, `GET /landlords/:slug`) rather than on a
separate `*-directory` path — the collision-avoidance the others get from a split
path is instead achieved here by verb+depth (browse is `GET /:slug`; the writes are
`POST /:slug/*`).

### 1e. `flatmate-profiles` module (`src/flatmate-profiles/`)

Bounded context: **flatmate matching**. Entity `FlatmateProfile`. Imports
`UsersModule`, `MessagingModule`, and `SocialModule` (BlockFilterService for
block severance on detail-by-slug).

| Controller | `@Controller` | Feature | Routes | Guard |
| --- | --- | --- | --- | --- |
| `FlatmateProfilesController` | `flatmate-profiles` | `flatmateProfiles` | `PUT /flatmate-profiles/mine`; `GET /flatmate-profiles/mine`; `DELETE /flatmate-profiles/mine`; `POST /flatmate-profiles/:slug/hello` | class **ActiveMember** |
| `FlatmateDirectoryController` | `flatmate-directory` | `flatmateProfiles` | `GET /flatmate-directory`; `GET /flatmate-directory/:slug` | class **ActiveMember** |

---

## 2. Overlap analysis

There is **no literal route collision** anywhere in this surface — every path is
distinct, and the `:slug`/`:ref` shadowing hazards are each handled (static
segments declared before dynamic params, or split onto a separate top-level
`*-directory` path). The overlap is **organizational and naming-level**, not a set
of duplicated endpoints fighting for the same path. Two patterns stand out:

1. **A repeated three-controller shape.** `housing-listings`, `landlords`, and
   `flatmate-profiles` each implement the same trio: a member CRUD/owner
   controller, a member browse controller, and a Mod/Admin moderation controller.
   `listings` implements a two-controller variant (member write + public browse).
   This is a *convention waiting to be named*, not redundancy to delete.

2. **Inconsistent "browse" path naming.** How the public/member browse of each
   sub-domain is addressed differs case by case:

   | Sub-domain | Browse path today | Shape |
   | --- | --- | --- |
   | Businesses | `/directory` (+ `/directory/:slug`) | bare `directory`, **public** |
   | Housing listings | `/housing-directory` | `{domain}-directory`, member |
   | Flatmates | `/flatmate-directory` | `{domain}-directory`, member |
   | Landlords | `/landlords`, `/landlords/:slug` | browse folded into CRUD root |
   | Co-ops | `/housing/coops` | nested under `/housing`, public |

   The `{domain}-directory` shape (housing, flatmates) is the emergent majority
   convention for member browse; businesses (`/directory`), landlords (browse at
   CRUD root), and co-ops (`/housing/coops`) are the three that diverge from it.

Because nothing actually conflicts at the routing layer, "canonical vs legacy"
below is about **naming/ownership convergence**, not retiring duplicate behavior.

---

## 3. Proposed canonical vs legacy designation

Guiding principle: **preserve every existing path.** No route below is deleted or
moved in place; convergence is achieved purely by *adding* canonical aliases and
marking the divergent originals as deprecated, to be retired only after the
frontend has migrated and telemetry shows the legacy path is cold.

### 3a. Canonical module owners (no change to these — they are the targets)

| Bounded context | Canonical module | Rationale |
| --- | --- | --- |
| Business listings + public directory | **`listings`** | Already one module with the reference "public-read + member-write over one table" split. Canonical as-is. |
| Housing rooms/flats | **`housing-listings`** | Owns `HousingListing`; full three-controller shape already present. |
| Housing co-ops | **`housing`** | Distinct entity (`HousingCoop`) and distinct audience (anonymous join requests). Stays a separate module; only its *path naming* is a convergence candidate. |
| Community landlords | **`landlords`** | Self-contained; canonical. |
| Flatmate matching | **`flatmate-profiles`** | Self-contained; canonical. |

No module in this surface is designated LEGACY. There is no duplicate module to
delete — the earlier housing work produced *cohesive* modules, just with drifting
route names.

### 3b. Canonical route convention (proposed, to be ratified)

Adopt the emergent majority as the rule:

- **Member browse** of a sub-domain lives at **`/{domain}-directory`**.
- **Public browse** of a sub-domain lives at **`/directory`** (businesses, the
  established public surface) or a `/directory/{domain}` sub-path for future public
  browses.
- **Member CRUD/owner** lives at **`/{domain}`** (e.g. `/housing-listings`,
  `/flatmate-profiles`).
- **Moderation** lives at **`/admin/{domain}`**.

Measured against that convention, each current browse path is designated:

| Path today | Designation | Canonical target | Action |
| --- | --- | --- | --- |
| `GET /directory*` (businesses) | **Canonical** | `/directory` | none — it defines the public-browse convention |
| `GET /housing-directory*` | **Canonical** | `/housing-directory` | none — already conforms |
| `GET /flatmate-directory*` | **Canonical** | `/flatmate-directory` | none — already conforms |
| `GET /landlords`, `GET /landlords/:slug` (browse folded into CRUD root) | **Legacy-shape** | `/landlords-directory` (+ keep `/landlords` CRUD writes) | add a conforming `landlords-directory` browse alias; deprecate browse-at-CRUD-root |
| `GET /housing/coops`, `POST /housing/coops/:slug/join-requests` | **Legacy-shape** | e.g. `/housing-coops` (+ `/housing-coops/:slug/join-requests`) or `/directory/co-ops` for the public browse | add conforming alias; deprecate the `/housing/coops` nesting |

"Legacy-shape" means the *behavior* is canonical but the *path naming* diverges
from the convention; the fix is an additive alias, never an in-place move.

---

## 4. Route-preserving migration strategy (deprecation aliases)

The mechanism, in NestJS terms, that lets us converge naming with **zero** breaking
changes:

1. **Add the canonical path as an additional handler, delegating to the same
   service.** For a divergent controller, declare the new canonical route
   alongside the existing one and have both call one service method — no logic is
   duplicated. Example (illustrative, for landlords browse):

   ```ts
   // LandlordsController — existing routes stay EXACTLY as-is.
   @Get()                         // legacy-shape: GET /landlords  (browse)
   browse(@Query() query: BrowseLandlordsQuery) { … }

   // NEW canonical alias, same handler body / same service call.
   // Consider a separate LandlordsDirectoryController(@Controller('landlords-directory'))
   // to mirror HousingDirectoryController / FlatmateDirectoryController exactly.
   ```

   A dedicated `@Controller('landlords-directory')` (mirroring
   `HousingDirectoryController`) is preferable to extra decorators on the CRUD
   controller, because it also makes the browse guardable/feature-flagged
   independently and matches the sibling modules one-for-one.

2. **Mark the legacy path deprecated in OpenAPI** (`@ApiOperation({ deprecated:
   true })`) and, optionally, emit a `Deprecation` / `Sunset` response header from a
   small interceptor on the legacy handlers, so client usage is observable.

3. **Migrate the frontend** to call the canonical paths. This is the coordinated
   step that gates everything after it.

4. **Watch telemetry.** Only once the legacy path shows no traffic for an agreed
   window do we remove the legacy handler. Removal is the *last* step and is a
   separate, revertible change.

5. **Feature flags stay put.** Each controller keeps its existing `@Feature(...)`
   key across the alias so the 404-when-off behavior is unchanged for both the
   legacy and canonical paths.

Crucially, **no path is renamed in place at any point** — new paths are added, old
paths linger as deprecated aliases, and removal happens only after the client no
longer needs them.

---

## 5. Why the merge is deferred

This document is the deliverable; the physical convergence is intentionally **not**
done here, for three concrete reasons:

1. **It needs a running-app verification pass.** Route-matching order (static
   segments before `:slug`/`:ref`), guard composition (`ActiveMemberGuard` not
   honoring `@Public()`), and the `@Feature` 404 behavior are all things that a
   static edit can silently get wrong; they must be exercised against a booted app
   (and its e2e suite) before any alias is trusted. That verification is out of
   scope for a docs pass.

2. **It requires coordinated frontend changes.** Converging the browse-path naming
   only pays off once `listings.api.ts`, the housing/flatmate/landlord API clients,
   and their pages call the canonical paths. Shipping aliases without the FE cutover
   just doubles the surface indefinitely.

3. **There is no forcing bug.** Nothing collides or breaks today — every path is
   distinct and each `:slug` hazard is already handled. This is a *tidiness /
   convention* convergence, so it should ride a deliberate, verified, FE-coordinated
   change rather than being rushed alongside unrelated work.

Until then, treat this document as the map: the canonical module owners in §3a are
stable, the naming convention in §3b is the target, and any new sub-domain in this
surface should be built to the convention from day one so the legacy list does not
grow.
