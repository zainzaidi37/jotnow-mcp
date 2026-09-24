// Mirrors the Edge save_note id guard. Keep this package self-contained for npm.
const UUID_SHAPE_ANY_CASE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidShapeAnyCase(value: unknown): value is string {
  return typeof value === 'string' && UUID_SHAPE_ANY_CASE.test(value);
}
