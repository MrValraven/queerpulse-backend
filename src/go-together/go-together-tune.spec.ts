import { GO_TOGETHER_WEIGHTS, ComponentScores } from './go-together-scoring';
import { TrainingExample, fitWeights } from './go-together-tune';
import { createRandom } from './go-together-grouping';

function example(
  random: () => number,
  informative: 'humour' | 'values',
): TrainingExample {
  const components: ComponentScores = {
    values: random(),
    interests: random(),
    energyIntent: random(),
    humour: random(),
    music: random(),
    ageArea: random(),
    hostBonus: 0,
  };
  return { components, mutualYes: components[informative] > 0.6 };
}

describe('fitWeights', () => {
  it('returns weights that sum to 1 and are never negative', () => {
    const random = createRandom(3);
    const result = fitWeights(
      Array.from({ length: 600 }, () => example(random, 'humour')),
    );
    const total = Object.values(result.weights).reduce(
      (sum, weight) => sum + weight,
      0,
    );
    expect(total).toBeCloseTo(1);
    expect(Object.values(result.weights).every((weight) => weight >= 0)).toBe(
      true,
    );
  });

  it('moves weight toward the component that actually predicts a mutual yes', () => {
    const random = createRandom(4);
    const result = fitWeights(
      Array.from({ length: 800 }, () => example(random, 'humour')),
    );
    expect(result.weights.humour).toBeGreaterThan(GO_TOGETHER_WEIGHTS.humour);
    expect(result.heldOutLogLoss).toBeLessThan(result.baselineLogLoss);
  });

  it('stays at the prior when the data carries no signal', () => {
    const random = createRandom(5);
    const noise = Array.from({ length: 600 }, () => ({
      ...example(random, 'humour'),
      mutualYes: random() > 0.5,
    }));
    const result = fitWeights(noise, { l2: 50 });
    for (const [component, weight] of Object.entries(result.weights)) {
      expect(
        Math.abs(
          weight -
            GO_TOGETHER_WEIGHTS[component as keyof typeof GO_TOGETHER_WEIGHTS],
        ),
      ).toBeLessThan(0.08);
    }
  });
});
