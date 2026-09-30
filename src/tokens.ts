/** Model-independent history clipping budget, not the host's context usage meter. */
export const TOKEN_WEIGHTS = Object.freeze({ cjk: 1.5, latinOrSpace: 0.25, symbol: 1, image: 1365 });
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
export function graphemes(text: string): string[] { return Array.from(segmenter.segment(text), (part) => part.segment); }
export function weight(text: string): number {
  let total = 0;
  for (const char of text) {
    total += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)
      ? TOKEN_WEIGHTS.cjk : /[A-Za-z0-9\s]/u.test(char) ? TOKEN_WEIGHTS.latinOrSpace : TOKEN_WEIGHTS.symbol;
  }
  return total;
}
export function estimateText(text: string): number { return Math.ceil(weight(text)); }
export function formatCount(value: number): string {
  const count = Math.max(0, Math.ceil(value));
  return count > 2000 ? `${Number((count / 1000).toFixed(1))}K` : String(count);
}
export function excerpt(text: string, edge: number): string {
  if (weight(text) <= edge * 2) return text;
  const parts = graphemes(text);
  let left = 0, right = parts.length, used = 0;
  while (left < right && used + weight(parts[left]!) <= edge) used += weight(parts[left++]!);
  used = 0;
  while (right > left && used + weight(parts[right - 1]!) <= edge) used += weight(parts[--right]!);
  if (left === right) return text;
  return parts.slice(0, left).join("") + `[${formatCount(estimateText(parts.slice(left, right).join("")))} tokens omitted]` + parts.slice(right).join("");
}
