export type Matrix = number[][];

export function zeros(rows: number, columns: number): Matrix {
  return Array.from({ length: rows }, () => Array(columns).fill(0));
}

export function identity(size: number): Matrix {
  const result = zeros(size, size);
  for (let i = 0; i < size; i += 1) result[i][i] = 1;
  return result;
}

export function transpose(matrix: Matrix): Matrix {
  return matrix[0].map((_, column) => matrix.map((row) => row[column]));
}

export function add(a: Matrix, b: Matrix): Matrix {
  return a.map((row, i) => row.map((value, j) => value + b[i][j]));
}

export function subtract(a: Matrix, b: Matrix): Matrix {
  return a.map((row, i) => row.map((value, j) => value - b[i][j]));
}

export function multiply(a: Matrix, b: Matrix): Matrix {
  const result = zeros(a.length, b[0].length);
  for (let i = 0; i < a.length; i += 1) {
    for (let k = 0; k < b.length; k += 1) {
      for (let j = 0; j < b[0].length; j += 1) {
        result[i][j] += a[i][k] * b[k][j];
      }
    }
  }
  return result;
}

export function inverse(matrix: Matrix): Matrix | null {
  const size = matrix.length;
  const unit = identity(size);
  const augmented = matrix.map((row, i) => [...row, ...unit[i]]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    augmented[column] = augmented[column].map((value) => value / divisor);
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      augmented[row] = augmented[row].map(
        (value, index) => value - factor * augmented[column][index],
      );
    }
  }
  return augmented.map((row) => row.slice(size));
}

export function symmetrize(matrix: Matrix): Matrix {
  return matrix.map((row, i) =>
    row.map((value, j) => (value + matrix[j][i]) * 0.5),
  );
}

export function column(values: readonly number[]): Matrix {
  return values.map((value) => [value]);
}

export function diagonal(values: readonly number[]): Matrix {
  const result = zeros(values.length, values.length);
  values.forEach((value, index) => {
    result[index][index] = value;
  });
  return result;
}

export function quadraticForm(vector: readonly number[], matrix: Matrix): number {
  return multiply(multiply([Array.from(vector)], matrix), column(vector))[0][0];
}

export function isPositiveSemidefinite(
  matrix: Matrix,
  tolerance = 1e-9,
): boolean {
  if (matrix.length === 0 || matrix.some((row) => row.length !== matrix.length)) {
    return false;
  }
  const lower = zeros(matrix.length, matrix.length);
  for (let i = 0; i < matrix.length; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let residual = (matrix[i][j] + matrix[j][i]) * 0.5;
      for (let k = 0; k < j; k += 1) {
        residual -= lower[i][k] * lower[j][k];
      }
      if (i === j) {
        if (residual < -tolerance) return false;
        lower[i][j] = Math.sqrt(Math.max(0, residual));
      } else if (lower[j][j] > tolerance) {
        lower[i][j] = residual / lower[j][j];
      } else if (Math.abs(residual) > tolerance) {
        return false;
      }
    }
  }
  return true;
}
