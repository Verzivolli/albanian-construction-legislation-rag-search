/** Lower-case, strip diacritics (ë->e, ç->c) and reduce to [a-z0-9 ] -- the same folding the SQL keyword search uses. */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
