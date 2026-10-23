import type { z } from 'zod';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const notFound = (msg: string) => new HttpError(404, msg);

/** Parse with a zod schema, turning the first issue into a readable 400. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw badRequest(where + (issue?.message ?? 'input tidak valid'));
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
