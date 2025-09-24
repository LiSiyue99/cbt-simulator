export async function withRetry<T>(fn: () => Promise<T>, validate: (v: T) => boolean, max = 3): Promise<T> {
  let last: T | undefined;
  let error: any;
  for (let i = 0; i < max; i++) {
    try {
      const v = await fn();
      last = v;
      if (validate(v)) return v;
    } catch (e) {
      error = e;
    }
    await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  if (last !== undefined) return last;
  throw error ?? new Error('withRetry: exhausted');
}


