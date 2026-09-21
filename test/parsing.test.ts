import { describe, expect, it } from "vitest";
import { parseCards, parseSubtopics } from "../src/server/parsing";

describe("parseSubtopics", () => {
  it("reads a numbered list", () => {
    const result = parseSubtopics(
      "1. Durable Objects\n2. Workers KV\n3. Workflows",
    );
    expect(result).toEqual(["Durable Objects", "Workers KV", "Workflows"]);
  });

  it("reads a bulleted list", () => {
    expect(parseSubtopics("- Alpha\n* Beta\n• Gamma")).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
  });

  it("drops the preamble line models like to add", () => {
    const result = parseSubtopics(
      "Here are the subtopics:\n1. State management\n2. Hibernation",
    );
    expect(result).toEqual(["State management", "Hibernation"]);
  });

  it("strips markdown bolding and headers", () => {
    expect(parseSubtopics("## **Caching**\n- **Eviction**")).toEqual([
      "Caching",
      "Eviction",
    ]);
  });

  it("deduplicates case-insensitively", () => {
    expect(parseSubtopics("- Routing\n- routing\n- ROUTING")).toEqual(["Routing"]);
  });

  it("rejects paragraphs masquerading as topics", () => {
    const paragraph = "x".repeat(200);
    expect(parseSubtopics(`- Real topic\n- ${paragraph}`)).toEqual(["Real topic"]);
  });

  it("honours the maximum", () => {
    const many = Array.from({ length: 20 }, (_, i) => `- Topic ${i}`).join("\n");
    expect(parseSubtopics(many, 5)).toHaveLength(5);
  });

  it("returns an empty array rather than throwing on junk", () => {
    expect(parseSubtopics("")).toEqual([]);
    expect(parseSubtopics("\n\n   \n")).toEqual([]);
  });
});

describe("parseCards", () => {
  it("reads alternating Q/A pairs", () => {
    const result = parseCards(
      "Q: What is a Durable Object?\nA: A stateful single-instance Worker.\nQ: What is hibernation?\nA: Evicting an idle instance from memory while keeping its state.",
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      question: "What is a Durable Object?",
      answer: "A stateful single-instance Worker.",
    });
    expect(result[1]?.question).toBe("What is hibernation?");
  });

  it("accepts the long labels a model sometimes uses", () => {
    const result = parseCards("Question: What is SM-2?\nAnswer: A scheduling algorithm.");
    expect(result[0]).toEqual({
      question: "What is SM-2?",
      answer: "A scheduling algorithm.",
    });
  });

  it("joins a multi-line answer", () => {
    const result = parseCards(
      "Q: Why namespace vectors?\nA: One index is shared across learners.\nNamespacing keeps recall scoped to one person.",
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.answer).toBe(
      "One index is shared across learners. Namespacing keeps recall scoped to one person.",
    );
  });

  it("discards a question with no answer rather than saving a blank card", () => {
    const result = parseCards("Q: Dangling question?\nQ: Real one?\nA: Real answer.");
    expect(result).toHaveLength(1);
    expect(result[0]?.question).toBe("Real one?");
  });

  it("discards a trailing question at end of output", () => {
    const result = parseCards("Q: Good?\nA: Yes.\nQ: Truncated mid-generation");
    expect(result).toHaveLength(1);
  });

  it("strips numbering and bolding around the labels", () => {
    const result = parseCards("1. **Q:** What is ease?\n**A:** The interval growth factor.");
    expect(result[0]).toEqual({
      question: "What is ease?",
      answer: "The interval growth factor.",
    });
  });

  it("honours the maximum", () => {
    const many = Array.from({ length: 30 }, (_, i) => `Q: Q${i}?\nA: A${i}.`).join("\n");
    expect(parseCards(many, 10)).toHaveLength(10);
  });

  it("returns an empty array on prose with no pairs", () => {
    expect(parseCards("I'd be happy to help you study this topic!")).toEqual([]);
  });

  it("never returns a card with an empty side", () => {
    const messy = "Q:\nA:\nQ: Valid?\nA: Yes.\nA: orphan answer";
    for (const card of parseCards(messy)) {
      expect(card.question.length).toBeGreaterThan(0);
      expect(card.answer.length).toBeGreaterThan(0);
    }
  });
});
