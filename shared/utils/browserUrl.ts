/** Match the browser's URL parser, including scheme casing and whitespace. */
export function hasFileProtocol(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === 'file:';
  } catch {
    return false;
  }
}
