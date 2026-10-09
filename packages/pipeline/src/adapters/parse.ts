import type { ZodType } from 'zod';

/**
 * Parse an ATS payload at the boundary. On failure the error names the label (ATS and
 * board) and up to five issue paths and messages, never the payload itself: GitHub
 * Actions logs are public.
 */
export function parseOrThrow<T>(schema: ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  throw new Error(`${label}: unexpected payload shape: ${issues}`);
}
