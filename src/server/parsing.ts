/**
 * Line-oriented parsers for the deck-building workflow.
 *
 * Same reasoning as `grading.ts`: asking a 70B model for well-formed JSON is a
 * coin flip once the output gets long, and a truncated object loses the whole
 * batch. Line formats degrade gracefully — a malformed line costs one card, not
 * twenty — and a workflow step that returns fewer cards is still progress.
 */

export interface ParsedCard {
  question: string;
  answer: string;
}

/**
 * Pull the `DECK:` label out of a card-extraction response.
 *
 * Returns `fallback` when the line is missing or unusable, so a deck always has
 * a name even when the model skips the header.
 */
export function parseDeckName(raw: string, fallback = "general"): string {
  for (const line of raw.split("\n")) {
    const match = clean(line).match(/^DECK\s*[:.\-]\s*(.+)$/i);
    if (!match?.[1]) continue;

    const name = match[1].trim().toLowerCase().replace(/[."']+$/, "");
    // Guard against the model putting a whole sentence here.
    if (name.length >= 2 && name.length <= 48) return name;
  }
  return fallback;
}

/**
 * Whether the extractor decided the exchange held nothing worth remembering.
 *
 * Checked before parsing cards so a bare "NONE" isn't mistaken for malformed
 * output and retried.
 */
export function isNothingToSave(raw: string): boolean {
  const text = raw.trim().toUpperCase();
  return text === "NONE" || text.startsWith("NONE\n") || text === "NONE.";
}

/**
 * Strip list bullets, numbering and stray markdown from a line.
 *
 * Order matters: bold markers come off *first*. A line like `**A:** ...` starts
 * with an asterisk, so a bullet strip running earlier would eat one of the two
 * markers and leave `*A:` behind — which then fails to match the answer label
 * and silently drops the card.
 */
function clean(line: string): string {
  return line
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/, "")
    .replace(/^\s*[-*•]\s*/, "")
    .replace(/^\s*\d+[.)]\s*/, "")
    .trim();
}

/**
 * Pull a list of subtopics out of the model's outline.
 *
 * Accepts numbered lists, bulleted lists or bare lines, and drops anything that
 * looks like preamble ("Here are the subtopics:") or is implausibly long to be
 * a topic name.
 */
export function parseSubtopics(raw: string, max = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const line of raw.split("\n")) {
    const text = clean(line);
    if (!text) continue;
    // Preamble and headers end in a colon and carry no topic of their own.
    if (text.endsWith(":")) continue;
    // A real subtopic is a phrase, not a paragraph.
    if (text.length < 3 || text.length > 80) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);

    if (out.length >= max) break;
  }

  return out;
}

/**
 * Pull question/answer pairs out of the model's card output.
 *
 * Expects alternating `Q:` / `A:` lines. An answer may span several lines; it
 * ends at the next `Q:`. A question with no answer is discarded rather than
 * saved half-formed, since a card with a blank back is worse than no card.
 */
export function parseCards(raw: string, max = 12): ParsedCard[] {
  const cards: ParsedCard[] = [];

  let question: string | null = null;
  let answerLines: string[] = [];

  const flush = () => {
    const answer = answerLines.join(" ").trim();
    if (question && answer) {
      cards.push({ question, answer });
    }
    question = null;
    answerLines = [];
  };

  for (const rawLine of raw.split("\n")) {
    const line = clean(rawLine);
    if (!line) continue;

    const questionMatch = line.match(/^Q(?:uestion)?\s*[:.\-]\s*(.+)$/i);
    if (questionMatch?.[1]) {
      flush();
      question = questionMatch[1].trim();
      continue;
    }

    const answerMatch = line.match(/^A(?:nswer)?\s*[:.\-]\s*(.+)$/i);
    if (answerMatch?.[1]) {
      answerLines = [answerMatch[1].trim()];
      continue;
    }

    // Continuation of a multi-line answer.
    if (question && answerLines.length > 0) {
      answerLines.push(line);
    }
  }
  flush();

  return cards.slice(0, max);
}
