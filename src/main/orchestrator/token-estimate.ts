/** Shared local estimator; deliberately has no model, storage or network dependencies. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let nonAscii = 0, ascii = 0;
  for (const char of text) {
    if (char.charCodeAt(0) > 127) nonAscii++;
    else ascii++;
  }
  return Math.ceil(nonAscii / 1.5 + ascii / 4);
}
