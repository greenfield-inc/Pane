/** Single ASCII characters can be held by the picker; other input stays raw. */
export function isPrintable(data: string): boolean {
  return data.length === 1 && data >= ' ' && data <= '~';
}
