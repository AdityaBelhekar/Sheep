/**
 * Text similarity, used for three jobs that turn out to be the same job.
 *
 * FRAMING has to notice that four models wrote the same problem statement in
 * different words. HYPOTHESIS has to group near-duplicate hypotheses before
 * anything is scored, or the roster votes twice for whichever idea it happened
 * to phrase twice. Termination has to notice that a round said what the last
 * round already said.
 *
 * All three are "how close are these two pieces of text", so there is one
 * implementation rather than three. It is deliberately lexical — token-set
 * cosine over a stop-listed bag of words — and deliberately not an embedding
 * model: Phase 68 adds a real vector index, and until then a dependency-free
 * measure that is transparent about what it compares is worth more than a
 * better one nobody can inspect. Its ceiling is real, and stated where the
 * thresholds are chosen.
 */

/** Words too common to carry meaning in a research statement. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'about',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'between',
  'both',
  'but',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'may',
  'might',
  'more',
  'most',
  'must',
  'no',
  'not',
  'of',
  'on',
  'or',
  'other',
  'our',
  'over',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'under',
  'up',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'whether',
  'which',
  'while',
  'will',
  'with',
  'would',
]);

/** Lower-cased alphanumeric words, stop-listed, with counts. */
export function tokenise(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP_WORDS.has(raw)) continue;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  return counts;
}

/** Cosine similarity of two token bags, in [0, 1]. Empty text scores 0. */
export function cosineSimilarity(a: string, b: string): number {
  return cosineOfBags(tokenise(a), tokenise(b));
}

export function cosineOfBags(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let dot = 0;
  for (const [token, count] of a) dot += count * (b.get(token) ?? 0);
  if (dot === 0) return 0;

  const norm = (bag: Map<string, number>): number =>
    Math.sqrt([...bag.values()].reduce((sum, n) => sum + n * n, 0));
  return dot / (norm(a) * norm(b));
}

export interface ClusterItem {
  readonly id: string;
  readonly text: string;
  /** Anything the caller needs back out; the clusterer never reads it. */
  readonly source?: string;
}

export interface Cluster {
  /** The item chosen to speak for the group. */
  readonly representative: ClusterItem;
  readonly members: readonly ClusterItem[];
  /** Distinct `source` values among the members — how many models said this. */
  readonly sources: readonly string[];
}

/**
 * Groups near-duplicate texts.
 *
 * Single-link agglomeration against each existing cluster's representative,
 * in input order: a deterministic, order-stable, O(n·k) pass. The
 * representative is the longest member, on the grounds that the fullest
 * statement of an idea is the one worth carrying forward — and every member is
 * kept, so nothing a model said is discarded, only grouped.
 *
 * ponytail: lexical single-link clustering; swap in the Phase 68 vector index
 * if paraphrase detection turns out to matter more than transparency.
 */
export function clusterTexts(items: readonly ClusterItem[], threshold = 0.6): Cluster[] {
  const clusters: {
    representative: ClusterItem;
    members: ClusterItem[];
    bag: Map<string, number>;
  }[] = [];

  for (const item of items) {
    const bag = tokenise(item.text);
    let best: (typeof clusters)[number] | undefined;
    let bestScore = threshold;

    for (const cluster of clusters) {
      const score = cosineOfBags(bag, cluster.bag);
      if (score >= bestScore) {
        best = cluster;
        bestScore = score;
      }
    }

    if (!best) {
      clusters.push({ representative: item, members: [item], bag });
      continue;
    }
    best.members.push(item);
    if (item.text.length > best.representative.text.length) {
      best.representative = item;
      best.bag = bag;
    }
  }

  return clusters.map((cluster) => ({
    representative: cluster.representative,
    members: cluster.members,
    sources: [
      ...new Set(
        cluster.members.flatMap((member) => (member.source === undefined ? [] : [member.source])),
      ),
    ],
  }));
}

/** The highest pairwise similarity in a set. 0 for fewer than two texts. */
export function maxPairwiseSimilarity(texts: readonly string[]): number {
  const bags = texts.map(tokenise);
  let best = 0;
  for (let i = 0; i < bags.length; i += 1) {
    for (let j = i + 1; j < bags.length; j += 1) {
      best = Math.max(best, cosineOfBags(bags[i]!, bags[j]!));
    }
  }
  return best;
}

/** The mean pairwise similarity in a set — how much a round agreed with itself. */
export function meanPairwiseSimilarity(texts: readonly string[]): number {
  const bags = texts.map(tokenise);
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < bags.length; i += 1) {
    for (let j = i + 1; j < bags.length; j += 1) {
      total += cosineOfBags(bags[i]!, bags[j]!);
      pairs += 1;
    }
  }
  return pairs === 0 ? 0 : total / pairs;
}
