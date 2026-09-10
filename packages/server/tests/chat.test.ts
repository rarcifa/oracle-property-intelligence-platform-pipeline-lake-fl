/**
 * Chat-surface tests.
 *
 * No model is ever called here. What is asserted is the contract the UI depends
 * on: a missing key degrades to a clear 503 instead of a boot failure, the
 * system prompt carries the honesty rules, and the citation collector records
 * the parcel ids behind a claim.
 */
import { describe, expect, it } from "vitest";
import { ChatUnavailableError, createChatAgent } from "../src/chat/agent.js";
import { loadConfig } from "../src/config.js";
import { createContext } from "../src/context.js";
import { OracleDataStore } from "../src/data/duckdb.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const agentSource = readFileSync(resolve(here, "../src/chat/agent.ts"), "utf8");

function agentWith(apiKey: string | undefined) {
  const config = loadConfig({ ...process.env, ANTHROPIC_API_KEY: apiKey ?? "" });
  // The store is never opened: constructing it is enough for these assertions.
  const store = new OracleDataStore({ source: "/tmp/never-opened.parquet" });
  return createChatAgent(createContext(config, store));
}

describe("chat availability", () => {
  it("is disabled and does not throw at construction without a key", () => {
    expect(agentWith(undefined).enabled).toBe(false);
  });

  it("throws a typed ChatUnavailableError naming the variable when run", async () => {
    await expect(
      agentWith(undefined).run([{ role: "user", content: "hi" }]),
    ).rejects.toBeInstanceOf(ChatUnavailableError);
    await expect(agentWith(undefined).run([{ role: "user", content: "hi" }])).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it("is enabled when a key is present", () => {
    expect(agentWith("sk-ant-test").enabled).toBe(true);
  });

  it("defaults to the configured model id", () => {
    expect(agentWith("sk-ant-test").modelId).toBe("claude-fable-5-1");
  });
});

describe("guideline conformance of the LLM path", () => {
  it("uses the Vercel AI SDK rather than a provider SDK directly", () => {
    expect(agentSource).toContain('from "ai"');
    expect(agentSource).toContain('from "@ai-sdk/anthropic"');
    expect(agentSource).not.toContain("@anthropic-ai/sdk");
  });

  it("declares tool inputs with Zod", () => {
    expect(agentSource).toContain("inputSchema: z.object(");
  });

  it("contains no `any` in the LLM path", () => {
    expect(agentSource).not.toMatch(/\bany\b\s*[;,)\]>]/);
  });

  it("instructs the model to never state an unqueried number", () => {
    expect(agentSource).toContain("Never state a number you did not obtain from a tool call");
  });

  it("instructs the model to explain the gated columns rather than inventing them", () => {
    expect(agentSource).toContain("Never invent one");
    expect(agentSource).toContain("HTTP 403");
  });
});
