import assert from "node:assert/strict";
import test from "node:test";

import { ApiAgent } from "../src/agents/api-agent.js";

function makeGeminiResponse(text) {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
  };
}

test("_callGemini sends API key as X-Goog-Api-Key header", async (t) => {
  let capturedInit;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, init) => {
    capturedInit = init;
    return {
      ok: true,
      json: async () => makeGeminiResponse("ok"),
    };
  };

  const agent = new ApiAgent({
    provider: "gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "test-key-abc",
    model: "gemini-pro",
  });
  agent._abortController = new AbortController();

  await agent._callGemini("hello");

  assert.equal(capturedInit.headers["X-Goog-Api-Key"], "test-key-abc");
});

test("_callGemini URL does not contain the API key as a query parameter", async (t) => {
  let capturedUrl;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return {
      ok: true,
      json: async () => makeGeminiResponse("ok"),
    };
  };

  const agent = new ApiAgent({
    provider: "gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "test-key-abc",
    model: "gemini-pro",
  });
  agent._abortController = new AbortController();

  await agent._callGemini("hello");

  assert.equal(capturedUrl.includes("?key="), false);
  assert.equal(capturedUrl.includes("test-key-abc"), false);
});
