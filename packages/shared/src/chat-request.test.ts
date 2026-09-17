import { describe, expect, it } from "vitest";
import { chatRequestSchema } from "./api.js";

describe("role-specific chat request bounds", () => {
  it.each([
    ["user", 8000, true],
    ["user", 8001, false],
    ["assistant", 32000, true],
    ["assistant", 32001, false],
  ])("validates %s content at %i characters", (role, length, valid) => {
    expect(
      chatRequestSchema.safeParse({ messages: [{ role, content: "x".repeat(length) }] }).success,
    ).toBe(valid);
  });

  it("preserves long assistant history verbatim without increasing user limits", () => {
    const messages = [
      { role: "user", content: "Show the source-backed properties." },
      { role: "assistant", content: "Canonical row evidence. ".repeat(1000) },
      { role: "user", content: "Now ask the next question." },
    ];
    expect(chatRequestSchema.parse({ messages }).messages).toEqual(messages);
  });

  it("retains the previous exact aggregate ceiling for thirty maximum-size user messages", () => {
    const messages = Array.from({ length: 30 }, () => ({
      role: "user",
      content: "x".repeat(8000),
    }));
    expect(chatRequestSchema.safeParse({ messages }).success).toBe(true);
    expect(
      chatRequestSchema.safeParse({ messages: [...messages, { role: "user", content: "x" }] })
        .success,
    ).toBe(false);
  });

  it("accepts exactly 240000 mixed-role characters and rejects one extra without truncating", () => {
    const messages = [
      ...Array.from({ length: 7 }, () => ({ role: "assistant", content: "a".repeat(32000) })),
      ...Array.from({ length: 2 }, () => ({ role: "user", content: "u".repeat(8000) })),
    ];
    expect(chatRequestSchema.parse({ messages }).messages).toEqual(messages);
    const result = chatRequestSchema.safeParse({
      messages: [...messages, { role: "user", content: "x" }],
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ["messages"], message: expect.stringContaining("240000") }),
      );
  });

  it.each(["user", "assistant"])("rejects empty %s messages", (role) => {
    expect(chatRequestSchema.safeParse({ messages: [{ role, content: "" }] }).success).toBe(false);
  });

  it.each(["system", "tool", "developer"])("does not accept an untrusted %s role", (role) => {
    expect(chatRequestSchema.safeParse({ messages: [{ role, content: "hello" }] }).success).toBe(
      false,
    );
  });

  it("rejects zero or more than thirty messages and non-string content", () => {
    expect(chatRequestSchema.safeParse({ messages: [] }).success).toBe(false);
    expect(
      chatRequestSchema.safeParse({
        messages: Array.from({ length: 31 }, () => ({ role: "assistant", content: "x" })),
      }).success,
    ).toBe(false);
    expect(
      chatRequestSchema.safeParse({ messages: [{ role: "user", content: 123 }] }).success,
    ).toBe(false);
  });
});
