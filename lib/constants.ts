// Mirrors python-etl/constants.py's INT_TO_UNIT_LABEL. Keep both files in
// sync -- if this mapping ever changes, update BOTH, there's no single
// source of truth (deliberate choice, see plan.md's maintenance flag).
export const INT_TO_UNIT_LABEL: Record<number, string> = {
  1: "Neni",
  2: "Pika",
  3: "Shtojca",
};

// Shared citation-string builder, e.g. "Neni 2, Vendim 610/2022" -- same
// format retrieve.ts already builds inline for chat citations. Extracted
// here for the new laws/articles/search routes (2026-07-31) rather than
// duplicated a third time; retrieve.ts's own tested inline version is left
// untouched rather than refactored, to avoid risking already-verified code.
export function buildCitation(
  unitType: number,
  unitNumber: string,
  lawType: string,
  lawNumber: string
): string {
  const lawTypeCapitalized = lawType[0].toUpperCase() + lawType.slice(1);
  return `${INT_TO_UNIT_LABEL[unitType]} ${unitNumber}, ${lawTypeCapitalized} ${lawNumber}`;
}
