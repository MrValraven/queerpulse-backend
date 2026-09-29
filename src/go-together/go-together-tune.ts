import {
  ComponentScores,
  GO_TOGETHER_WEIGHTS,
  ScoredComponent,
} from './go-together-scoring';

export const MIN_TRAINING_ROWS = 300;
const COMPONENTS = Object.keys(GO_TOGETHER_WEIGHTS) as ScoredComponent[];

export interface TrainingExample {
  components: ComponentScores;
  mutualYes: boolean;
}

export interface TuneOptions {
  /** Pull toward the prior weights (scaled); higher means more conservative. */
  l2?: number;
  iterations?: number;
  learningRate?: number;
  /** Every Nth example is held out for validation. */
  holdOutEvery?: number;
}

export interface TuneResult {
  weights: Record<ScoredComponent, number>;
  heldOutLogLoss: number;
  baselineLogLoss: number;
  trainingCount: number;
  heldOutCount: number;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function logLoss(probabilities: number[], labels: boolean[]): number {
  const epsilon = 1e-9;
  return (
    -probabilities.reduce((sum, probability, index) => {
      const clamped = Math.min(1 - epsilon, Math.max(epsilon, probability));
      return sum + (labels[index] ? Math.log(clamped) : Math.log(1 - clamped));
    }, 0) / Math.max(1, probabilities.length)
  );
}

/**
 * L2-regularised logistic regression of "both said yes" on the component
 * scores, shrunk toward the current weights. Step one fits a baseline model on
 * the prior's weighted sum alone (intercept plus one scale); its scaled prior
 * is the shrink target for step two. The output is normalised to sum to 1 and
 * clamped at zero so it can replace `GO_TOGETHER_WEIGHTS` directly, after a
 * human reviews it.
 */
export function fitWeights(
  examples: TrainingExample[],
  options: TuneOptions = {},
): TuneResult {
  const l2 = options.l2 ?? 1;
  const iterations = options.iterations ?? 3000;
  const learningRate = options.learningRate ?? 0.5;
  const holdOutEvery = options.holdOutEvery ?? 5;
  const training = examples.filter((_, index) => index % holdOutEvery !== 0);
  const heldOut = examples.filter((_, index) => index % holdOutEvery === 0);
  const features = (example: TrainingExample): number[] =>
    COMPONENTS.map((component) => example.components[component]);
  const priorSum = (example: TrainingExample): number =>
    COMPONENTS.reduce(
      (sum, component) =>
        sum + GO_TOGETHER_WEIGHTS[component] * example.components[component],
      0,
    );

  let baselineIntercept = 0;
  let baselineScale = 1;
  for (let step = 0; step < iterations; step += 1) {
    let interceptGradient = 0;
    let scaleGradient = 0;
    for (const item of training) {
      const error =
        sigmoid(baselineIntercept + baselineScale * priorSum(item)) -
        (item.mutualYes ? 1 : 0);
      interceptGradient += error;
      scaleGradient += error * priorSum(item);
    }
    baselineIntercept -=
      (learningRate * interceptGradient) / Math.max(1, training.length);
    baselineScale -=
      (learningRate * scaleGradient) / Math.max(1, training.length);
  }

  const target = COMPONENTS.map(
    (component) => GO_TOGETHER_WEIGHTS[component] * baselineScale,
  );
  const weights = [...target];
  let intercept = baselineIntercept;
  for (let step = 0; step < iterations; step += 1) {
    const gradients = new Array<number>(COMPONENTS.length).fill(0);
    let interceptGradient = 0;
    for (const item of training) {
      const values = features(item);
      const linear =
        intercept +
        values.reduce(
          (sum, value, index) => sum + value * (weights[index] ?? 0),
          0,
        );
      const error = sigmoid(linear) - (item.mutualYes ? 1 : 0);
      interceptGradient += error;
      values.forEach(
        (value, index) =>
          (gradients[index] = (gradients[index] ?? 0) + error * value),
      );
    }
    const count = Math.max(1, training.length);
    intercept -= (learningRate * interceptGradient) / count;
    weights.forEach((weight, index) => {
      const penalty = (2 * l2 * (weight - (target[index] ?? 0))) / count;
      weights[index] =
        weight - learningRate * ((gradients[index] ?? 0) / count + penalty);
    });
  }

  const heldOutLabels = heldOut.map((item) => item.mutualYes);
  const tunedProbabilities = heldOut.map((item) =>
    sigmoid(
      intercept +
        features(item).reduce(
          (sum, value, index) => sum + value * (weights[index] ?? 0),
          0,
        ),
    ),
  );
  const baselineProbabilities = heldOut.map((item) =>
    sigmoid(baselineIntercept + baselineScale * priorSum(item)),
  );
  const clamped = weights.map((weight) => Math.max(0, weight));
  const total = clamped.reduce((sum, weight) => sum + weight, 0);
  const normalised = Object.fromEntries(
    COMPONENTS.map((component, index) => [
      component,
      total > 0
        ? (clamped[index] ?? 0) / total
        : GO_TOGETHER_WEIGHTS[component],
    ]),
  ) as Record<ScoredComponent, number>;
  return {
    weights: normalised,
    heldOutLogLoss: logLoss(tunedProbabilities, heldOutLabels),
    baselineLogLoss: logLoss(baselineProbabilities, heldOutLabels),
    trainingCount: training.length,
    heldOutCount: heldOut.length,
  };
}
