import assert from "node:assert/strict";
import test from "node:test";

import {
  SafeWebFetchError,
  fetchPublicTextPage,
} from "../src/chat/safeWebFetch.js";

const PUBLIC_LOOKUP = async () => [
  { address: "93.184.216.34", family: 4 },
];

function response({
  status = 200,
  contentType = "text/html; charset=utf-8",
  location = null,
  text = "",
} = {}) {
  const bytes = new TextEncoder().encode(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return contentType;
        if (name.toLowerCase() === "location") return location;
        return null;
      },
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

test("rejects loopback and private webpage destinations before fetching", async () => {
  let fetchCalls = 0;
  const fetchFn = async () => {
    fetchCalls += 1;
    return response();
  };

  for (const url of [
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/admin",
  ]) {
    await assert.rejects(
      fetchPublicTextPage(url, { fetchFn, lookupFn: PUBLIC_LOOKUP }),
      (error) =>
        error instanceof SafeWebFetchError && error.code === "UNSAFE_URL"
    );
  }
  assert.equal(fetchCalls, 0);
});

test("revalidates redirects and refuses a redirect to a private address", async () => {
  let fetchCalls = 0;
  const fetchFn = async () => {
    fetchCalls += 1;
    return response({
      status: 302,
      location: "http://127.0.0.1/private",
    });
  };

  await assert.rejects(
    fetchPublicTextPage("https://example.com/start", {
      fetchFn,
      lookupFn: PUBLIC_LOOKUP,
    }),
    (error) =>
      error instanceof SafeWebFetchError && error.code === "UNSAFE_URL"
  );
  assert.equal(fetchCalls, 1);
});

test("streams only the configured maximum response bytes", async () => {
  let pinnedAddress = null;
  const result = await fetchPublicTextPage("https://example.com/page", {
    fetchFn: async (_url, options) => {
      options.agent.options.lookup(
        "example.com",
        {},
        (_error, address) => {
          pinnedAddress = address;
        }
      );
      return response({ text: "0123456789abcdefghij" });
    },
    lookupFn: PUBLIC_LOOKUP,
    maxBytes: 10,
  });

  assert.equal(pinnedAddress, "93.184.216.34");
  assert.equal(result.text, "0123456789");
  assert.equal(result.truncated, true);
  assert.equal(result.url, "https://example.com/page");
});
