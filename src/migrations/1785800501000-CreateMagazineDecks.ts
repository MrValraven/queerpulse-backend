import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `magazine_deck` — the interactive slide-deck magazine format
 * (`SlideDeck` / `Slide` union on the frontend, `queerpulse/src/features/
 * magazine/data/decks.tsx`). `slides` is stored verbatim as `jsonb`; the
 * backend treats it as opaque authored JSON, validated at the service
 * boundary (`deck-slides.validation.ts`), never by TypeORM. Draft/published
 * via the repo's nullable-`publishedAt` idiom (`MagazineArticle` /
 * `ContentPage` precedent), not a status enum — reads gate on
 * `published_at <= now()`.
 *
 * Seeds the published "ten-years-mouraria" deck (the frontend's only demo
 * deck, `decks.mock.tsx`) so `/magazine/decks/ten-years-mouraria` has a real
 * row the moment live mode is wired up. The seed's `title` is a plain
 * string ("Ten years in Mouraria, slide by slide") — the mock's JSX title
 * (`<em>slide by slide</em>`) has no backend equivalent (`title` is a plain
 * `varchar`; see the design doc's "Out of scope"). Slide `heading`/`body`/
 * `label`/`prompt` JSX in the mock is flattened to plain strings here for
 * the same reason. `byline`/`role` resolve the mock's `memberName("ines")` /
 * `memberName("andre")` calls to their plain display names ("Inês Tavares",
 * "André Quintela") since this migration has no access to the frontend's
 * member registry at seed time.
 */
export class CreateMagazineDecks1785800501000 implements MigrationInterface {
  name = 'CreateMagazineDecks1785800501000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "magazine_deck" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "title" character varying NOT NULL,
        "kicker" character varying NOT NULL DEFAULT '',
        "section" character varying NOT NULL DEFAULT '',
        "byline" character varying NOT NULL DEFAULT '',
        "role" character varying,
        "author_bio" text NOT NULL DEFAULT '',
        "cover" character varying NOT NULL DEFAULT '',
        "cover_desc" character varying NOT NULL DEFAULT '',
        "read_time" character varying NOT NULL DEFAULT '',
        "tags" text[] NOT NULL DEFAULT '{}',
        "related" text[] NOT NULL DEFAULT '{}',
        "slides" jsonb NOT NULL DEFAULT '[]',
        "published_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_magazine_deck" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_magazine_deck_slug" ON "magazine_deck" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_deck_published_at" ON "magazine_deck" ("published_at")`,
    );

    // --- seed: "ten-years-mouraria" (mirrors decks.mock.tsx) ----------------
    await queryRunner.query(`
      INSERT INTO "magazine_deck"
        ("slug", "title", "kicker", "section", "byline", "role", "author_bio", "cover", "cover_desc", "read_time", "tags", "related", "slides", "published_at")
      VALUES (
        'ten-years-mouraria',
        'Ten years in Mouraria, slide by slide',
        'Interactive · Feature',
        'Features',
        'Inês Tavares',
        'Photography by André Quintela',
        'Inês Tavares writes about community, place, and the social infrastructure of queer life. She has lived in Mouraria for eight years.',
        'https://images.unsplash.com/photo-1601977078202-8825cd23ddf3?q=80&w=1000&auto=format&fit=crop',
        'Narrow street in Mouraria, late afternoon light, laundry lines overhead',
        '7 slides · 4 min',
        ARRAY['Community', 'Chosen family', 'Lisbon']::text[],
        ARRAY['mouraria-family', 'city-changed']::text[],
        '[
          {
            "layout": "text",
            "align": "center",
            "eyebrow": "Interactive",
            "heading": "A decade on one corner",
            "body": "Seven of them met at a language exchange in 2016. This is what the next ten years did to a chosen family — one slide at a time."
          },
          {
            "layout": "image",
            "src": "https://images.unsplash.com/photo-1601977078202-8825cd23ddf3?q=80&w=1400&auto=format&fit=crop",
            "alt": "Narrow Mouraria street with laundry lines overhead at dusk",
            "tint": "jade",
            "caption": "The corner in Mouraria where they still meet, first Sunday of every month."
          },
          {
            "layout": "stat",
            "value": "×3",
            "label": "Rents in the neighbourhood tripled between 2016 and 2026.",
            "source": "Lisbon housing observatory, 2026",
            "tint": "coral"
          },
          {
            "layout": "text",
            "align": "center",
            "pull": "A chosen family is not chosen once. It is chosen again and again, through inconvenience and absence."
          },
          {
            "layout": "interactive",
            "kind": "before-after",
            "before": {
              "src": "https://images.unsplash.com/photo-1601977078202-8825cd23ddf3?q=80&w=1200&auto=format&fit=crop",
              "alt": "The street in warm afternoon light",
              "label": "2016"
            },
            "after": {
              "src": "https://images.unsplash.com/photo-1693323588991-42119b16994b?q=80&w=1200&auto=format&fit=crop",
              "alt": "The same neighbourhood, rooftops at golden hour",
              "label": "2026"
            }
          },
          {
            "layout": "interactive",
            "kind": "reveal",
            "tint": "plum",
            "prompt": "What held them together for ten years?",
            "hidden": "Not affection — affection comes and goes. The accumulated evidence that you showed up when it was inconvenient."
          },
          {
            "layout": "text",
            "align": "center",
            "heading": "Three of them still come",
            "body": "Sometimes two. Sometimes one sits for an hour to see if anyone will. They do not call it maintenance. It feels like showing up for something already decided."
          }
        ]'::jsonb,
        now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "magazine_deck"`);
  }
}
