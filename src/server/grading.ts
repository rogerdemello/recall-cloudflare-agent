/**
 * Turning a model's prose into an SM-2 grade.
 *
 * This deliberately avoids JSON mode and `generateObject`. Structured-output
 * modes on mid-sized open models fail in ways that are annoying to recover from
 * (truncated objects, schema drift, stray prose around the JSON), and a failure
 * here corrupts the learner's scheduling data rather than just looking untidy.
 *
 * A line-oriented format instead: trivial for a 70B model to follow, trivial to
 * parse, and degrades to something sensible when the model ignores it anyway.
 */

import type { Grade } from "./sm2";

export interface GradeResult {
  grade: Grade;
  feedback: string;
}

/** Appended to the grading prompt. Kept next to the parser so the two can't drift. */
export const GRADE_FORMAT_INSTRUCTION = `Reply in exactly this format, with nothing before or after:
GRADE: <a single integer from 0 to 5>
FEEDBACK: <one or two sentences addressed to the learner as "you">

Grading scale:
5 - correct, confident, complete
4 - correct with a small omission or hesitation
3 - essentially correct but vague or partial
2 - partially correct, a real gap or error
1 - mostly wrong but some recognition
0 - no recall, or a blank or evasive answer`;

/**
 * Extract a grade and feedback from the model's reply.
 *
 * Never throws. When the format is not followed, falls back to grade 3 — the
 * lowest passing grade — because a parse failure is *our* bug, and it would be
 * unfair to record it as a lapse on the learner's card. Grade 3 nudges ease
 * down slightly without resetting their progress.
 */
export function parseGradeResponse(raw: string): GradeResult {
  const text = raw.replace(/\*\*/g, "").trim();

  const gradeMatch = text.match(/GRADE\s*[:\-]?\s*([0-5])/i);
  const feedbackMatch = text.match(/FEEDBACK\s*[:\-]?\s*([\s\S]+)/i);

  const feedback = (feedbackMatch?.[1] ?? "").trim();

  if (gradeMatch?.[1]) {
    return {
      grade: clampGrade(Number(gradeMatch[1])),
      feedback: feedback || fallbackFeedback(clampGrade(Number(gradeMatch[1]))),
    };
  }

  // No labelled grade. Try a bare leading digit ("4 — good recall").
  const bare = text.match(/^\s*([0-5])\b/);
  if (bare?.[1]) {
    const grade = clampGrade(Number(bare[1]));
    return {
      grade,
      feedback: feedback || text.replace(/^\s*[0-5]\b[\s\-—:]*/, "").trim() ||
        fallbackFeedback(grade),
    };
  }

  return {
    grade: 3,
    feedback: feedback || text || fallbackFeedback(3),
  };
}

function clampGrade(n: number): Grade {
  const rounded = Math.round(n);
  const bounded = Math.min(5, Math.max(0, rounded));
  return bounded as Grade;
}

function fallbackFeedback(grade: Grade): string {
  if (grade >= 4) return "Good recall.";
  if (grade === 3) return "Roughly right — worth another look.";
  return "Not quite. Review this one.";
}
