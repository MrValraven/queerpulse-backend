/**
 * Fixtures derived from the frontend's `queerpulse/src/features/magazine/`
 * mock content, shaped to insert directly into the `magazine_author` /
 * `magazine_issue` / `magazine_article` tables added by
 * `src/migrations/1782800510000-AddMagazine.ts`.
 *
 * DO NOT RUN as-is against a live table — this file only exports data; it is
 * not wired into `src/database/seed.ts` (per the task's "seed + read-only, do
 * not run" instruction). A future integration would resolve `authorSlug` /
 * `issueNumber` on `articleSeeds` to the real `magazine_author.id` /
 * `magazine_issue.id` inserted from `authorSeeds`/`issueSeeds`, then spread
 * the rows into `manager.getRepository(...).save(...)` calls alongside the
 * other domain fixtures in that file. `magazine_story_submission` has no
 * fixtures — submissions are reader-generated at runtime, not seed content.
 *
 * Source mapping (the FE's magazine mocks aren't fully cross-referenced —
 * `data/articles.tsx`'s 8 real articles use different byline names than
 * `authorContent.data.tsx`'s 8 curated author-page profiles, except "sofia"
 * who is both):
 * - `authorSeeds` <- two sources, merged:
 *   1. `authorContent.data.tsx`'s `AUTHORS` record (8 dedicated magazine
 *      author-page profiles: sara-pinheiro, jonas, luisa, catarina-vaz,
 *      tomas-mendes, anika, sofia, marta-reis). `bio` is `AUTHORS[x].bio`
 *      flattened from JSX to plain text; `avatarUrl` <- `.portrait`.
 *   2. `data/articles.tsx`'s per-article `byline`/`authorBio` for the 6
 *      bylines actually crediting the 8 real articles that aren't already
 *      one of the 8 curated authors (ines, diogo, mariana-costa, tomas,
 *      rui-fernandes, catarina-melo — resolved to full names via
 *      `features/members/data/members.ts`'s `memberName()`). `avatarUrl` is
 *      null — no portrait asset exists for these in the magazine mock.
 * - `issueSeeds` <- `IssuesPage.tsx`'s `ISSUES` array (`num`->number,
 *   `title` flattened from JSX, `dek`, `date` mapped to the 1st of that
 *   month/year as an approximate `publishedOn`; issue 09's exact
 *   "Published 6 Jun 2026" is used verbatim since it's the only issue with a
 *   specific day anywhere in the mock). `coverUrl` is null throughout — every
 *   issue in `ISSUES` is a text placeholder (`cover: "Issue 09 · On Health"`),
 *   not a real image asset; fabricating a URL would misrepresent the source.
 * - `articleSeeds` <- `data/articles.tsx`'s `articles` record (the only mock
 *   with full body/tags content, matching `ArticleResponse` exactly): `id`
 *   ->slug, `title` flattened from JSX, `body` blocks joined with blank
 *   lines (pull quotes inlined as their own paragraph), `tags`, `readTime`
 *   parsed to `readMinutes`. `dek` isn't a field in that file, so it's
 *   sourced per-article from whichever FE mock already has real, on-topic
 *   deck copy for that piece: `magazinePage.data.tsx`'s `FEATURES`/`ESSAYS`/
 *   `INTERVIEWS` card `excerpt` (7 of 8 articles), and for "city-changed"
 *   (the cover story, absent from those card arrays) `authorContent.data.tsx`
 *   sofia's `featured.dek` — which happens to describe the same piece,
 *   since sofia bylines it in both files. All 8 articles are treated as
 *   Issue 09's contents and dated its "Published 6 Jun 2026", matching every
 *   `authorContent.data.tsx` author's `featured.meta` string for that issue.
 *   `section`/`kicker`/`related`/`initials`/`tint`/`image` are FE
 *   presentation-only fields with no home in `ArticleResponse` and are
 *   dropped.
 */

export interface AuthorSeed {
  slug: string;
  name: string;
  bio: string;
  avatarUrl: string | null;
}

export interface IssueSeed {
  number: string;
  title: string;
  dek: string;
  publishedOn: string; // YYYY-MM-DD
  coverUrl: string | null;
}

export interface ArticleSeed {
  slug: string;
  title: string;
  dek: string;
  body: string;
  tags: string[];
  readMinutes: number;
  publishedAt: string; // ISO datetime
  authorSlug: string; // resolves against `authorSeeds`
  issueNumber: string | null; // resolves against `issueSeeds`
}

export const authorSeeds: AuthorSeed[] = [
  // --- Curated magazine author-page profiles (authorContent.data.tsx) ---
  {
    slug: 'sara-pinheiro',
    name: 'Sara Pinheiro',
    bio: 'Sara writes about queer life and the systems that surround it — clinics, classrooms, courtrooms, neighbourhoods. She joined QueerPulse Magazine in 2023 after a decade in public-health reporting at Público and Mensagem de Lisboa. Born in Setúbal, lives in Anjos.',
    avatarUrl:
      'https://images.unsplash.com/photo-1611178204388-1deef70ec66a?q=80&w=400&auto=format&fit=crop',
  },
  {
    slug: 'jonas',
    name: 'Jonas Ferreira',
    bio: "Jonas reports on the quiet infrastructure that keeps queer Lisbon standing — the open clinics, the back rooms, the WhatsApp groups that move faster than any institution. He came to QueerPulse from community radio, and it shows: he'd rather sit in a room for six hours than send an email. Lives in Marvila, mostly on foot.",
    avatarUrl:
      'https://images.unsplash.com/photo-1499887142886-791eca5918cd?q=80&w=400&auto=format&fit=crop',
  },
  {
    slug: 'luisa',
    name: 'Luísa Gomes',
    bio: 'Luísa writes essays about the built world and what it does to the body — waiting rooms, ramps, doorways, the lighting in a place you go to be seen. She trained as an architect and left to write about why buildings so often forget the people inside them. Reads slowly, on purpose. Lives in Campo de Ourique.',
    avatarUrl:
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?q=80&w=400&auto=format&fit=crop',
  },
  {
    slug: 'catarina-vaz',
    name: 'Catarina Vaz',
    bio: 'Catarina writes the long ones — the twenty-minute pieces that follow a single thread across decades. She spent years in the ILGA Portugal archive before she wrote a word, and it taught her that most queer history survives as a phone number someone still remembers. Based in Arroios, usually near a reel-to-reel.',
    avatarUrl:
      'https://images.unsplash.com/photo-1463453091185-61582044d556?q=80&w=400&auto=format&fit=crop',
  },
  {
    slug: 'tomas-mendes',
    name: 'Tomás Mendes',
    bio: 'Tomás writes profiles — the pharmacist who never asks a follow-up question, the nurse still there after twenty years, the people who hold a neighbourhood up without ever being thanked for it. They believe the most political thing a person can do is keep showing up. Lives in Mouraria, knows everyone on the street.',
    avatarUrl:
      'https://images.unsplash.com/photo-1485688809171-248861015a63?q=80&w=400&auto=format&fit=crop',
  },
  {
    slug: 'anika',
    name: 'Anika Kovač',
    bio: 'Anika writes about the people who work the frontlines of care — nurses, outreach workers, the ones on the long shift. She arrived in Lisbon from Ljubljana in 2019 and reports in three languages, mostly from waiting rooms and staff canteens. She thinks burnout is a policy failure, not a character flaw, and writes like it. Lives in Almada.',
    avatarUrl:
      'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?q=80&w=400&auto=format&fit=crop',
  },
  {
    slug: 'sofia',
    name: 'Sofia Andrade',
    bio: "Sofia has been writing about queer life in Lisbon since 2019, and editing it since 2023. She wrote this issue's cover story and edited half the rest — the kind of journalist who's happiest when her own byline isn't the point. Documentary background, interviewer's patience. She's also a QueerPulse member; you can find her in the community too.",
    avatarUrl:
      'https://images.unsplash.com/photo-1484876065684-b683cf17d276?q=80&w=400&auto=format&fit=crop',
  },
  {
    slug: 'marta-reis',
    name: 'Marta Reis',
    bio: 'Marta runs the magazine. She commissions it, edits it, writes the editor’s note, and reads every letter that comes back. She founded QueerPulse Magazine in 2023 with a mailing list and a stubborn belief that a community deserves slow journalism about itself. She writes rarely and cuts ruthlessly. Lives in Graça, answers email at unreasonable hours.',
    avatarUrl:
      'https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?q=80&w=400&auto=format&fit=crop',
  },
  // --- Bylines on the 8 real articles (data/articles.tsx) not already
  // covered above; bio verbatim from each article's own `authorBio`. ---
  {
    slug: 'ines',
    name: 'Inês Tavares',
    bio: 'Inês Tavares writes about community, place, and the social infrastructure of queer life. She has lived in Mouraria for eight years.',
    avatarUrl: null,
  },
  {
    slug: 'diogo',
    name: 'Diogo Vasques',
    bio: 'Diogo Vasques writes about nightlife, music, and the architecture of queer space in Lisbon.',
    avatarUrl: null,
  },
  {
    slug: 'mariana-costa',
    name: 'Mariana Costa',
    bio: 'Mariana Costa covers politics, law, and housing for QueerPulse. She is also a trained housing lawyer who now writes instead of practises.',
    avatarUrl: null,
  },
  {
    slug: 'tomas',
    name: 'Tomás Beto',
    bio: 'Tomás Beto is a writer and musician living in Intendente. This is his second essay for the magazine.',
    avatarUrl: null,
  },
  {
    slug: 'rui-fernandes',
    name: 'Rui Fernandes',
    bio: 'Rui Fernandes is an activist and writer. He co-founded the Lisbon Queer Mental Health Collective in 2022.',
    avatarUrl: null,
  },
  {
    slug: 'catarina-melo',
    name: 'Catarina Melo',
    bio: 'Catarina Melo is a housing rights advocate and occasional essayist. She has lived in the same apartment in Lisbon for eleven years.',
    avatarUrl: null,
  },
];

export const issueSeeds: IssueSeed[] = [
  {
    number: '01',
    title: 'On beginning.',
    dek: 'The inaugural issue. A manifesto, three coming-out stories, and a guide to riso printing in Lisbon.',
    publishedOn: '2024-06-01',
    coverUrl: null,
  },
  {
    number: '02',
    title: 'On time.',
    dek: 'Lateness, queer time, deadlines, lifespans.',
    publishedOn: '2024-09-01',
    coverUrl: null,
  },
  {
    number: '03',
    title: 'On belonging.',
    dek: 'What rooms feel like home, and which ones never will.',
    publishedOn: '2024-12-01',
    coverUrl: null,
  },
  {
    number: '04',
    title: 'On the body.',
    dek: 'Hormones, hairlines, dance floors, sleep. The everyday physical.',
    publishedOn: '2025-03-01',
    coverUrl: null,
  },
  {
    number: '05',
    title: 'On migration.',
    dek: 'Three queer migrants, one civil servant, and what we expect of arrival.',
    publishedOn: '2025-06-01',
    coverUrl: null,
  },
  {
    number: '06',
    title: 'On the city.',
    dek: 'A love letter and an audit. Streets, rents, ghosts, neighbours.',
    publishedOn: '2025-09-01',
    coverUrl: null,
  },
  {
    number: '07',
    title: 'On inheritance.',
    dek: 'Chosen family, archives, recipes, and the houses we leave each other.',
    publishedOn: '2025-12-01',
    coverUrl: null,
  },
  {
    number: '08',
    title: 'On work.',
    dek: 'Studios, side hustles, four-day weeks, and the queer history of the trade union.',
    publishedOn: '2026-03-01',
    coverUrl: null,
  },
  {
    number: '09',
    title: 'On health.',
    dek: 'Twelve pieces about how we keep our bodies, our minds, and each other.',
    publishedOn: '2026-06-06',
    coverUrl: null,
  },
];

const ISSUE_09_PUBLISHED_AT = '2026-06-06T00:00:00.000Z';

export const articleSeeds: ArticleSeed[] = [
  {
    slug: 'city-changed',
    title: 'The city changed. Did we?',
    dek: "Lisbon's queer community has spent a decade finding itself. The rent tripled, the bars closed and reopened and closed again. What survived — and what did we lose?",
    body: [
      'There is a bar in Cais do Sodré that has had five names in nine years. When it was O Farol, you could stay until four in the morning and nobody would ask you to buy another drink. The lights were low enough that everyone looked better than they were, and the music was always slightly too loud to have the kind of conversation that would embarrass you in daylight. We loved it. We took people there the first night we trusted them. Then it became something else, then something else again. Now it has good cocktails and a terrace and it is on three different travel websites. We go back sometimes and feel like strangers.',
      'The decade between 2016 and 2026 remade the city in ways that feel personal even when they are structural. Rents tripled. Whole neighbourhoods changed texture. The queer community that had quietly assembled itself in Mouraria and Intendente found itself increasingly legible to a city that, for a long time, had simply not noticed it was there. That legibility was a victory and a complication simultaneously.',
      'We became more deliberate about what we chose to stay for. That is not the same as choosing to stay.',
      'What I keep coming back to, talking to people who were here for all of it, is how external pressure accelerated something internal. The community that came through that decade is not the community that entered it. It lost spaces and gained practices. The informal structures — the kitchens, the group chats, the particular table at the particular café on Sunday — survived better than the formal ones. The bars closed. The friendships did not.',
      'A new generation arrived and asked different questions. They wanted to know about structure, consent, how decisions got made. They were not wrong to ask. But they arrived into a community built in the dark, by people who built it because they had nowhere else to be, and some of what looked like chaos to newcomers was accumulated knowledge that had never been written down.',
      'Did we change? I think we became more deliberate. You do not end up in a queer chosen family by accident anymore. You choose it — with the awareness that other things are available, that the choosing has meaning. Whether that is better or worse than the earlier version, when you ended up together because there was no other option, I am not sure. But it is different. And I think it is ours.',
    ].join('\n\n'),
    tags: ['Lisbon', 'Community', 'Gentrification'],
    readMinutes: 12,
    publishedAt: ISSUE_09_PUBLISHED_AT,
    authorSlug: 'sofia',
    issueNumber: '09',
  },
  {
    slug: 'mouraria-family',
    title: "Mouraria's chosen family, ten years later",
    dek: 'The original group is scattered. Some left Lisbon. Two died. The rest still meet on the same corner. A decade on, what holds a chosen family together?',
    body: [
      'The original group met at a language exchange in 2016. There were seven of them — some Portuguese, some Brazilian, one from Cape Verde, one from Germany who never quite left. They did not set out to become a family. They set out to practise their Spanish on a Tuesday evening in a bar that served free olives and had too many candles.',
      'Of those seven, two have left Lisbon. One moved to Porto for work and visits twice a year. One moved to Berlin in 2022 after the third rent increase in two years and has not come back. Two of the original group died: Rui, in 2021, from cancer he did not mention until it was advanced; and Filipa, in an accident in 2023 that nobody who knew her has yet found the right language for.',
      'A chosen family is not chosen once. It is chosen again and again, through inconvenience and absence.',
      'The three who remain in Lisbon still meet on the same corner in Mouraria on the first Sunday of every month. Not always all three — sometimes it is two, sometimes one sits there for an hour waiting to see if anyone will come. They do not talk about it as maintenance. It does not feel like that to them. It feels like showing up for something that has already been decided.',
      'What holds a chosen family together, I have come to think, is not affection. Affection comes and goes. What holds it is the accumulated evidence that you showed up when it was inconvenient — the hospital waiting rooms, the 2am phone calls, the times you left a party early because someone needed you. You were not obligated to any of it. The family is made entirely of choices, which is what makes it mean what it means.',
    ].join('\n\n'),
    tags: ['Community', 'Chosen family', 'Lisbon'],
    readMinutes: 9,
    publishedAt: ISSUE_09_PUBLISHED_AT,
    authorSlug: 'ines',
    issueNumber: '09',
  },
  {
    slug: 'last-bar',
    title: "The last queer bar in Bairro Alto that isn't trying",
    dek: 'No Instagram. No theme nights. No cocktail menu. Just a room, a sound system, and forty years of the community walking through the same door.',
    body: [
      'There is no sign. There has never been a sign. The address circulates by word of mouth, the way addresses used to before everyone had a phone and a map in their pocket. If you find it, you find it. The bar — I am not naming it here because the owner asked me not to — has been open since 1987, which means it survived the AIDS crisis, two recessions, three rounds of Bairro Alto gentrification, and the arrival of the internet.',
      "The owner, whose name I will give only as Paulo, is in his sixties. He has worked behind this bar for thirty-seven years. He does not have Instagram. He did not apply for any of the city's LGBTQ+ venue support grants. He closes when he feels like closing and opens when he feels like opening, and this erratic schedule appears to be part of the loyalty structure rather than a failure of management.",
      'No Instagram. No theme nights. No cocktail menu. Just a room, a sound system, and forty years of the community walking through the same door.',
      'What strikes me about the place is how much it resembles a very well-maintained ruin. Nothing has been renovated. The bar stools are original. The lighting has never been updated, which means it operates at the exact luminosity of 1987 nightlife — dark enough to be kind, light enough to find your way to the bathroom.',
      'Paulo is not sentimental about any of this. I asked him why he hadn\'t updated the decor. He said: "Updated for who?" I did not have a good answer. Neither, I think, does the city that keeps trying to turn Bairro Alto into something else. Some places resist not through effort but through a kind of stubborn self-similarity.',
    ].join('\n\n'),
    tags: ['Nightlife', 'Lisbon', 'Queer space'],
    readMinutes: 7,
    publishedAt: ISSUE_09_PUBLISHED_AT,
    authorSlug: 'diogo',
    issueNumber: '09',
  },
  {
    slug: 'housing-law',
    title: 'What the new housing law actually means for us',
    dek: 'The legislation passed in April. We spoke to three housing lawyers and four community members already living its consequences.',
    body: [
      'The legislation that passed in April amends three articles of the urban rental law and introduces a new category of "social vulnerability" that can delay evictions by sixty days. The amendment is well-intentioned. It is also, as three housing lawyers independently told me, likely to produce outcomes its drafters did not anticipate — particularly for queer households whose structure the law does not recognise.',
      'The key provision is the sixty-day eviction delay for households qualifying as socially vulnerable. Queer households — same-sex couples, single transgender people, chosen-family living arrangements — are not automatically included in that definition. You have to apply. The application requires documentation. And the documentation required assumes a family structure that many queer households simply do not have.',
      'The law does not recognise chosen family as a category. Your flatmates of eight years are legally strangers.',
      'Ana, 34, has lived in the same apartment in Intendente with her partner and two chosen-family housemates for six years. Their landlord sent a non-renewal notice in March. Under the new law, she and her partner may qualify for the delay. Their housemates do not. "We cannot afford to lose two of us and keep two," she told me. "Either we all stay or none of us does. The law doesn\'t understand that."',
      'I spoke to the office of the MP who co-sponsored the amendment. They acknowledged the gap and said it would be addressed in a follow-up regulation expected in late 2026. Housing lawyers I consulted were sceptical. The community should know: the law is an improvement. It is not a solution.',
    ].join('\n\n'),
    tags: ['Housing', 'Politics', 'Chosen family'],
    readMinutes: 14,
    publishedAt: ISSUE_09_PUBLISHED_AT,
    authorSlug: 'mariana-costa',
    issueNumber: '09',
  },
  {
    slug: 'i-arrived',
    title: "I didn't come out. I arrived.",
    dek: 'On becoming queer as arrival rather than revelation — and why the community gave me the language for the identity, not the other way around.',
    body: [
      'I have been trying to remember the moment I came out and I cannot find it. My memory will not produce a door, a revelation, a conversation where everything changed. What it produces is a series of Tuesdays: someone laughing at something I said and me feeling, for the first time, that the laugh was for me and not despite me.',
      'Coming out implies a before and an after. It implies a version of you living in a room, and then the door opened, and now you are in the hallway, visible. But I was never in a room. I was just not quite arrived. I was doing the thing where you speak slightly quieter than you mean to.',
      'The community did not follow my identity. My identity followed the community.',
      'The moment I date everything from is not a conversation. It is being on a rooftop in Mouraria in late 2019, watching the sun go down over the river with four people I had met that year, and noticing that I had stopped monitoring myself. I had not decided to stop. I had just run out of things to monitor.',
      'Becoming queer — and I do mean becoming, not discovering — was not a private thing that happened inside me and then I announced. It happened in rooms with other people. The community gave me the language for the identity. Then the identity became possible.',
    ].join('\n\n'),
    tags: ['Identity', 'Community', 'Coming out'],
    readMinutes: 8,
    publishedAt: ISSUE_09_PUBLISHED_AT,
    authorSlug: 'tomas',
    issueNumber: '09',
  },
  {
    slug: 'visibility-politics',
    title: 'On visibility, and who it actually serves',
    dek: 'Visibility saves lives. The data says so. But whose visibility are we building infrastructure for — and is the billboard kind ever enough?',
    body: [
      'Every June, we are told that visibility saves lives. And it does. There is data. Young queer people who see queer adults existing in the world are statistically less likely to hurt themselves. This is true and it matters and I am not arguing against it.',
      'What I want to ask is: whose visibility are we talking about? The queer person in the ad campaign. The celebrity who came out to twelve million followers. These are real forms of visibility and they help real people. But they are not most people I know. Most people I know are visible in small, exhausting ways — visible to their landlord, visible in job interviews where they mention something and feel the temperature shift.',
      'Real visibility is not the absence of danger — it is the presence of ease. It is the unclenching.',
      "Real visibility is having the thing you say received normally. It is showing up somewhere and not running a quick calculation about whether this is safe. We have built a great deal of infrastructure for the billboard kind of visibility. We have built far less for the kind that happens in a doctor's office, or a workplace meeting, or a family kitchen.",
      'I am not against Pride. I am against the substitution of these things for the harder work of building the infrastructure of ordinary ease. The test of a queer-friendly environment is not whether it has a rainbow in the logo. It is whether a queer person who works there can mention their partner without having to decide, first, whether it is worth it.',
    ].join('\n\n'),
    tags: ['Visibility', 'Identity', 'Politics'],
    readMinutes: 7,
    publishedAt: ISSUE_09_PUBLISHED_AT,
    authorSlug: 'rui-fernandes',
    issueNumber: '09',
  },
  {
    slug: 'politics-of-staying',
    title: 'The politics of staying',
    dek: 'Everyone who left had a reasonable reason. But rebuilding the informal infrastructure of a queer life is specific, slow work — and the staying was the building.',
    body: [
      'Everyone I know who left Lisbon has a reasonable reason. The rent went up. A better opportunity appeared elsewhere. A relationship ended. These are not bad reasons. But when I try to understand why I stayed, I keep coming back to something less rational: I stayed because I was afraid of starting again.',
      'The person who already knows you. The bar you go to when you need to be around your people without explaining yourself. The WhatsApp group where the thing you felt this week has already been felt. None of this is small. In fact, I think it is the whole thing. Queer life is primarily the infrastructure, not the events.',
      'The queer space I rely on most cannot be relocated. It took years to build. The staying was the building.',
      "People talk about queer spaces as if they mean bars and venues. Sometimes they do. But the queer space I rely on most is the annual dinner at Paulo's kitchen where we are now too many people for the table and someone always eats on the stairs.",
      'Staying is a form of investment. It is boring and expensive and sometimes politically complicated, and I have never once regretted it.',
    ].join('\n\n'),
    tags: ['Housing', 'Lisbon', 'Community'],
    readMinutes: 6,
    publishedAt: ISSUE_09_PUBLISHED_AT,
    authorSlug: 'catarina-melo',
    issueNumber: '09',
  },
  {
    slug: 'kiko-neves',
    title: '"The audience at my worst gig taught me more than my best one"',
    dek: "Kiko Neves on improvisation, Marvila, and what it means to make queer jazz in a city that hasn't quite decided what it is yet.",
    body: [
      'Q: You started playing in Marvila before it became Marvila. What was that like?',
      'A: An untuned piano and audiences who had made an effort to get there. That changes everything. When people leave their house, take two buses, arrive somewhere uncertain — they are already in a different mode. You can slow down. You can fail.',
      'Q: When you say "queer jazz," what do you actually mean?',
      "A: Music that doesn't perform certainty. Music comfortable with not arriving at the place it thought it was going. The queer form wants to stay somewhere interesting for as long as possible. To treat the unresolved thing as the destination rather than the problem.",
      'I went home and wrote for six hours because of that comment. Constraint is clarifying.',
      'Q: Tell me about the worst gig.',
      'A: 2022. Eleven people. Three left early. One asked me afterwards if I had considered playing something more fun. I went home and wrote for six hours. The best gig was the album release — everyone there, perfect energy — and I felt almost nothing. There is something about resistance and constraint that I apparently require.',
      "Q: What does Lisbon give you that another city wouldn't?",
      'A: The light is not a cliché. It does something specific to time. And the city is still small enough that you run into people. Three of my collaborations started in queues. You cannot engineer that. You can only stay and let it happen.',
    ].join('\n\n'),
    tags: ['Music', 'Lisbon', 'Identity'],
    readMinutes: 10,
    publishedAt: ISSUE_09_PUBLISHED_AT,
    authorSlug: 'sofia',
    issueNumber: '09',
  },
];
