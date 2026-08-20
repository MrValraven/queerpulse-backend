import { randomUUID } from 'node:crypto';
import { ArticleBlock } from './entities/magazine-article.entity';
import { DeckSlide } from './entities/magazine-deck.entity';

/** Result of `mapDeckSlidesToArticleBlocks` — see its doc comment. */
export interface DeckToArticleConversion {
  blocks: ArticleBlock[];
  /** Human-readable labels for slides with no article-block equivalent that
   *  were dropped (e.g. "before-after (slide 3)") — CNT-6 "Convert" surfaces
   *  these to the editor rather than silently losing content. */
  droppedSlideKinds: string[];
}

/**
 * Best-effort, lossy transform of a deck's slides into article blocks
 * (CNT-6 "Convert" — deck→article is a one-way, one-time operation; there is
 * no article→deck path). `text` slides become a `paragraph` block (heading/
 * body/pull joined, since `ArticleBlock` has no equivalent of a slide
 * heading), `image` becomes an `image` block, `stat` becomes a one-item
 * `stats` block. `interactive` slides (`before-after`, `reveal`) have no
 * article-block equivalent at all and are dropped — the caller
 * (`MagazinePieceService.convertDeckToArticle`) surfaces which ones so the
 * editor is told honestly what didn't carry over, never a silent full-success
 * claim. A slide that maps to no content (e.g. an empty text slide) is
 * skipped without being counted as "dropped" — it never held any content to
 * lose in the first place.
 */
export function mapDeckSlidesToArticleBlocks(
  slides: DeckSlide[],
): DeckToArticleConversion {
  const blocks: ArticleBlock[] = [];
  const droppedSlideKinds: string[] = [];

  slides.forEach((slide, index) => {
    const position = index + 1;
    switch (slide.layout) {
      case 'text': {
        const html = [slide.heading, slide.body, slide.pull]
          .filter((part): part is string =>
            Boolean(part && part.trim().length > 0),
          )
          .join('<br/><br/>');
        if (html.length > 0) {
          blocks.push({ id: randomUUID(), kind: 'paragraph', html });
        }
        break;
      }
      case 'image': {
        blocks.push({
          id: randomUUID(),
          kind: 'image',
          alt: slide.alt,
          caption: slide.caption ?? '',
          credit: '',
          rights: 'courtesy',
          tint: 'plum',
          crop: '16:9',
          focal: { x: 0.5, y: 0.5 },
          src: slide.src,
        });
        break;
      }
      case 'stat': {
        blocks.push({
          id: randomUUID(),
          kind: 'stats',
          items: [{ value: slide.value, label: slide.label }],
        });
        break;
      }
      case 'interactive': {
        droppedSlideKinds.push(`${slide.kind} (slide ${position})`);
        break;
      }
    }
  });

  return { blocks, droppedSlideKinds };
}
