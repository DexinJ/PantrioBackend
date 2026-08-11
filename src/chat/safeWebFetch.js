import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import nodeFetch from "node-fetch";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const ALLOWED_CONTENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
]);

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

export class SafeWebFetchError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = "SafeWebFetchError";
    this.code = code;
  }
}

function normalizedHostname(url) {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function hostnameIsLocal(hostname) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  );
}

function addressIsBlocked(address, family) {
  const mappedIpv4 = String(address).match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedIpv4) {
    return blockedAddresses.check(mappedIpv4[1], "ipv4");
  }
  const normalizedFamily =
    family === 4 || family === "IPv4" || family === "ipv4"
      ? "ipv4"
      : "ipv6";
  return blockedAddresses.check(address, normalizedFamily);
}

async function validatePublicUrl(value, lookupFn) {
  let url;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch (error) {
    throw new SafeWebFetchError("INVALID_URL", "The webpage URL is invalid.", {
      cause: error,
    });
  }

  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new SafeWebFetchError(
      "INVALID_URL",
      "Only HTTP and HTTPS webpage URLs are allowed."
    );
  }
  if (url.username || url.password) {
    throw new SafeWebFetchError(
      "INVALID_URL",
      "Webpage URLs cannot contain credentials."
    );
  }
  if (
    url.port &&
    !(
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    )
  ) {
    throw new SafeWebFetchError(
      "UNSAFE_URL",
      "The webpage URL uses a disallowed port."
    );
  }

  const hostname = normalizedHostname(url);
  if (!hostname || hostnameIsLocal(hostname)) {
    throw new SafeWebFetchError(
      "UNSAFE_URL",
      "Local and private webpage addresses are not allowed."
    );
  }

  let addresses;
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await lookupFn(hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new SafeWebFetchError(
        "DNS_LOOKUP_FAILED",
        "The webpage address could not be resolved.",
        { cause: error }
      );
    }
  }

  if (
    !Array.isArray(addresses) ||
    addresses.length === 0 ||
    addresses.some(({ address, family }) =>
      addressIsBlocked(address, family)
    )
  ) {
    throw new SafeWebFetchError(
      "UNSAFE_URL",
      "Local and private webpage addresses are not allowed."
    );
  }

  return { url, addresses };
}

function createPinnedAgent(url, addresses) {
  const Agent = url.protocol === "https:" ? https.Agent : http.Agent;
  const pinnedAddresses = addresses.map(({ address, family }) => ({
    address,
    family:
      family === 4 || family === "IPv4" || family === "ipv4" ? 4 : 6,
  }));
  let nextAddress = 0;
  return new Agent({
    keepAlive: false,
    lookup(_hostname, options, callback) {
      if (options?.all) {
        callback(null, pinnedAddresses);
        return;
      }
      const selected = pinnedAddresses[nextAddress % pinnedAddresses.length];
      nextAddress += 1;
      callback(null, selected.address, selected.family);
    },
  });
}

async function discardResponseBody(response) {
  if (typeof response?.body?.cancel === "function") {
    await response.body.cancel().catch(() => {});
  } else {
    response?.body?.destroy?.();
  }
}

function createLinkedController(signal, timeoutMs) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    forwardAbort();
  } else {
    signal?.addEventListener("abort", forwardAbort, { once: true });
  }
  const timeout = setTimeout(
    () => controller.abort(new Error("Webpage fetch timed out.")),
    timeoutMs
  );
  timeout.unref?.();

  return {
    controller,
    cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
    },
  };
}

async function readBodyWithLimit(body, maxBytes) {
  if (
    !body ||
    (typeof body.getReader !== "function" &&
      typeof body[Symbol.asyncIterator] !== "function")
  ) {
    throw new SafeWebFetchError(
      "INVALID_RESPONSE",
      "The webpage returned an unreadable response."
    );
  }

  const decoder = new TextDecoder("utf-8");
  let totalBytes = 0;
  let text = "";
  let truncated = false;

  const acceptChunk = (value) => {
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    const remaining = maxBytes - totalBytes;
    if (remaining <= 0) {
      truncated = true;
      return false;
    }
    const accepted = chunk.byteLength > remaining
      ? chunk.subarray(0, remaining)
      : chunk;
    totalBytes += accepted.byteLength;
    text += decoder.decode(accepted, { stream: true });
    if (accepted.byteLength < chunk.byteLength) {
      truncated = true;
      return false;
    }
    return true;
  };

  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done || !acceptChunk(value)) break;
      }
    } finally {
      if (truncated) await reader.cancel().catch(() => {});
      reader.releaseLock?.();
    }
  } else {
    for await (const chunk of body) {
      if (!acceptChunk(chunk)) break;
    }
    if (truncated) body.destroy?.();
  }

  text += decoder.decode();
  return { text, truncated };
}

export async function fetchPublicTextPage(
  input,
  {
    fetchFn = nodeFetch,
    lookupFn = lookup,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
  } = {}
) {
  const normalizedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(Math.trunc(timeoutMs), 30_000)
    : DEFAULT_TIMEOUT_MS;
  const normalizedMaxBytes = Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? Math.min(maxBytes, 1024 * 1024)
    : DEFAULT_MAX_BYTES;
  const normalizedMaxRedirects =
    Number.isSafeInteger(maxRedirects) && maxRedirects >= 0
      ? Math.min(maxRedirects, 5)
      : DEFAULT_MAX_REDIRECTS;
  const linked = createLinkedController(signal, normalizedTimeoutMs);

  try {
    let target = await validatePublicUrl(input, lookupFn);
    for (let redirectCount = 0; ; redirectCount += 1) {
      const agent = createPinnedAgent(target.url, target.addresses);
      let response;
      try {
        response = await fetchFn(target.url, {
          method: "GET",
          redirect: "manual",
          signal: linked.controller.signal,
          agent,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; PantrioBot/1.0; +https://example.invalid)",
            Accept: "text/html,application/xhtml+xml,text/plain",
          },
        });
      } catch (error) {
        agent.destroy();
        throw error;
      }

      if (response.status >= 300 && response.status < 400) {
        if (redirectCount >= normalizedMaxRedirects) {
          await discardResponseBody(response);
          agent.destroy();
          throw new SafeWebFetchError(
            "TOO_MANY_REDIRECTS",
            "The webpage redirected too many times."
          );
        }
        const location = response.headers?.get?.("location");
        await discardResponseBody(response);
        agent.destroy();
        if (!location) {
          throw new SafeWebFetchError(
            "INVALID_REDIRECT",
            "The webpage returned an invalid redirect."
          );
        }
        target = await validatePublicUrl(
          new URL(location, target.url),
          lookupFn
        );
        continue;
      }

      if (!response.ok) {
        await discardResponseBody(response);
        agent.destroy();
        throw new SafeWebFetchError(
          "UPSTREAM_HTTP_ERROR",
          `The webpage returned HTTP ${response.status}.`
        );
      }

      const contentType = String(
        response.headers?.get?.("content-type") || ""
      )
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        await discardResponseBody(response);
        agent.destroy();
        throw new SafeWebFetchError(
          "UNSUPPORTED_CONTENT_TYPE",
          "The URL did not return a supported text webpage."
        );
      }

      const contentLength = Number(
        response.headers?.get?.("content-length") || NaN
      );
      if (Number.isFinite(contentLength) && contentLength > normalizedMaxBytes) {
        await discardResponseBody(response);
        agent.destroy();
        throw new SafeWebFetchError(
          "RESPONSE_TOO_LARGE",
          "The webpage is too large to fetch safely."
        );
      }

      try {
        const result = await readBodyWithLimit(
          response.body,
          normalizedMaxBytes
        );
        return { ...result, url: target.url.href };
      } finally {
        agent.destroy();
      }
    }
  } catch (error) {
    if (error instanceof SafeWebFetchError) throw error;
    if (linked.controller.signal.aborted) {
      throw new SafeWebFetchError(
        "FETCH_ABORTED",
        "The webpage fetch was cancelled or timed out.",
        { cause: error }
      );
    }
    throw new SafeWebFetchError(
      "FETCH_FAILED",
      "The webpage could not be fetched.",
      { cause: error }
    );
  } finally {
    linked.cleanup();
  }
}
