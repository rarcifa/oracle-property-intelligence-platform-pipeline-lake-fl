/**
 * Latent semantic indexing: dense vectors with no model and no API key.
 *
 * The brief for this layer was that it must work with no paid embedding key at
 * build time and none at boot. A transformer would satisfy the first half and
 * fail the second: embedding the *query* still needs the model, which would put
 * a 90 MB ONNX runtime in the server's boot path.
 *
 * LSA satisfies both. Truncated SVD of the TF-IDF matrix gives every chunk a
 * dense vector whose dimensions are co-occurrence patterns rather than words, so
 * a question that shares no vocabulary with a chunk can still match it through
 * the terms they both co-occur with. A query folds into the same space with one
 * sparse multiply against the index the lexical scorer already loads — no model,
 * no network, microseconds.
 *
 * The honest limitation, stated because it matters: LSA learns its semantics
 * from this corpus alone. It generalises across the vocabulary of these
 * documents, not across English. That is why it is one signal of four rather
 * than the whole retriever.
 */

/** A single chunk's sparse TF-IDF row: term index to L2-normalised weight. */
export type SparseRow = Map<number, number>;

/** Deterministic PRNG, so a rebuild of the index is byte-identical. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inverse document frequency, smoothed. */
export function idfOf(documentCount: number, documentFrequency: number): number {
  return Math.log((documentCount + 1) / (documentFrequency + 1)) + 1;
}

/** L2-normalise a sparse row in place and return it. */
export function normalizeSparse(row: SparseRow): SparseRow {
  let sum = 0;
  for (const value of row.values()) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return row;
  for (const [key, value] of row) row.set(key, value / norm);
  return row;
}

/** L2-normalise a dense vector in place and return it. */
export function normalizeDense(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] as number) / norm;
  return vector;
}

/** Dot product of two sparse rows, iterating the shorter one. */
export function sparseDot(left: SparseRow, right: SparseRow): number {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let sum = 0;
  for (const [key, value] of small) {
    const other = large.get(key);
    if (other !== undefined) sum += value * other;
  }
  return sum;
}

/** Gram matrix `X Xᵀ` of the sparse TF-IDF rows. */
export function gramMatrix(rows: readonly SparseRow[]): number[][] {
  const n = rows.length;
  const gram: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    const rowI = rows[i] as SparseRow;
    for (let j = i; j < n; j += 1) {
      const value = sparseDot(rowI, rows[j] as SparseRow);
      (gram[i] as number[])[j] = value;
      (gram[j] as number[])[i] = value;
    }
  }
  return gram;
}

export interface Eigen {
  /** `k` eigenvectors, each of length `n`. */
  vectors: number[][];
  /** `k` eigenvalues, descending. */
  values: number[];
}

/**
 * Top-`k` eigenpairs of a symmetric matrix by power iteration with deflation.
 *
 * The gram matrix here is at most a few hundred square, so the simple algorithm
 * is both fast enough and easier to prove deterministic than a library call.
 */
export function topEigen(
  matrix: readonly number[][],
  k: number,
  iterations = 300,
  seed = 0x0ace1e5e,
): Eigen {
  const n = matrix.length;
  const wanted = Math.max(1, Math.min(k, n));
  const random = mulberry32(seed);
  const vectors: number[][] = [];
  const values: number[] = [];

  for (let component = 0; component < wanted; component += 1) {
    let vector = Array.from({ length: n }, () => random() * 2 - 1);
    normalizeDense(vector);

    for (let step = 0; step < iterations; step += 1) {
      const next = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i += 1) {
        const row = matrix[i] as readonly number[];
        let sum = 0;
        for (let j = 0; j < n; j += 1) sum += (row[j] as number) * (vector[j] as number);
        next[i] = sum;
      }
      // Deflate: keep the iterate orthogonal to every component already found.
      for (const found of vectors) {
        let projection = 0;
        for (let i = 0; i < n; i += 1) projection += (next[i] as number) * (found[i] as number);
        for (let i = 0; i < n; i += 1)
          next[i] = (next[i] as number) - projection * (found[i] as number);
      }
      let norm = 0;
      for (const value of next) norm += value * value;
      if (Math.sqrt(norm) < 1e-12) break;
      normalizeDense(next);
      vector = next;
    }

    // Rayleigh quotient gives the eigenvalue for the converged vector.
    let eigenvalue = 0;
    for (let i = 0; i < n; i += 1) {
      const row = matrix[i] as readonly number[];
      let sum = 0;
      for (let j = 0; j < n; j += 1) sum += (row[j] as number) * (vector[j] as number);
      eigenvalue += (vector[i] as number) * sum;
    }
    if (eigenvalue <= 1e-10) break;

    // Eigenvectors are sign-ambiguous; pin the sign so rebuilds are identical.
    let extreme = 0;
    for (let i = 1; i < n; i += 1) {
      if (Math.abs(vector[i] as number) > Math.abs(vector[extreme] as number)) extreme = i;
    }
    if ((vector[extreme] as number) < 0) {
      for (let i = 0; i < n; i += 1) vector[i] = -(vector[i] as number);
    }

    vectors.push(vector);
    values.push(eigenvalue);
  }

  return { vectors, values };
}

export interface LatentSpace {
  /** Left singular vectors, `n × k`. */
  singularVectors: number[][];
  /** Singular values, length `k`. */
  singularValues: number[];
  /** L2-normalised latent vector per chunk, `n × k`. */
  chunkVectors: number[][];
}

/** Build the latent space from the sparse TF-IDF rows. */
export function buildLatentSpace(rows: readonly SparseRow[], dimensions: number): LatentSpace {
  const { vectors, values } = topEigen(gramMatrix(rows), dimensions);
  const k = vectors.length;
  const n = rows.length;
  const singularValues = values.map((value) => Math.sqrt(Math.max(value, 0)));

  const singularVectors: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: k }, (_unused, j) => (vectors[j] as number[])[i] as number),
  );

  const chunkVectors = singularVectors.map((row) =>
    normalizeDense(row.map((value, j) => value * (singularValues[j] as number))),
  );

  return { singularVectors, singularValues, chunkVectors };
}

/**
 * Project a query into the latent space.
 *
 * `q̂ = qᵀV = (Xq)ᵀ U S⁻¹`, which is the same projection applied to a query that
 * `XV = US` applies to every document, so the cosine below compares like with
 * like. It needs only `X` (the sparse rows the lexical index already holds),
 * `U` and `S`.
 */
export function projectQuery(
  query: SparseRow,
  rows: readonly SparseRow[],
  singularVectors: readonly number[][],
  singularValues: readonly number[],
): number[] {
  const k = singularValues.length;
  if (k === 0) return [];
  const similarities = rows.map((row) => sparseDot(row, query));
  const projected = new Array<number>(k).fill(0);
  for (let i = 0; i < rows.length; i += 1) {
    const weight = similarities[i] as number;
    if (weight === 0) continue;
    const vector = singularVectors[i] as readonly number[];
    for (let j = 0; j < k; j += 1)
      projected[j] = (projected[j] as number) + weight * (vector[j] as number);
  }
  for (let j = 0; j < k; j += 1) {
    const singular = singularValues[j] as number;
    projected[j] = singular > 1e-9 ? (projected[j] as number) / singular : 0;
  }
  return normalizeDense(projected);
}

/** Cosine similarity of two L2-normalised dense vectors. */
export function cosine(left: readonly number[], right: readonly number[]): number {
  let sum = 0;
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) sum += (left[i] as number) * (right[i] as number);
  return sum;
}
