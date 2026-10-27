import { createHash } from 'node:crypto';
import {
  QUIZSHOW_TEMPLATE_SEEDS_1837900000000 as seeds,
  type QuizshowTemplateSeed,
} from '../migrations/data/quizshow-templates-1837900000000.seed';
import {
  completenessProblems,
  structuralProblems,
} from '../quizshow/quizshow-quiz-validation';

/** Printed by the one-off generator over the retired catalog values. */
const ORIGINAL_PACKS_SHA256 =
  '95a9b750a235b4d6d16a182f5c898a51e24ecd5b1c16514865446a5e4f6de8cf';
/** Printed by the one-off generator over every `// Source:` note, in file order. */
const ORIGINAL_SOURCES_SHA256 =
  '6f8a3651abd4bd835c847490e85a50a988928cd09b7efc0335b3d664d3b009fb';

const NOTE_LABEL_PATTERN = /^Round \d+, question \d+: /;

type QuizShape = Parameters<typeof structuralProblems>[0];

function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function noteLinesOf(seed: QuizshowTemplateSeed): string[] {
  return seed.staffNotes.split('\n');
}

function seedWithKey(packKey: string): QuizshowTemplateSeed {
  const seed = seeds.find((candidate) => candidate.packKey === packKey);
  if (seed === undefined) {
    throw new Error(`Expected a seed for ${packKey}`);
  }
  return seed;
}

function questionCountOf(seed: QuizshowTemplateSeed): number {
  return seed.quiz.rounds.reduce(
    (runningTotal, round) => runningTotal + round.questions.length,
    0,
  );
}

/** Every string anywhere under `value`. */
function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStrings(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap((entryValue) =>
      collectStrings(entryValue),
    );
  }
  return [];
}

describe('Frozen quizshow template seeds', () => {
  it('holds the five packs in catalog order with their fixed ids', () => {
    expect(seeds.map((seed) => seed.packKey)).toEqual([
      'pride_history',
      'portuguese_queer_culture',
      'eurovision',
      'drag_herstory',
      'lisbon_queer_icons',
    ]);
    expect(seeds.map((seed) => seed.id)).toEqual([
      'a7e3b1c0-5eed-4000-8000-000000000001',
      'a7e3b1c0-5eed-4000-8000-000000000002',
      'a7e3b1c0-5eed-4000-8000-000000000003',
      'a7e3b1c0-5eed-4000-8000-000000000004',
      'a7e3b1c0-5eed-4000-8000-000000000005',
    ]);
  });

  it('keeps every question, round and setting of the retired catalog', () => {
    const projection = seeds.map((seed) => ({
      key: seed.packKey,
      title: seed.cardTitle,
      description: seed.cardDescription,
      quiz: seed.quiz,
    }));
    expect(sha256Of(JSON.stringify(projection))).toBe(ORIGINAL_PACKS_SHA256);
  });

  it('keeps every source note in file order', () => {
    const notes = seeds
      .flatMap((seed) => noteLinesOf(seed))
      .map((line) => line.replace(NOTE_LABEL_PATTERN, ''));
    expect(notes).toHaveLength(83);
    expect(sha256Of(notes.join('\n'))).toBe(ORIGINAL_SOURCES_SHA256);
  });

  it('labels every note by its round and question position', () => {
    for (const seed of seeds) {
      const expectedLabels = seed.quiz.rounds.flatMap((round, roundIndex) =>
        round.questions.map(
          (_question, questionIndex) =>
            `Round ${roundIndex + 1}, question ${questionIndex + 1}: `,
        ),
      );
      const labels = noteLinesOf(seed).map(
        (line) => NOTE_LABEL_PATTERN.exec(line)?.[0] ?? null,
      );
      expect(labels).toEqual(expectedLabels);
    }
  });

  it('counts rounds and questions per pack', () => {
    expect(seeds.map((seed) => seed.quiz.rounds.length)).toEqual([
      3, 3, 3, 3, 4,
    ]);
    const questionCounts = seeds.map((seed) => questionCountOf(seed));
    expect(questionCounts).toEqual([15, 15, 15, 15, 23]);
    expect(
      questionCounts.reduce((runningTotal, count) => runningTotal + count, 0),
    ).toBe(83);
  });

  it('pins a few exact values', () => {
    const prideSeed = seedWithKey('pride_history');
    expect(noteLinesOf(prideSeed)[0]).toBe(
      'Round 1, question 1: US National Park Service, Stonewall National Monument (nps.gov/ston): the Stonewall Inn, 53 Christopher Street, Greenwich Village.',
    );
    expect(seeds[0]?.quiz.rounds[0]?.questions[0]?.answer).toEqual({
      correctIndex: 1,
    });
    expect(noteLinesOf(seedWithKey('drag_herstory'))).toContain(
      'Round 3, question 1: none needed, a word game with no facts in it.',
    );
    const lisbonSeed = seedWithKey('lisbon_queer_icons');
    const lisbonLines = noteLinesOf(lisbonSeed);
    expect(
      lisbonLines[lisbonLines.length - 1]?.startsWith(
        'Round 4, question 4: Wikipedia "Francisco Correa Netto"',
      ),
    ).toBe(true);
    expect(lisbonSeed.quiz.screenLanguage).toBe('pt');
    expect(seeds[0]?.cardTitle).toEqual({
      en: 'Pride and queer history',
      pt: 'Orgulho e história queer',
    });
  });

  it('passes the structural and the completeness checks and holds no adults round and no image', () => {
    for (const seed of seeds) {
      const quiz = seed.quiz as unknown as QuizShape;
      expect(structuralProblems(quiz)).toEqual([]);
      expect(completenessProblems(quiz)).toEqual([]);
      for (const round of seed.quiz.rounds) {
        expect(round.contentLabel).not.toBe('adults');
        for (const question of round.questions) {
          expect(question.mediaRef).toBeNull();
        }
      }
    }
  });

  it('fits the card and notes limits', () => {
    for (const seed of seeds) {
      expect(seed.cardTitle.en.length).toBeLessThanOrEqual(120);
      expect(seed.cardTitle.pt.length).toBeLessThanOrEqual(120);
      expect(seed.cardDescription.en.length).toBeLessThanOrEqual(300);
      expect(seed.cardDescription.pt.length).toBeLessThanOrEqual(300);
      expect(seed.staffNotes.length).toBeLessThanOrEqual(20000);
    }
  });

  it('leaves out the retired myths', () => {
    const serialized = JSON.stringify(seeds);
    expect(serialized).not.toContain('Galvão de Melo');
    expect(serialized).not.toMatch(/first gay novel/i);
    const allStrings = collectStrings(seeds);
    expect(allStrings.length).toBeGreaterThan(0);
    for (const text of allStrings) {
      expect(/Cesariny/.test(text) && /Paris/.test(text)).toBe(false);
    }
  });
});
