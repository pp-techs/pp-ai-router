import { describe, expect, it } from "vite-plus/test";
import { candidateVariants, idVariants } from "../src/pricing/aliases.ts";

describe("idVariants", () => {
  it("derives the LiteLLM and OpenRouter spellings of a Claude id", () => {
    const variants = idVariants("kiro/claude-sonnet-5.5");
    expect(variants).toContain("claude-sonnet-5-5");
    expect(variants).toContain("anthropic/claude-sonnet-5.5");
    expect(variants).toContain("anthropic/claude-sonnet-5-5");
  });

  it("drops a zero minor version", () => {
    expect(idVariants("claude-sonnet-4.0")).toContain("claude-sonnet-4");
    expect(idVariants("claude-sonnet-4.0")).toContain("anthropic/claude-sonnet-4");
  });

  it("turns dashed versions back into dots, but leaves dates alone", () => {
    expect(idVariants("claude-opus-4-5")).toContain("anthropic/claude-opus-4.5");
    const dated = idVariants("claude-3-5-sonnet-20241022");
    expect(dated).toContain("claude-3.5-sonnet-20241022");
    expect(dated.some((v) => v.includes("2024.10") || v.includes("2024-1.0"))).toBe(false);
  });

  it("adds the `v` DeepSeek puts before its version", () => {
    expect(idVariants("deepseek-3.2")).toContain("deepseek/deepseek-v3.2");
  });

  it("uses the vendor that matches the model family, and none for unknown families", () => {
    expect(idVariants("gpt-5.6-sol")).toContain("openai/gpt-5.6-sol");
    expect(idVariants("gemini-3.1-pro")).toContain("google/gemini-3.1-pro");
    expect(idVariants("kiro-auto").some((v) => v.includes("/"))).toBe(false);
  });

  it("never returns the id itself", () => {
    expect(idVariants("claude-opus-5")).not.toContain("claude-opus-5");
  });
});

describe("candidateVariants", () => {
  it("skips ids that are already candidates and repeats nothing", () => {
    const out = candidateVariants(["kiro/claude-sonnet-5.5", "claude-sonnet-5.5"]);
    expect(out).not.toContain("claude-sonnet-5.5");
    expect(new Set(out).size).toBe(out.length);
  });
});
