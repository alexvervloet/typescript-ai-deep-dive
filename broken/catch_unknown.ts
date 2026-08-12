/**
 * Does not compile, on purpose. Example 09 prints the error.
 *
 * In Python, `except Exception as e` gives you an `e` you can use: it has
 * `.args`, it has a `str()`, and if you caught a specific class you know its
 * attributes.
 *
 * TypeScript cannot make that promise, because JavaScript lets you throw
 * anything at all. `throw "nope"` is legal. `throw { code: 42 }` is legal. So
 * under `strict`, the caught value is typed `unknown`, and reading a field off
 * it is an error until you have proven what it is.
 *
 * Annoying for about a week, then it stops you shipping a log line that reads
 * `undefined` for the one failure mode you did not anticipate.
 */

export function describeFailure(): string {
  try {
    throw new Error("provider exploded");
  } catch (error) {
    // `error` is `unknown` here.
    return error.message;
  }
}
