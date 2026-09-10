/*
 * RE:new Firefox background runtime.
 *
 * Contains only the background services required by the Marketplace workflow.
 */
(() => {
  "use strict";

  const MESSAGE_TYPES = {
    SCAN_LISTINGS: "mrf:scan-listings",
    REQUEST_SCAN: "mrf:request-scan",
    READ_PAGE_VAR: "mrf:page-var",
    READ_PAGE_VARS: "mrf:page-vars",
    VIDEO_DOWNLOAD_BEGIN: "mrf:video-download-begin",
    VIDEO_DOWNLOAD_CHUNK: "mrf:video-download-chunk",
    VIDEO_DOWNLOAD_END: "mrf:video-download-end",
    UPDATE_BADGE: "mrf:badge",
  };

  const SELLING_PATHS = new Set([
    "/marketplace/you/selling",
    "/marketplace/seller/listings",
  ]);
  const FACEBOOK_HOSTS = new Set(["www.facebook.com", "web.facebook.com"]);
  const SELLING_TAB_PATTERNS = [
    "https://www.facebook.com/marketplace/you/selling*",
    "https://www.facebook.com/marketplace/seller/listings*",
    "https://web.facebook.com/marketplace/you/selling*",
    "https://web.facebook.com/marketplace/seller/listings*",
  ];
  // ---------------------------------------------------------------------------
  // Page-variable reader
  // ---------------------------------------------------------------------------

  const pageCache = new Map();
  const PAGE_CACHE_MS = 5 * 60 * 1000;

  function cacheKey(key, url) {
    return `${url}:${key}`;
  }

  function getCached(key, url) {
    const entry = pageCache.get(cacheKey(key, url));
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      pageCache.delete(cacheKey(key, url));
      return null;
    }
    return entry.value;
  }

  function setCached(key, url, value) {
    pageCache.set(cacheKey(key, url), {
      value,
      expiresAt: Date.now() + PAGE_CACHE_MS,
    });
  }

  async function findExistingTab(url) {
    try {
      const tabs = await chrome.tabs.query({ url });
      return tabs.find(tab => tab.active && tab.id)?.id
        ?? tabs.find(tab => tab.id)?.id
        ?? null;
    } catch {
      return null;
    }
  }

  function waitForTabComplete(tabId) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = () => {
        if (finished) return;
        finished = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        clearTimeout(timeout);
      };
      const onUpdated = (updatedId, changeInfo) => {
        if (updatedId === tabId && changeInfo.status === "complete") {
          cleanup();
          resolve();
        }
      };
      const onRemoved = removedId => {
        if (removedId === tabId) {
          cleanup();
          reject(new Error("Tab closed before page data could be read."));
        }
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out while loading a page used for Marketplace data."));
      }, 60_000);
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
      chrome.tabs.get(tabId).then(tab => {
        if (tab.status === "complete") {
          cleanup();
          resolve();
        }
      }).catch(() => {
        cleanup();
        reject(new Error("Page-data tab is unavailable."));
      });
    });
  }

  async function openBackgroundTab(url) {
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id == null) throw new Error("Could not open a page-data tab.");
    await waitForTabComplete(tab.id);
    return tab.id;
  }

  async function safeCloseTab(tabId) {
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      await chrome.tabs.remove(tabId);
    } catch {}
  }

  async function readOnTab(tabId, keys, options = {}) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [keys, options],
      func: async (requestedKeys, readOptions) => {
        if (readOptions?.inline_json) {
          const scan = () => {
            const values = {};
            const wanted = new Set(requestedKeys);
            const requiredProperty = typeof readOptions.required_property === "string"
              ? readOptions.required_property
              : "";
            let parseable = 0;
            let matches = 0;
            let qualified = 0;

            const visit = value => {
              if (!value || typeof value !== "object") return;
              for (const [key, child] of Object.entries(value)) {
                if (wanted.has(key)) {
                  matches += 1;
                  const valid = !requiredProperty
                    || (child && typeof child === "object" && child[requiredProperty] != null);
                  if (valid) {
                    qualified += 1;
                    values[key] = child;
                  }
                }
                visit(child);
              }
            };

            const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
            for (const script of scripts) {
              try {
                visit(JSON.parse(script.textContent || "{}"));
                parseable += 1;
              } catch {}
            }

            return {
              values,
              diagnostic: {
                path: location.pathname,
                readyState: document.readyState,
                scripts: scripts.length,
                parseable,
                matches,
                qualified,
              },
            };
          };

          const deadline = Date.now() + Math.max(0, Number(readOptions.wait_ms) || 0);
          for (;;) {
            const { values, diagnostic } = scan();
            if (requestedKeys.every(key => values[key] != null)) return values;
            if (Date.now() >= deadline) {
              return {
                ...Object.fromEntries(requestedKeys.map(key => [key, values[key] ?? null])),
                __diagnostic: diagnostic,
              };
            }
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        }

        const output = {};
        const fbRequire = window["require"];
        for (const key of requestedKeys) {
          try {
            if (typeof fbRequire !== "function") throw new Error("Facebook module loader is unavailable.");
            const value = fbRequire(key);
            if (Array.isArray(readOptions?.call_args) && typeof value === "function") {
              output[key] = value(...readOptions.call_args);
            } else if (readOptions?.function_name) {
              output[key] = value[readOptions.function_name]();
            } else {
              output[key] = value;
            }
          } catch {
            output[key] = null;
          }
        }
        return output;
      },
    });
    return result?.result ?? {};
  }

  async function readPageVars(keys, url, options = {}) {
    const output = {};
    const missing = [];
    for (const key of keys) {
      const cached = getCached(key, url);
      if (cached !== null) output[key] = cached;
      else missing.push(key);
    }
    if (!missing.length) return output;

    let tabId = await findExistingTab(url);
    let temporary = false;
    if (tabId == null) {
      tabId = await openBackgroundTab(url);
      temporary = true;
    }

    try {
      const read = await readOnTab(tabId, missing, options);
      for (const key of missing) {
        if (read[key] != null) {
          output[key] = read[key];
          setCached(key, url, read[key]);
        } else {
          output[key] = null;
        }
      }
      if (read.__diagnostic) output.__diagnostic = read.__diagnostic;
      return output;
    } finally {
      if (temporary) await safeCloseTab(tabId);
    }
  }

  async function readPageVar(key, url, options = {}) {
    const values = await readPageVars([key], url, options);
    if (values[key] == null) {
      const detail = values.__diagnostic ? ` (${JSON.stringify(values.__diagnostic)})` : "";
      throw new Error(`Page variable "${key}" was not found on ${url}${detail}`);
    }
    return values[key];
  }

  // ---------------------------------------------------------------------------
  // Video transfer buffer
  // ---------------------------------------------------------------------------

  const videoSessions = new Map();

  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    }
    return btoa(binary);
  }

  function requiredString(value, label) {
    if (typeof value !== "string" || !value) throw new Error(`${label} was missing.`);
    return value;
  }

  function allowedFacebookMediaUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:"
        && (url.hostname.endsWith(".fbcdn.net") || url.hostname.endsWith(".facebook.com"));
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Main extension message router
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const kind = message?.kind;
    const args = message?.args;

    const run = async () => {
      switch (kind) {
        case MESSAGE_TYPES.REQUEST_SCAN: {
          if (sender.tab?.id != null) {
            chrome.tabs.sendMessage(sender.tab.id, { kind: MESSAGE_TYPES.SCAN_LISTINGS, args: undefined }).catch(() => {});
          }
          return undefined;
        }
        case MESSAGE_TYPES.UPDATE_BADGE: {
          const staleCount = args?.staleCount ?? 0;
          const text = staleCount > 0 ? String(staleCount) : "";
          try {
            await chrome.action.setBadgeText({ text });
            await chrome.action.setBadgeBackgroundColor({ color: staleCount > 0 ? "#ef4444" : "#000000" });
          } catch {}
          return undefined;
        }
        case MESSAGE_TYPES.READ_PAGE_VAR: {
          const key = requiredString(args?.key, "Page-variable key");
          const url = requiredString(args?.url, "Page-variable URL");
          return readPageVar(key, url, args?.options);
        }
        case MESSAGE_TYPES.READ_PAGE_VARS: {
          const url = requiredString(args?.url, "Page-variable URL");
          if (!Array.isArray(args?.keys) || !args.keys.length) throw new Error("No page-variable keys were provided.");
          return readPageVars(args.keys, url, args?.options);
        }
        case MESSAGE_TYPES.VIDEO_DOWNLOAD_BEGIN: {
          const sourceUrl = requiredString(args?.sourceUrl, "Video source URL");
          const tabId = sender.tab?.id;
          if (tabId == null || !allowedFacebookMediaUrl(sourceUrl)) {
            return { error: { message: "Facebook video source was not allowed.", stage: "download" } };
          }
          for (const [id, session] of videoSessions) {
            if (session.expiresAt <= Date.now()) videoSessions.delete(id);
          }
          try {
            const response = await fetch(sourceUrl, {
              headers: { Range: "bytes=0-" },
              credentials: "include",
              referrer: "https://www.facebook.com/",
              referrerPolicy: "strict-origin-when-cross-origin",
            });
            if (!response.ok) {
              return { error: { message: "Facebook video download failed.", stage: "download", status: response.status } };
            }
            const blob = await response.blob();
            if (!blob.size) return { error: { message: "Facebook returned an empty video file.", stage: "download" } };
            const sessionId = crypto.randomUUID();
            videoSessions.set(sessionId, { blob, tabId, expiresAt: Date.now() + 10 * 60 * 1000 });
            return { sessionId, size: blob.size, type: blob.type || "video/mp4" };
          } catch {
            return { error: { message: "Facebook video download failed.", stage: "download" } };
          }
        }
        case MESSAGE_TYPES.VIDEO_DOWNLOAD_CHUNK: {
          const sessionId = requiredString(args?.sessionId, "Video download session");
          const session = videoSessions.get(sessionId);
          const start = Number(args?.start);
          const end = Number(args?.end);
          const validRange = Number.isInteger(start)
            && Number.isInteger(end)
            && start >= 0
            && end > start
            && end <= (session?.blob.size ?? 0)
            && end - start <= 8 * 1024 * 1024;
          if (!session || session.tabId !== sender.tab?.id || session.expiresAt <= Date.now() || !validRange) {
            videoSessions.delete(sessionId);
            return { error: { message: "Facebook video download session expired.", stage: "download" } };
          }
          const bytes = new Uint8Array(await session.blob.slice(start, end).arrayBuffer());
          return { data: bytesToBase64(bytes) };
        }
        case MESSAGE_TYPES.VIDEO_DOWNLOAD_END: {
          const sessionId = args?.sessionId;
          const session = typeof sessionId === "string" ? videoSessions.get(sessionId) : undefined;
          if (session?.tabId === sender.tab?.id) videoSessions.delete(sessionId);
          return { ok: true };
        }
        default:
          return undefined;
      }
    };

    if (!kind) return undefined;
    run().then(sendResponse).catch(error => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  });

  // Scan Marketplace when the selling page finishes loading.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete" || !tab.url) return;
    try {
      const url = new URL(tab.url);
      const normalizedPath = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
      if (FACEBOOK_HOSTS.has(url.hostname) && SELLING_PATHS.has(normalizedPath)) {
        chrome.tabs.sendMessage(tabId, { kind: MESSAGE_TYPES.SCAN_LISTINGS, args: undefined }).catch(() => {});
      }
    } catch {}
  });

  // Toolbar icon opens/focuses Marketplace selling page. There is no popup.
  chrome.action.onClicked.addListener(async () => {
    const sellingUrl = "https://www.facebook.com/marketplace/you/selling/";
    const [existing] = await chrome.tabs.query({ url: SELLING_TAB_PATTERNS });
    if (existing?.id != null) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.tabs.reload(existing.id);
      return;
    }
    await chrome.tabs.create({ url: sellingUrl, active: true });
  });
})();
