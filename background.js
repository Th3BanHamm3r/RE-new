/*
 * RE:new Firefox background runtime.
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
	const SELLING_PATHS = new Set(["/marketplace/you/selling", "/marketplace/seller/listings", ]);
	const FACEBOOK_HOSTS = new Set(["www.facebook.com", "web.facebook.com"]);
	const SELLING_TAB_PATTERNS = ["https://www.facebook.com/marketplace/you/selling*", "https://www.facebook.com/marketplace/seller/listings*", "https://web.facebook.com/marketplace/you/selling*", "https://web.facebook.com/marketplace/seller/listings*", ];
	// ---------------------------------------------------------------------------
	// Page-variable reader
	// ---------------------------------------------------------------------------
	const pageCache = new Map();
	const PAGE_CACHE_MS = 5 * 60 * 1000;

	function cacheOptionSignature(options = {}) {
		return JSON.stringify({
			inline_json: options.inline_json === true,
			required_property: typeof options.required_property === "string" ? options.required_property : "",
			relay_doc_id: options.relay_doc_id === true,
			function_name: typeof options.function_name === "string" ? options.function_name : "",
			call_args: Array.isArray(options.call_args) ? options.call_args : null,
		});
	}

	function cacheKey(key, url, options = {}) {
		return `${url}:${key}:${cacheOptionSignature(options)}`;
	}

	function getCached(key, url, options = {}) {
		const keyValue = cacheKey(key, url, options);
		const entry = pageCache.get(keyValue);
		if (!entry) return null;
		if (entry.expiresAt <= Date.now()) {
			pageCache.delete(keyValue);
			return null;
		}
		return entry.value;
	}

	function setCached(key, url, value, options = {}) {
		pageCache.set(cacheKey(key, url, options), {
			value,
			expiresAt: Date.now() + PAGE_CACHE_MS,
		});
	}
	async function ensureFacebookHostPermission(url) {
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error("Invalid Facebook page-data URL.");
		}
		if (parsed.protocol !== "https:" || !(parsed.hostname === "facebook.com" || parsed.hostname.endsWith(".facebook.com"))) {
			throw new Error("RE:new only permits Facebook page-data reads.");
		}
		const originPattern = `${parsed.protocol}//${parsed.hostname}/*`;
		let granted = false;
		try {
			granted = await chrome.permissions.contains({
				origins: [originPattern],
			});
		} catch {
			granted = false;
		}
		if (!granted) {
			throw new Error("Firefox has not granted RE:new access to Facebook. Open about:addons, select RE:new, open Permissions and Data, enable access to facebook.com, then reload Marketplace.");
		}
	}
	async function findExistingTab(url) {
		try {
			const tabs = await chrome.tabs.query({
				url
			});
			return tabs.find(tab => tab.active && tab.id)?.id ?? tabs.find(tab => tab.id)?.id ?? null;
		} catch {
			return null;
		}
	}

	function isFacebookPageUrl(value) {
		try {
			const url = new URL(value);

			return (
				url.protocol === "https:" &&
				(
					url.hostname === "facebook.com" ||
					url.hostname.endsWith(
						".facebook.com"
					)
				)
			);
		} catch {
			return false;
		}
	}

	function waitForTabComplete(tabId) {
		return new Promise(
			(resolve, reject) => {
				let finished = false;

				const cleanup = () => {
					if (finished)
						return;

					finished = true;

					chrome.tabs.onUpdated
						.removeListener(
							onUpdated
						);

					chrome.tabs.onRemoved
						.removeListener(
							onRemoved
						);

					clearTimeout(
						timeout
					);
				};

				const finishIfReady =
					tab => {
						if (
							tab?.status ===
							"complete" &&
							isFacebookPageUrl(
								tab.url
							)
						) {
							cleanup();
							resolve(tab);
							return true;
						}

						return false;
					};

				const onUpdated =
					(
						updatedId,
						_changeInfo,
						tab
					) => {
						if (
							updatedId !== tabId
						) {
							return;
						}

						finishIfReady(
							tab
						);
					};

				const onRemoved =
					removedId => {
						if (
							removedId === tabId
						) {
							cleanup();

							reject(
								new Error(
									"Tab closed before page data could be read."
								)
							);
						}
					};

				const timeout =
					setTimeout(
						() => {
							cleanup();

							reject(
								new Error(
									"Timed out while loading a Facebook page used for Marketplace data."
								)
							);
						},
						60000
					);

				chrome.tabs.onUpdated
					.addListener(
						onUpdated
					);

				chrome.tabs.onRemoved
					.addListener(
						onRemoved
					);

				chrome.tabs
					.get(
						tabId
					)
					.then(
						tab => {
							finishIfReady(
								tab
							);
						}
					)
					.catch(
						() => {
							cleanup();

							reject(
								new Error(
									"Page-data tab is unavailable."
								)
							);
						}
					);
			}
		);
	}
	async function openBackgroundTab(url) {
		const tab =
			await chrome.tabs.create({
				url,
				active: false
			});

		if (tab.id == null) {
			throw new Error(
				"Could not open a page-data tab."
			);
		}

		await waitForTabComplete(
			tab.id
		);

		return tab.id;
	}
	async function safeCloseTab(tabId) {
		try {
			await new Promise(resolve => setTimeout(resolve, 100));
			await chrome.tabs.remove(tabId);
		} catch {}
	}
	async function readOnTab(tabId, keys, options = {}) {
		const targetTab =
			await chrome.tabs.get(
				tabId
			);

		if (
			!isFacebookPageUrl(
				targetTab.url
			)
		) {
			throw new Error(
				`Facebook page-data tab was not ready for script injection: ${
                targetTab.url ||
                "unknown URL"
            }`
			);
		}
		const [result] = await chrome.scripting.executeScript({
			target: {
				tabId
			},
			world: "MAIN",
			args: [
				keys,
				options
			],
			func: async (requestedKeys, readOptions) => {
				const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
				if (readOptions?.inline_json) {
					const scan = () => {
						const values = {};
						const wanted = new Set(requestedKeys);
						const requiredProperty = typeof readOptions.required_property === "string" ? readOptions.required_property : "";
						let parseable = 0;
						let matches = 0;
						let qualified = 0;
						const visit = value => {
							if (!value || typeof value !== "object") {
								return;
							}
							for (const [
									key,
									child
								] of Object.entries(value)) {
								if (wanted.has(key)) {
									matches += 1;
									const valid = !requiredProperty || (child && typeof child === "object" && child[requiredProperty] != null);
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
								qualified
							}
						};
					};
					const deadline = Date.now() + Math.max(0, Number(readOptions.wait_ms) || 0);
					for (;;) {
						const {
							values,
							diagnostic
						} = scan();
						if (requestedKeys.every(key => values[key] != null)) {
							return values;
						}
						if (Date.now() >= deadline) {
							return {
								...Object.fromEntries(requestedKeys.map(key => [
									key,
									values[key] ?? null
								])),
								__diagnostic: diagnostic
							};
						}
						await sleep(250);
					}
				}
				/*
				 * Resolve a persisted Relay doc_id while still inside Facebook's MAIN world.
				 * This avoids trying to structured-clone a  Facebook module wrapper/function back into the extension.
				 */
				const extractRelayDocId = value => {
					const seen = new Set();
					const scalarDocId = candidate => {
						if (typeof candidate === "string" && /^\d{8,30}$/.test(candidate)) {
							return candidate;
						}
						if (typeof candidate === "number" && Number.isFinite(candidate)) {
							const text = String(candidate);
							if (/^\d{8,30}$/.test(text)) {
								return text;
							}
						}
						return "";
					};
					const walk = (candidate, depth = 0) => {
						const scalar = scalarDocId(candidate);
						if (scalar) return scalar;
						if (candidate == null || (typeof candidate !== "object" && typeof candidate !== "function") || depth > 8 || seen.has(candidate)) {
							return "";
						}
						seen.add(candidate);
						// Relay ConcreteRequest normally keeps its persisted operation ID here.
						const directKeys = ["id", "doc_id", "docId"];
						for (const key of directKeys) {
							try {
								const direct = scalarDocId(candidate[key]);
								if (direct) {
									return direct;
								}
							} catch {}
						}
						/*
						 * Common Facebook module wrappers.
						 * Restrict traversal to likely Relay containers so we don't accidentally consume an unrelated Facebook ID.
						 */
						const wrapperKeys = ["params", "default", "request", "operation", "node", "value", "relayOperation", "preloadableRequest", "concreteRequest"];
						for (const key of wrapperKeys) {
							try {
								const nested = walk(candidate[key], depth + 1);
								if (nested) {
									return nested;
								}
							} catch {}
						}
						return "";
					};
					return walk(value);
				};
				const readModules = () => {
					const output = {};
					const fbRequire = window["require"];
					if (typeof fbRequire !== "function") {
						return output;
					}
					for (const key of requestedKeys) {
						try {
							const moduleValue = fbRequire(key);
							if (Array.isArray(readOptions?.call_args) && typeof moduleValue === "function") {
								output[key] = moduleValue(...readOptions.call_args);
							} else if (readOptions?.function_name) {
								output[key] = moduleValue[readOptions.function_name]();
							} else if (readOptions?.relay_doc_id) {
								output[key] = extractRelayDocId(moduleValue) || null;
							} else {
								output[key] = moduleValue;
							}
						} catch {
							output[key] = null;
						}
					}
					return output;
				};
				// Previously this branch tried require() exactly once. Marketplace modules are lazy-loaded, so retry until wait_ms expires.
				const deadline = Date.now() + Math.max(0, Number(readOptions?.wait_ms) || 0);
				for (;;) {
					const output = readModules();
					if (requestedKeys.every(key => output[key] != null)) {
						return output;
					}
					if (Date.now() >= deadline) {
						return {
							...Object.fromEntries(requestedKeys.map(key => [
								key,
								output[key] ?? null
							])),
							__diagnostic: {
								path: location.pathname,
								readyState: document.readyState,
								requireAvailable: typeof window["require"] === "function"
							}
						};
					}
					await sleep(250);
				}
			}
		});
		return result?.result ?? {};
	}
	async function readPageVars(keys, url, options = {}) {
		const output = {};
		const missing = [];
		for (const key of keys) {
			const cached = getCached(key, url, options);
			if (cached !== null) output[key] = cached;
			else missing.push(key);
		}
		if (!missing.length) return output;
		await ensureFacebookHostPermission(url);
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
					setCached(key, url, read[key], options);
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
			return url.protocol === "https:" && (url.hostname.endsWith(".fbcdn.net") || url.hostname.endsWith(".facebook.com"));
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
						chrome.tabs.sendMessage(sender.tab.id, {
							kind: MESSAGE_TYPES.SCAN_LISTINGS,
							args: undefined
						}).catch(() => {});
					}
					return undefined;
				}
				case MESSAGE_TYPES.UPDATE_BADGE: {
					const staleCount = args?.staleCount ?? 0;
					const text = staleCount > 0 ? String(staleCount) : "";
					try {
						await chrome.action.setBadgeText({
							text
						});
						await chrome.action.setBadgeBackgroundColor({
							color: staleCount > 0 ? "#ef4444" : "#000000"
						});
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
						return {
							error: {
								message: "Facebook video source was not allowed.",
								stage: "download"
							}
						};
					}
					for (const [id, session] of videoSessions) {
						if (session.expiresAt <= Date.now()) videoSessions.delete(id);
					}
					try {
						const response = await fetch(sourceUrl, {
							headers: {
								Range: "bytes=0-"
							},
							credentials: "include",
							referrer: "https://www.facebook.com/",
							referrerPolicy: "strict-origin-when-cross-origin",
						});
						if (!response.ok) {
							return {
								error: {
									message: "Facebook video download failed.",
									stage: "download",
									status: response.status
								}
							};
						}
						const blob = await response.blob();
						if (!blob.size) return {
							error: {
								message: "Facebook returned an empty video file.",
								stage: "download"
							}
						};
						const sessionId = crypto.randomUUID();
						videoSessions.set(sessionId, {
							blob,
							tabId,
							expiresAt: Date.now() + 10 * 60 * 1000
						});
						return {
							sessionId,
							size: blob.size,
							type: blob.type || "video/mp4"
						};
					} catch {
						return {
							error: {
								message: "Facebook video download failed.",
								stage: "download"
							}
						};
					}
				}
				case MESSAGE_TYPES.VIDEO_DOWNLOAD_CHUNK: {
					const sessionId = requiredString(args?.sessionId, "Video download session");
					const session = videoSessions.get(sessionId);
					const start = Number(args?.start);
					const end = Number(args?.end);
					const validRange = Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= (session?.blob.size ?? 0) && end - start <= 8 * 1024 * 1024;
					if (!session || session.tabId !== sender.tab?.id || session.expiresAt <= Date.now() || !validRange) {
						videoSessions.delete(sessionId);
						return {
							error: {
								message: "Facebook video download session expired.",
								stage: "download"
							}
						};
					}
					const bytes = new Uint8Array(await session.blob.slice(start, end).arrayBuffer());
					return {
						data: bytesToBase64(bytes)
					};
				}
				case MESSAGE_TYPES.VIDEO_DOWNLOAD_END: {
					const sessionId = args?.sessionId;
					const session = typeof sessionId === "string" ? videoSessions.get(sessionId) : undefined;
					if (session?.tabId === sender.tab?.id) videoSessions.delete(sessionId);
					return {
						ok: true
					};
				}
				default:
					return undefined;
			}
		};
		if (!kind) return undefined;
		run().then(sendResponse).catch(error => sendResponse({
			error: error instanceof Error ? error.message : String(error)
		}));
		return true;
	});
	// Scan Marketplace when the selling page finishes loading.
	chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
		if (changeInfo.status !== "complete" || !tab.url) return;
		try {
			const url = new URL(tab.url);
			const normalizedPath = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
			if (FACEBOOK_HOSTS.has(url.hostname) && SELLING_PATHS.has(normalizedPath)) {
				chrome.tabs.sendMessage(tabId, {
					kind: MESSAGE_TYPES.SCAN_LISTINGS,
					args: undefined
				}).catch(() => {});
			}
		} catch {}
	});
	// Toolbar icon opens/focuses Marketplace selling page. There is no popup.
	chrome.action.onClicked.addListener(async () => {
		const sellingUrl = "https://www.facebook.com/marketplace/you/selling/";
		const [existing] = await chrome.tabs.query({
			url: SELLING_TAB_PATTERNS
		});
		if (existing?.id != null) {
			await chrome.tabs.update(existing.id, {
				active: true
			});
			await chrome.tabs.reload(existing.id);
			return;
		}
		await chrome.tabs.create({
			url: sellingUrl,
			active: true
		});
	});
})();
