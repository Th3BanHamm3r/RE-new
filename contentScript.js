/*
 * RE:new Firefox extension.
 *
 * Core Marketplace listing selection and relisting logic.
 */
(() => {
    "use strict";
    const MESSAGE_TYPES = Object.freeze({
        SCAN_LISTINGS: "mrf:scan-listings",
        REQUEST_SCAN: "mrf:request-scan",
        READ_PAGE_VAR: "mrf:page-var",
        READ_PAGE_VARS: "mrf:page-vars",
        VIDEO_DOWNLOAD_BEGIN: "mrf:video-download-begin",
        VIDEO_DOWNLOAD_CHUNK: "mrf:video-download-chunk",
        VIDEO_DOWNLOAD_END: "mrf:video-download-end",
        UPDATE_BADGE: "mrf:badge",
    });
    const LISTING_PAGE_TYPES = Object.freeze({
        Item: "MarketplaceForSaleItemProductDetailsPage",
        RealEstate: "MarketplaceRealEstateProductDetailsPage",
        Vehicle: "MarketplaceVehicleProductDetailsPage",
    });

    // Local console diagnostics for development and troubleshooting. No data leaves the browser.
    function logDiagnostic(message, context = "RE:new", level = "debug") {
        const method = level === "error" ? "error" : level === "warning" ? "warn" : "debug";
        console[method](`[RE:new:${context}] ${message}`);
    }

    function reportError(error, context = {}) {
        const message = error instanceof Error ? error.message : String(error);
        const label = typeof context.context === "string" ? context.context : "runtime";
        console.error(`[RE:new:${label}] ${message}`, error);
    }

    // Recursively locate a named property in Facebook's nested bootstrapped JSON.
    function findNestedValue(e = {}, t, n) {
        let r = null == e ? void 0 : e[t];
        const i = new Set, visitObject = e => {
            if (null != e && "object" == typeof e && !i.has(e)) {
                i.add(e), t in e && (r = n ? n(r, e[t]) : e[t]);
                for (const t of Object.values(e))
                    visitObject(t);
            }
        };
        return visitObject(e), r;
    }

    async function readPageVariable(t, n, r) {
        return sendRuntimeMessage({
            kind: MESSAGE_TYPES.READ_PAGE_VAR,
            args: {
                key: t,
                url: n,
                options: r
            }
        });
    }

    async function retryAsync(operation, { everyMs, untilMs = 0, maxTries = 0 }) {
        let elapsedMs = 0;
        let attempts = 0;

        for (;;) {
            try {
                return await operation();
            }
            catch (error) {
                attempts += 1;
                elapsedMs += everyMs;

                if (
                    (untilMs && elapsedMs >= untilMs) ||
                    (maxTries && attempts >= maxTries)
                ) {
                    throw error;
                }

                await new Promise(resolve => setTimeout(resolve, everyMs));
            }
        }
    }

    async function sendRuntimeMessage(e) {
        return chrome.runtime.sendMessage(e);
    }

    // ---------------------------------------------------------------------------
    // Runtime messaging and Facebook session/token cache
    // ---------------------------------------------------------------------------

    const FACEBOOK_TOKEN_CACHE_KEY = "FB_TOKEN_CACHE";

    class FacebookTokenCache {
        static async getCached() {
            try {
                const e = (
                    await chrome.storage.local.get(FACEBOOK_TOKEN_CACHE_KEY)
                )[FACEBOOK_TOKEN_CACHE_KEY];

                return e
                    ? Date.now() > e.expiry
                        ? (await this.clear(), null)
                        : e.tokens
                    : null;
            }
            catch {
                return null;
            }
        }

        static async set(e) {
            try {
                const t = {
                    tokens: {
                        ...e,
                        timestamp: Date.now()
                    },
                    expiry: Date.now() + 36e5
                };

                await chrome.storage.local.set({
                    [FACEBOOK_TOKEN_CACHE_KEY]: t
                });
            }
            catch {
            }
        }

        static async clear() {
            try {
                await chrome.storage.local.remove(FACEBOOK_TOKEN_CACHE_KEY);
            }
            catch {
            }
        }
    }

    const LISTING_CACHE_KEY = "mrf_listings";
    const RECENTLY_RELISTED_KEY = "mrf_relisted";
    const RECENT_RELIST_WINDOW_MS = 9e5;

    async function getRecentlyRelistedIds() {
        try {
            const e = (
                await chrome.storage.local.get(RECENTLY_RELISTED_KEY)
            )[RECENTLY_RELISTED_KEY] || {};

            const t = Date.now();
            const n = new Set();

            for (const [r, i] of Object.entries(e)) {
                if (t - i <= RECENT_RELIST_WINDOW_MS)
                    n.add(r);
            }

            return n;
        }
        catch {
            return new Set();
        }
    }

    // ---------------------------------------------------------------------------
    // Video preservation and Facebook upload transport
    // ---------------------------------------------------------------------------

    class VideoPreservationError extends Error {
        stage;
        status;
        retryable;

        constructor(e, t, n, r = false) {
            super(t);
            this.stage = e;
            this.status = n;
            this.retryable = r;
            this.name = "VideoPreservationError";
        }
    }

    const TRANSPORT_PARAM_ALLOWLIST = new Set([
        "__a",
        "__aaid",
        "__ccg",
        "__comet_req",
        "__crn",
        "__csr",
        "__dyn",
        "__hblp",
        "__hs",
        "__hsdp",
        "__hsi",
        "__req",
        "__rev",
        "__s",
        "__sjsp",
        "__spin_b",
        "__spin_r",
        "__spin_t",
        "__user",
        "dpr",
        "fb_dtsg",
        "jazoest",
        "lsd",
        "qpl_active_flow_ids"
    ]);

    function filterTransportParams(e) {
        const t = {};

        if (!e)
            return t;

        for (const [n, r] of Object.entries(e)) {
            if (
                TRANSPORT_PARAM_ALLOWLIST.has(n) &&
                (
                    typeof r === "string" ||
                    typeof r === "number" ||
                    typeof r === "boolean"
                )
            ) {
                t[n] = r;
            }
        }

        return t;
    }

    function isPlainObject(e) {
        return null !== e && typeof e === "object" && !Array.isArray(e);
    }

    function findUploadUris(e, t) {
        return [
            ...Object.entries(e)
                .filter(([e, n]) =>
                    typeof n === "string" &&
                    e.toLowerCase().includes(`${t}_uri`)
                )
                .sort(
                    ([e], [t]) =>
                        Number(t.toLowerCase().includes("chunk")) -
                        Number(e.toLowerCase().includes("chunk"))
                )
                .map(([, e]) => e),

            ...Object.values(e)
                .filter(isPlainObject)
                .flatMap(e => findUploadUris(e, t))
        ]
            .filter((e, t, n) => n.indexOf(e) === t)
            .sort(
                (e, t) =>
                    Number(!e.includes("vupload-edge.")) -
                    Number(!t.includes("vupload-edge."))
            );
    }

    function getPreferredVideoUrl(e) {
        for (const t of e) {
            const e =
                t.playable_url_quality_hd ||
                t.playable_url ||
                t.playable_url_quality_sd;

            if (typeof e === "string" && e.length > 0)
                return e;
        }

        throw new Error(
            "Facebook did not provide a downloadable video source."
        );
    }

    function stringifyParam(e) {
        return null == e ? "" : String(e);
    }

    function buildUrlSearchParams(e) {
        const t = new URLSearchParams();

        for (const [n, r] of Object.entries(e)) {
            if (null != r)
                t.set(n, stringifyParam(r));
        }

        return t;
    }

    function inferVideoFileExtension(e, t) {
        try {
            const t = new URL(e).pathname.match(/\.([a-z0-9]{2,5})$/i);

            if (t)
                return t[1].toLowerCase();
        }
        catch {
        }

        const n = t.split("/")[1]?.split(";")[0]?.toLowerCase();

        return n === "quicktime" ? "mov" : n || "mp4";
    }

    function readUploadOffset(e, t, n) {
        const r = Number(e[t]);

        if (!Number.isFinite(r) || r < 0) {
            throw new VideoPreservationError(
                n,
                `Facebook returned invalid ${n} upload offsets.`
            );
        }

        return r;
    }

    async function parseUploadResponse(e, t) {
        if (!e.ok) {
            throw new VideoPreservationError(
                t,
                `Facebook video ${t} request failed.`,
                e.status,
                e.status === 408 ||
                e.status === 429 ||
                e.status >= 500
            );
        }

        try {
            const raw = await e.text();
            let parsed;

            try {
                parsed = JSON.parse(
                    raw.replace(/^for\s*\(;;\);\s*/, "")
                );
            }
            catch {
                throw new Error(
                    "Facebook returned an unreadable video upload response."
                );
            }

            const payload = parsed?.payload ?? parsed;

            if (!isPlainObject(payload) || parsed?.error || payload.error) {
                throw new Error(
                    "Facebook rejected the video upload request."
                );
            }

            return payload;
        }
        catch (e) {
            if (e instanceof VideoPreservationError)
                throw e;

            throw new VideoPreservationError(
                t,
                e instanceof Error
                    ? e.message
                    : `Facebook video ${t} request failed.`
            );
        }
    }

    async function requestUploadWithRetry(e, t, n, r, i) {
        let s;

        for (let o = 0; o <= n; o += 1) {
            const a = t[o % t.length];

            try {
                return await parseUploadResponse(await i(a), e);
            }
            catch (t) {
                s =
                    t instanceof VideoPreservationError
                        ? t
                        : new VideoPreservationError(
                            e,
                            `Facebook video ${e} request was interrupted.`,
                            undefined,
                            true
                        );

                if (!s.retryable || o >= n)
                    throw s;

                await r(250 * 2 ** o);
            }
        }

        throw s ??
            new VideoPreservationError(
                e,
                `Facebook video ${e} request failed.`
            );
    }

    async function uploadVideo(
        {
            sourceUrl: e,
            rawConfig: t,
            actorId: n,
            fbDtsg: r,
            lsd: i,
            transportParams: s,
            fetchImpl: o = fetch,
            sleep: a = e =>
                new Promise(t => setTimeout(t, e)),
            createId: c = () => crypto.randomUUID(),
            onProgress: l = undefined
        },
        u
    ) {
        const d = (() => {
            let config = t;

            for (
                let attempt = 0;
                attempt < 2 && typeof config === "string";
                attempt += 1
            ) {
                try {
                    config = JSON.parse(config);
                }
                catch {
                    break;
                }
            }

            const videoConfig =
                isPlainObject(config) &&
                isPlainObject(config.video_upload_config)
                    ? config.video_upload_config
                    : config;

            if (!isPlainObject(videoConfig)) {
                throw new Error(
                    "Facebook video upload configuration is invalid."
                );
            }

            const root = isPlainObject(config)
                ? config
                : videoConfig;

            const startUris = findUploadUris(root, "start");
            const receiveUris = findUploadUris(root, "receive");

            const source =
                typeof videoConfig.source === "string"
                    ? videoConfig.source
                    : "";

            const isValidUri = uri => {
                try {
                    const parsed = new URL(uri);

                    return (
                        parsed.protocol === "https:" &&
                        parsed.hostname.endsWith(".facebook.com")
                    );
                }
                catch {
                    return false;
                }
            };

            if (
                startUris.length === 0 ||
                receiveUris.length === 0 ||
                !source ||
                [...startUris, ...receiveUris].some(uri => !isValidUri(uri))
            ) {
                throw new Error(
                    "Facebook video upload configuration is invalid."
                );
            }

            const retryCount = Number(
                videoConfig.start_max_transport_retries ??
                videoConfig.receive_max_transport_retries
            );

            return {
                startUris,
                receiveUris,
                source,
                composerDialogVersion:
                    typeof videoConfig.composer_dialog_version === "string"
                        ? videoConfig.composer_dialog_version
                        : "",
                maxRetries:
                    Number.isFinite(retryCount) && retryCount >= 0
                        ? retryCount
                        : 3
            };
        })();

        const p = c();

        const f = {
            ...filterTransportParams(s),
            __user: n,
            __a: 1,
            fb_dtsg: r,
            lsd: i,
            jazoest: `2${[...r].reduce(
                (e, t) => e + t.charCodeAt(0),
                0
            )}`,
            target_id: n,
            source: d.source,
            composer_dialog_version: d.composerDialogVersion,
            waterfall_id: p,
            has_file_been_replaced: false,
            supports_chunking: true
        };

        const g = buildUrlSearchParams({
            ...f,
            file_size: u.size,
            file_extension: inferVideoFileExtension(e, u.type),
            supports_file_api: true,
            partition_start_offset: 0,
            partition_end_offset: u.size,
            spherical: false,
            composer_entry_point_ref: "",
            composer_work_shared_draft_mode: "",
            creator_product: 2,
            video_publisher_action_source: ""
        });

        const h = await requestUploadWithRetry(
            "start",
            d.startUris,
            d.maxRetries,
            a,
            async e => {
                try {
                    return await o(e, {
                        method: "POST",
                        headers: {
                            accept: "*/*",
                            "content-type":
                                "application/x-www-form-urlencoded",
                            X_FB_VIDEO_WATERFALL_ID: p
                        },
                        body: g,
                        mode: "cors",
                        credentials: "include",
                        referrer: "https://www.facebook.com/",
                        referrerPolicy:
                            "strict-origin-when-cross-origin"
                    });
                }
                catch {
                    throw new VideoPreservationError(
                        "start",
                        "Facebook video upload could not start.",
                        undefined,
                        true
                    );
                }
            }
        );

        const m =
            typeof h.video_id === "string"
                ? h.video_id
                : "";

        if (!m) {
            throw new VideoPreservationError(
                "start",
                "Facebook did not return a fresh video ID."
            );
        }

        let _ = readUploadOffset(h, "start_offset", "start");
        let y = readUploadOffset(h, "end_offset", "start");

        while (_ < u.size) {
            if (y <= _ || y > u.size) {
                throw new VideoPreservationError(
                    "receive",
                    "Facebook returned invalid receive upload offsets."
                );
            }

            const params = buildUrlSearchParams({
                ...f,
                video_id: m,
                start_offset: _,
                end_offset: y,
                partition_start_offset: 0,
                partition_end_offset: u.size
            });

            const form = new FormData();

            form.append(
                "video_file_chunk",
                await u.slice(_, y),
                "blob"
            );

            const result = await requestUploadWithRetry(
                "receive",
                d.receiveUris,
                d.maxRetries,
                a,
                async n => {
                    const uploadUrl = new URL(n);

                    params.forEach((e, t) =>
                        uploadUrl.searchParams.set(t, e)
                    );

                    try {
                        return await o(uploadUrl, {
                            method: "POST",
                            headers: {
                                accept: "*/*",
                                X_FB_VIDEO_WATERFALL_ID: p
                            },
                            body: form,
                            mode: "cors",
                            credentials: "include",
                            referrer: "https://www.facebook.com/",
                            referrerPolicy:
                                "strict-origin-when-cross-origin"
                        });
                    }
                    catch {
                        throw new VideoPreservationError(
                            "receive",
                            "Facebook video upload was interrupted.",
                            undefined,
                            true
                        );
                    }
                }
            );

            const nextStart = readUploadOffset(
                result,
                "start_offset",
                "receive"
            );

            const nextEnd = readUploadOffset(
                result,
                "end_offset",
                "receive"
            );

            if (nextStart <= _) {
                throw new VideoPreservationError(
                    "receive",
                    "Facebook video upload stopped progressing."
                );
            }

            _ = nextStart;
            y = nextEnd;

            l?.(Math.min(_, u.size), u.size);
        }

        return m;
    }

    function throwIfVideoDownloadFailed(e) {
        if (e?.error) {
            throw new VideoPreservationError(
                e.error.stage ?? "download",
                e.error.message ||
                    "Facebook video download failed.",
                e.error.status,
                e.error.retryable
            );
        }
    }

    // ---------------------------------------------------------------------------
    // Listing field normalization and shipping-data preservation
    // ---------------------------------------------------------------------------

    const DEFAULT_SHIPPING_FIELDS = {
        delivery_types: ["IN_PERSON"],
        shipping_offered: false,
        shipping_cost_option: "BUYER_PAID_SHIPPING",
        shipping_price: "null",
        shipping_label_price: "0",
        shipping_label_rate_code: null,
        shipping_label_rate_type: null,
        shipping_service_type: null,
        shipping_package_weight: null,
        shipping_options_data: [],
        shipping_calculation_logic_version: null,
        shipping_cost_range_lower_cost: null,
        shipping_cost_range_upper_cost: null,
        commerce_shipping_carrier: null,
        commerce_shipping_carriers: []
    };

    const isStringArray = e =>
        Array.isArray(e) &&
        e.every(e => typeof e === "string");

    const hasOwnDefinedProperty = (e, t) =>
        Object.prototype.hasOwnProperty.call(e, t) &&
        e[t] !== undefined;

    function cloneJsonValue(e) {
        try {
            const t = JSON.stringify(e);

            return t === undefined
                ? undefined
                : JSON.parse(t);
        }
        catch {
            return undefined;
        }
    }

    function findFirstMatchingProperty(
        e,
        t,
        n = _value => true
    ) {
        for (const r of e) {
            for (const key of t) {
                if (!hasOwnDefinedProperty(r, key))
                    continue;

                const value = cloneJsonValue(r[key]);

                if (value !== undefined && n(value))
                    return value;
            }
        }

        return undefined;
    }

    function arrayOrDefaultCopy(e, t) {
        return Array.isArray(e) ? e : [...t];
    }

    function getFixedCostShippingOption(e) {
        const t = e.shipping_profile;
        const n =
            t?.fixed_cost_shipping_options?.nodes?.find(
                isPlainObject
            );

        const r = cloneJsonValue(n);

        if (isPlainObject(r))
            return r;

        return undefined;
    }

    // ---------------------------------------------------------------------------
    // Facebook Marketplace GraphQL discovery and listing synchronization
    // ---------------------------------------------------------------------------

    const marketplaceState = {};

    const MARKETPLACE_SELLING_URL =
        "https://www.facebook.com/marketplace/you/selling";

    const MARKETPLACE_CREATE_URL =
        "https://www.facebook.com/marketplace/create/item";

    function firstNonNullish(...e) {
        for (const t of e) {
            if (t != null)
                return t;
        }

        return undefined;
    }

    function requireNonEmptyString(e, t) {
        if (typeof e !== "string" || e.length === 0)
            throw new Error(t);

        return e;
    }

    function requireNumber(e, t) {
        if (typeof e !== "number" || Number.isNaN(e))
            throw new Error(t);

        return e;
    }

    class SpacedRequestQueue {
        spacingMs;
        earliestNext = 0;

        constructor(e) {
            this.spacingMs = e;
        }

        run(e) {
            const t = Date.now();
            const n = Math.max(t, this.earliestNext);

            this.earliestNext =
                n + this.spacingMs;

            const r = n - t;

            return (
                r > 0
                    ? new Promise(e =>
                        setTimeout(e, r)
                    )
                    : Promise.resolve()
            ).then(e);
        }
    }

    const listingReadQueue =
        new SpacedRequestQueue(1500);

    const listingCreateQueue =
        new SpacedRequestQueue(2500);

    const listingDeleteQueue =
        new SpacedRequestQueue(2500);

    const DEFAULT_CREATE_LISTING_FIELDS = {
        surface: "composer",
        is_preview: false,
        is_personalization_required: null,
        personalization_info: null,
        draft_type: null,
        quantity: null,
        cost_per_additional_item: null,
        comparable_price: "null",
        min_acceptable_checkout_offer_price: "null",
        suggested_hashtag_names: [],
        variants: [],
        xpost_target_ids: []
    };

    async function facebookGraphqlRequest(
        e,
        t,
        n,
        r
    ) {
        const i = [
            ["av", marketplaceState.user_id],
            ["__a", "1"],
            ["__comet_req", "1"],
            ["fb_dtsg", marketplaceState.fb_dtsg],
            ["fb_api_caller_class", "RelayModern"],
            ["fb_api_req_friendly_name", n],
            [
                "variables",
                encodeURIComponent(
                    JSON.stringify(r)
                )
            ],
            ["doc_id", t]
        ]
            .map(
                ([e, t]) =>
                    `${e}=${t}`
            )
            .join("&");

        const s = await fetch(
            "https://www.facebook.com/api/graphql/",
            {
                method: "POST",
                headers: {
                    accept: "*/*",
                    "content-type":
                        "application/x-www-form-urlencoded"
                },
                referrer: e,
                referrerPolicy:
                    "strict-origin-when-cross-origin",
                body: i,
                mode: "cors",
                credentials: "include"
            }
        );

        try {
            const text =
                await s.clone().text();

            if (
                text.includes('"error_code":1357004') ||
                text.includes('"error":1357004') ||
                text.includes('"error_code":190') ||
                text.includes("OAuthException") ||
                text.includes("Session has expired")
            ) {
                logDiagnostic(
                    "Auth error detected - clearing token cache",
                    "token_cache",
                    "warning"
                );

                await FacebookTokenCache.clear();
            }
        }
        catch {
        }

        return s;
    }

    async function fetchMarketplacePageData(e) {
        const t = await fetch(e, {
            method: "GET",
            headers: {
                accept:
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            },
            referrerPolicy:
                "strict-origin-when-cross-origin",
            credentials: "include"
        });

        const n =
            new DOMParser().parseFromString(
                await t.clone().text(),
                "text/html"
            );

        if (!n) {
            throw new Error(
                "Page HTML could not be parsed."
            );
        }

        const r = Array.from(
            n.getElementsByTagName("script")
        )
            .filter(
                e =>
                    e.type ===
                    "application/json"
            )
            .map(
                e =>
                    JSON.parse(
                        e.textContent ?? "{}"
                    )
            );

        return {
            inline_JSONs: r
        };
    }

    const inlineScriptTextCache =
        new WeakMap();

    function collectMarketplaceListingSets(e) {
        const t = [];
        const n = new Set();

        const visitNode = e => {
            if (
                !e ||
                typeof e !== "object" ||
                n.has(e)
            ) {
                return;
            }

            n.add(e);

            if (
                e.marketplace_listing_sets?.edges
            ) {
                t.push(
                    e.marketplace_listing_sets
                );
            }

            Object.values(e).forEach(
                visitNode
            );
        };

        e.forEach(visitNode);

        return t;
    }

    async function mergeListingSets(e) {
        const t =
            await getRecentlyRelistedIds();

        const n = e
            .flatMap(
                e => e.edges ?? []
            )
            .map(
                ({ node: e }) =>
                    e?.first_listing
            )
            .filter(Boolean)
            .filter(
                e => !t.has(e.id)
            )
            .filter(isActiveListing)
            .filter(
                e =>
                    !marketplaceState
                        .active_listings_id_map[
                        e.id
                    ]
            );

        if (n.length === 0)
            return 0;

        await addActiveListings(n);

        return n.length;
    }

    async function scanInlineListingData() {
        if (typeof document === "undefined")
            return mergeListingSets([]);

        const values =
            Array.from(
                document.querySelectorAll(
                    'script[type="application/json"]'
                )
            ).flatMap(e => {
                const t =
                    e.textContent ?? "";

                if (
                    inlineScriptTextCache.get(e) === t
                ) {
                    return [];
                }

                inlineScriptTextCache.set(e, t);

                try {
                    return [
                        JSON.parse(t || "{}")
                    ];
                }
                catch {
                    return [];
                }
            });

        return mergeListingSets(
            collectMarketplaceListingSets(values)
        );
    }

    async function refreshMarketplaceState(t = {}) {
        await scanInlineListingData();

        const n =
            await fetchMarketplacePageData(
                MARKETPLACE_SELLING_URL
            );

        if (!n) {
            throw new Error(
                "Marketplace page data was unreadable."
            );
        }

        await mergeListingSets(
            collectMarketplaceListingSets(
                n.inline_JSONs ?? []
            )
        );

        const resolveMarketplaceId =
            async () => {
                const e =
                    findNestedValue(
                        n,
                        "current_marketplace"
                    );

                if (
                    typeof e?.id === "string" &&
                    e.id.length > 0
                ) {
                    return e.id;
                }

                try {
                    const e =
                        await readPageVariable(
                            "current_marketplace",
                            MARKETPLACE_CREATE_URL,
                            {
                                inline_json: true,
                                required_property:
                                    "id",
                                wait_ms: 10000
                            }
                        );

                    return (
                        typeof e?.id === "string" &&
                        e.id.length > 0
                    )
                        ? e.id
                        : undefined;
                }
                catch {
                    return undefined;
                }
            };

        const i =
            findNestedValue(
                n,
                "USER_ID"
            );

        const s =
            await FacebookTokenCache.getCached();

        if (s) {
            if (!i || s.user_id === i) {
                marketplaceState.user_id =
                    s.user_id;

                marketplaceState.fb_dtsg =
                    s.fb_dtsg;

                marketplaceState.marketplace_id =
                    s.marketplace_id ||
                    await resolveMarketplaceId() ||
                    "";

                logDiagnostic(
                    "Using cached Facebook tokens",
                    "token_cache",
                    "info"
                );
            }
            else {
                logDiagnostic(
                    "Profile switch detected — clearing stale token cache",
                    "token_cache",
                    "info"
                );

                await FacebookTokenCache.clear();
            }
        }

        if (!marketplaceState.user_id) {
            logDiagnostic(
                "Token cache miss - extracting fresh tokens",
                "token_cache",
                "info"
            );

            const o =
                await sendRuntimeMessage({
                    kind:
                        MESSAGE_TYPES.READ_PAGE_VARS,
                    args: {
                        keys: [
                            "CurrentUserInitialData",
                            "DTSGInitialData"
                        ],
                        url:
                            MARKETPLACE_SELLING_URL,
                        options:
                            undefined
                    }
                });

            const a =
                o.CurrentUserInitialData;

            marketplaceState.user_id =
                requireNonEmptyString(
                    a?.USER_ID,
                    "User identity data was missing from the page"
                );

            const c =
                o.DTSGInitialData;

            marketplaceState.fb_dtsg =
                requireNonEmptyString(
                    c?.token,
                    "Session token was missing from the page"
                );

            marketplaceState.marketplace_id =
                await resolveMarketplaceId() ||
                "";

            await FacebookTokenCache.set({
                fb_dtsg:
                    marketplaceState.fb_dtsg,
                user_id:
                    marketplaceState.user_id,
                marketplace_id:
                    marketplaceState.marketplace_id,
                timestamp:
                    Date.now()
            });

            logDiagnostic(
                "Cached fresh Facebook tokens (1 hour expiry)",
                "token_cache",
                "info"
            );
        }

        const revalidate =
            Boolean(t.revalidate);

        if (!revalidate)
            marketplaceState.sync_done = false;

        const refreshedListings = [];
        const refreshedIds = {};
        const recentlyRelisted =
            await getRecentlyRelistedIds();

        try {
            let cursor = null;

            for (
                let page = 0;
                page < 50;
                page += 1
            ) {
                const {
                    listings,
                    hasNextPage,
                    endCursor
                } =
                    await fetchSellingListingsPage(
                        cursor
                    );

                const pageListings =
                    (listings.edges ?? [])
                        .map(
                            e =>
                                e?.node
                                    ?.first_listing
                        )
                        .filter(Boolean);

                if (revalidate) {
                    for (const listing of pageListings) {
                        if (
                            !isActiveListing(listing) ||
                            recentlyRelisted.has(
                                listing.id
                            ) ||
                            refreshedIds[
                                listing.id
                            ]
                        ) {
                            continue;
                        }

                        refreshedIds[
                            listing.id
                        ] = true;

                        refreshedListings.push(
                            listing
                        );
                    }
                }
                else {
                    await addActiveListings(
                        pageListings.filter(
                            listing =>
                                !recentlyRelisted.has(
                                    listing.id
                                )
                        )
                    );
                }

                if (
                    !hasNextPage ||
                    !endCursor ||
                    endCursor === cursor
                ) {
                    break;
                }

                cursor = endCursor;
            }
        }
        finally {
            if (revalidate) {
                sortListingsNewestFirst(
                    refreshedListings
                );

                marketplaceState.active_listings =
                    refreshedListings;

                marketplaceState.active_listings_id_map =
                    refreshedIds;
            }

            marketplaceState.sync_done = true;

            document.dispatchEvent(
                new Event(
                    "RE:new:listings-updated"
                )
            );

            try {
                if (
                    marketplaceState.user_id &&
                    Array.isArray(
                        marketplaceState.active_listings
                    )
                ) {
                    const listings =
                        marketplaceState
                            .active_listings;

                    if (
                        listings.length > 0 &&
                        listings.length <= 800
                    ) {
                        const cacheListings =
                            listings.map(
                                e => ({
                                    id: e.id,
                                    creation_time:
                                        e.creation_time,
                                    ...(e
                                        .primary_listing_photo
                                        ?.image
                                        ?.uri
                                        ? {
                                            primary_listing_photo:
                                                {
                                                    image:
                                                        {
                                                            uri:
                                                                e
                                                                    .primary_listing_photo
                                                                    .image
                                                                    .uri
                                                        }
                                                }
                                        }
                                        : {})
                                })
                            );

                        await chrome.storage.local.set({
                            [LISTING_CACHE_KEY]:
                                {
                                    userId:
                                        marketplaceState.user_id,
                                    ts:
                                        Date.now(),
                                    listings:
                                        cacheListings
                                }
                        });
                    }
                }
            }
            catch {
            }
        }

        return marketplaceState;
    }

    function parseGraphqlLines(e) {
        const t = e
            .split("\n")
            .map(
                e =>
                    e
                        .replace(
                            /^for\s*\(;;\);/,
                            ""
                        )
                        .trim()
            )
            .filter(Boolean)
            .map(e => JSON.parse(e));

        const n = t.find(
            e =>
                e &&
                e.error !== undefined &&
                e.error !== null
        );

        if (n) {
            throw new Error(
                `Facebook session error ${n.error}: ${
                    n.errorDescription ||
                    n.errorSummary ||
                    "please reload the page"
                }`
            );
        }

        return t;
    }

    async function fetchSellingListingsPage(e = null) {
        const t =
            await facebookGraphqlRequest(
                MARKETPLACE_SELLING_URL,
                "6206851639350477",
                "MarketplaceYouSellingFastActiveSectionPaginationQuery",
                {
                    count: 10,
                    ...(e
                        ? { cursor: e }
                        : {}),
                    order:
                        "CREATION_TIMESTAMP_DESC",
                    scale: 2,
                    state: null,
                    status: null,
                    title_search: null
                }
            );

        const [n, r] =
            parseGraphqlLines(
                await t.clone().text()
            );

        const i =
            findNestedValue(
                n,
                "marketplace_listing_sets"
            );

        if (i == null) {
            throw new Error(
                "Listing collection was missing from the response"
            );
        }

        const s =
            r?.data?.page_info;

        return {
            listings: i,
            hasNextPage:
                Boolean(
                    s?.has_next_page
                ),
            endCursor:
                s?.end_cursor ?? null
        };
    }

    function isActiveListing(e) {
        return (
            !e.is_pending &&
            !e.is_draft &&
            !e.is_sold
        );
    }

    function sortListingsNewestFirst(e) {
        e.sort(
            (e, t) =>
                (t.creation_time || 0) -
                (e.creation_time || 0)
        );
    }

    async function addActiveListings(e) {
        for (const t of e) {
            if (
                isActiveListing(t) &&
                !marketplaceState
                    .active_listings_id_map[
                    t.id
                ]
            ) {
                marketplaceState.active_listings.push(
                    t
                );

                marketplaceState
                    .active_listings_id_map[
                    t.id
                ] = true;
            }
        }

        sortListingsNewestFirst(
            marketplaceState.active_listings
        );

        document.dispatchEvent(
            new Event(
                "RE:new:listings-updated"
            )
        );

        return marketplaceState.active_listings;
    }

    async function fetchListingPhotoUrls(e) {
        const t =
            await facebookGraphqlRequest(
                MARKETPLACE_SELLING_URL,
                marketplaceState.listing_doc_id,
                "MediaViewerResponse",
                {
                    targetId: e
                }
            );

        const n =
            await t?.clone().json();

        const r =
            n?.data?.viewer
                ?.marketplace_product_details_page
                ?.target?.listing_photos;

        if (!r) {
            logDiagnostic(
                `Media-viewer returned no photos for listing ${e}`,
                "read_listing",
                "warning"
            );

            throw new Error(
                "Listing photos were missing from the media viewer."
            );
        }

        return r.map(
            e => e.image.uri
        );
    }

    // Read an existing listing and normalize it into the create-listing mutation shape.
    const buildRelistPayload = e =>
        listingReadQueue.run(
            async () => {
                const itemUrl =
                    `https://www.facebook.com/marketplace/item/${e}/`;

                let n =
                    findNestedValue(
                        await fetchMarketplacePageData(
                            itemUrl
                        ),
                        "marketplace_product_details_page"
                    );

                if (!n) {
                    try {
                        const pageData =
                            await readPageVariable(
                                "marketplace_product_details_page",
                                itemUrl,
                                {
                                    inline_json:
                                        true,
                                    required_property:
                                        "target",
                                    wait_ms:
                                        10000
                                }
                            );

                        if (pageData?.target)
                            n = pageData;
                    }
                    catch {
                    }
                }

                if (!n) {
                    logDiagnostic(
                        `Detail-page payload absent for listing ${e}`,
                        "read_listing",
                        "warning"
                    );

                    throw new Error(
                        "Listing details were missing from the response."
                    );
                }

                const editUrl =
                    `https://www.facebook.com/marketplace/edit/?listing_id=${e}`;

                const docId =
                    await readPageVariable(
                        "CometMarketplaceComposerRootComponentQuery_facebookRelayOperation",
                        editUrl
                    );

                const composerResponse =
                    await facebookGraphqlRequest(
                        MARKETPLACE_SELLING_URL,
                        docId,
                        "CometMarketplaceComposerRootComponentQuery",
                        {
                            listingId: e,
                            is_edit: true,
                            composer_mode:
                                "EDIT_LISTING",
                            scale: 1,
                            prefill_id: "0",
                            category_id: "0",
                            has_prefill_data:
                                false,
                            has_prefetched_category:
                                false,
                            delivery_types: [
                                "in_person"
                            ]
                        }
                    );

                const composerJson =
                    await composerResponse
                        .clone()
                        .json();

                const r =
                    composerJson?.data?.listing;

                if (!r) {
                    throw new Error(
                        `Composer payload was empty for listing ${e}`
                    );
                }

                const target = n.target;

                const category =
                    requireNonEmptyString(
                        firstNonNullish(
                            r
                                .marketplace_listing_virtual_taxonomy_category
                                ?.id,
                            r
                                .marketplace_listing_category_id,
                            target
                                .marketplace_listing_category_id
                        ),
                        "Listing category was missing."
                    );

                const description =
                    firstNonNullish(
                        r.redacted_description,
                        target.redacted_description
                    );

                if (!description) {
                    throw new Error(
                        "Listing description was missing."
                    );
                }

                const price =
                    requireNonEmptyString(
                        target
                            .listing_price
                            .amount
                            .replace(
                                /\.([0-9]*)/,
                                ""
                            ),
                        "Listing price was missing."
                    );

                const title =
                    requireNonEmptyString(
                        firstNonNullish(
                            r.marketplace_listing_title,
                            target.marketplace_listing_title
                        ),
                        "Listing title was missing."
                    );

                const videos =
                    firstNonNullish(
                        r.pre_recorded_videos,
                        target.pre_recorded_videos
                    );

                if (!videos) {
                    throw new Error(
                        "Listing videos were missing."
                    );
                }

                const videoIds =
                    videos.map(
                        ({ id }) => id
                    );

                const photos =
                    firstNonNullish(
                        r.listing_photos,
                        target.listing_photos
                    );

                if (!photos?.length) {
                    throw new Error(
                        "Listing photos were missing."
                    );
                }

                const photoIds =
                    photos.map(
                        ({ id }) => id
                    );

                const base = {
                    title,
                    description,
                    category_id: category,
                    price,
                    latitude:
                        requireNumber(
                            target.location.latitude,
                            "Listing latitude was missing."
                        ),
                    longitude:
                        requireNumber(
                            target.location.longitude,
                            "Listing longitude was missing."
                        ),
                    photo_ids: photoIds,
                    video_ids: videoIds
                };

                let listing;

                switch (n.__typename) {
                    case LISTING_PAGE_TYPES.RealEstate: {
                        const verticals =
                            requireNonEmptyString(
                                r.serialized_verticals_data,
                                "Listing verticals data was missing"
                            );

                        const data = {};

                        if (r.available_date != null) {
                            data.availableDate =
                                new Date(
                                    1000 *
                                    r.available_date
                                ).toISOString();
                        }

                        if (r.furnishing_type) {
                            data.furnishingType =
                                String(
                                    r.furnishing_type
                                ).toLowerCase();
                        }

                        if (r.parking_spaces != null) {
                            data.parkingSpaces =
                                String(
                                    r.parking_spaces
                                );
                        }

                        Object.assign(
                            data,
                            JSON.parse(verticals)
                        );

                        listing = {
                            category_id:
                                base.category_id,
                            description:
                                base.description,
                            item_price: {
                                price:
                                    base.price
                            },
                            serialized_verticals_data:
                                JSON.stringify(
                                    data
                                ),
                            title:
                                base.title,
                            video_ids:
                                base.video_ids,
                            xpost_target_ids: [],
                            photo_ids:
                                base.photo_ids
                        };

                        break;
                    }

                    case LISTING_PAGE_TYPES.Vehicle:
                        listing = {
                            category_id:
                                base.category_id,
                            description:
                                base.description,
                            item_price: {
                                price:
                                    base.price
                            },
                            latitude:
                                base.latitude,
                            longitude:
                                base.longitude,
                            title:
                                base.title,
                            serialized_verticals_data:
                                r.serialized_verticals_data,
                            video_ids:
                                base.video_ids,
                            xpost_target_ids: [],
                            photo_ids:
                                base.photo_ids
                        };
                        break;

                    case LISTING_PAGE_TYPES.Item:
                    default: {
                        const attributes =
                            firstNonNullish(
                                r.attribute_data,
                                target.attribute_data
                            ) ?? [];

                        const attributeData = {
                            vt_attributes_free_form:
                                {},
                            vt_attributes_normalized:
                                {}
                        };

                        for (const attribute of attributes) {
                            if (
                                attribute.attribute_type ===
                                    "DYNAMIC" &&
                                attribute.attribute_id &&
                                attribute.attribute_value_id
                            ) {
                                attributeData
                                    .vt_attributes_normalized[
                                    attribute.attribute_id
                                ] =
                                    attribute.attribute_value_id;
                            }
                            else {
                                attributeData[
                                    attribute
                                        .attribute_name
                                        .toLowerCase()
                                ] =
                                    attribute.value;
                            }
                        }

                        const currency =
                            requireNonEmptyString(
                                target
                                    .listing_price
                                    .currency,
                                "Listing currency was missing."
                            );

                        let hidden =
                            firstNonNullish(
                                r.hidden_from_friends,
                                target.hidden_from_friends
                            );

                        if (typeof hidden !== "string")
                            hidden = "HIDDEN_FROM_FRIENDS";

                        const hashtags =
                            firstNonNullish(
                                r.marketplace_hashtags,
                                target.marketplace_hashtags
                            );

                        if (!hashtags) {
                            throw new Error(
                                "Listing hashtags were missing."
                            );
                        }

                        const hashtagNames =
                            (
                                hashtags.edges ??
                                hashtags.nodes ??
                                []
                            ).map(
                                ({ tag_name }) =>
                                    tag_name
                            );

                        const primaryShippingOption =
                            getFixedCostShippingOption(
                                r
                            );

                        const fallbackShippingOption =
                            getFixedCostShippingOption(
                                target
                            );

                        const deliveryTypes =
                            arrayOrDefaultCopy(
                                findFirstMatchingProperty(
                                    [r, target],
                                    ["delivery_types"],
                                    isStringArray
                                ),
                                DEFAULT_SHIPPING_FIELDS.delivery_types
                            );

                        const shippingOffered =
                            deliveryTypes.some(
                                value =>
                                    value
                                        .toUpperCase()
                                        .startsWith(
                                            "SHIPPING_"
                                        )
                            ) ||
                            Boolean(
                                primaryShippingOption ??
                                fallbackShippingOption
                            );

                        listing = {
                            title:
                                base.title,
                            description:
                                base.description,
                            category_id:
                                base.category_id,
                            item_price: {
                                currency,
                                price:
                                    base.price
                            },
                            latitude:
                                base.latitude,
                            longitude:
                                base.longitude,
                            attribute_data_json:
                                JSON.stringify(
                                    attributeData
                                ),
                            hidden_from_friends_visibility:
                                hidden,
                            product_hashtag_names:
                                hashtagNames,
                            photo_ids:
                                base.photo_ids,
                            video_ids:
                                base.video_ids,
                            sku:
                                r.sku || "1",
                            ...DEFAULT_CREATE_LISTING_FIELDS,
                            ...DEFAULT_SHIPPING_FIELDS,
                            delivery_types:
                                deliveryTypes,
                            shipping_offered:
                                shippingOffered
                        };

                        break;
                    }
                }

                return {
                    listing,
                    marketplace_product_details:
                        n,
                    group_commerce_product_item:
                        r
                };
            }
        );

    const createMarketplaceListing = e =>
        listingCreateQueue.run(
            async () => {
                const t = {
                    input: {
                        client_mutation_id:
                            "-1",
                        actor_id:
                            marketplaceState.user_id,
                        audience: {
                            marketplace: {
                                marketplace_id:
                                    marketplaceState.marketplace_id
                            }
                        },
                        data: {
                            common: e
                        }
                    }
                };

                const n =
                    await facebookGraphqlRequest(
                        MARKETPLACE_CREATE_URL,
                        marketplaceState.create_listing_doc_id,
                        "useCometMarketplaceListingCreateMutation",
                        t
                    );

                const json =
                    await n.clone().json();

                if (json?.errors?.length) {
                    throw new Error(
                        "Facebook returned errors while creating the listing."
                    );
                }

                const id =
                    json?.data
                        ?.marketplace_listing_create
                        ?.listing?.id;

                if (!id) {
                    throw new Error(
                        "Facebook accepted the listing but did not return a listing ID."
                    );
                }

                return id;
            }
        );

    class RelistFailedError extends Error {
        listingID;
        originalError;

        constructor(e, t) {
            super(
                `Relisting failed for listing ${e}${
                    t instanceof Error
                        ? `: ${t.message}`
                        : ""
                }`
            );

            this.listingID = e;
            this.originalError = t;
            this.name = "RelistFailedError";
        }
    }

    // Preserve media, delete the source listing, and create its replacement.
    async function relistSingleListing(t) {
        if (!marketplaceState.marketplace_id) {
            throw new RelistFailedError(
                t,
                new Error(
                    "Marketplace creation context is unavailable. Reload Facebook before relisting."
                )
            );
        }

        try {
            setRelistStage(
                1,
                "Reading listing details..."
            );

            const s =
                await buildRelistPayload(t);

            const { listing: o } = s;

            if (!o || !o.title || !o.description) {
                throw new Error(
                    "Invalid listing data - missing essential fields"
                );
            }

            o.xpost_target_ids = [];

            setRelistStage(
                2,
                "Preparing listing media..."
            );

            const c =
                await readPageVariable(
                    "useCometMarketplaceListingCreateMutation_facebookRelayOperation",
                    MARKETPLACE_CREATE_URL
                );

            if (
                typeof c !== "string" ||
                !c
            ) {
                throw new Error(
                    "Facebook listing creation data is unavailable. Reload Facebook and try again."
                );
            }

            marketplaceState.create_listing_doc_id =
                c;

            let l = [];

            try {
                l =
                    await fetchListingPhotoUrls(
                        t
                    );
            }
            catch {
                logDiagnostic(
                    `Could not prefetch recovery photos for ${t}`,
                    "relist_recovery",
                    "warning"
                );
            }

            const u =
                firstNonNullish(
                    s
                        .group_commerce_product_item
                        .pre_recorded_videos,
                    s
                        .marketplace_product_details
                        .target
                        .pre_recorded_videos
                ) ?? [];

            if (u.length > 0) {
                setRelistProgress(
                    `Step 2 of ${RELIST_STEP_COUNT}: Preserving listing video...`
                );

                const n =
                    await readPageVariable(
                        "marketplace_composer_video_uploader_config",
                        MARKETPLACE_CREATE_URL,
                        {
                            inline_json: true,
                            wait_ms: 10000
                        }
                    );

                const r =
                    await readPageVariable(
                        "getAsyncParams",
                        MARKETPLACE_CREATE_URL,
                        {
                            call_args: [
                                "POST"
                            ]
                        }
                    );

                const i = r?.lsd;

                if (
                    typeof i !== "string" ||
                    !i
                ) {
                    throw new Error(
                        "Facebook video request data is unavailable. Reload Facebook and try again."
                    );
                }

                const preserveVideoFromUrl =
                    async sourceUrl => {
                        const begin =
                            await chrome.runtime.sendMessage({
                                kind:
                                    MESSAGE_TYPES.VIDEO_DOWNLOAD_BEGIN,
                                args: {
                                    sourceUrl
                                }
                            });

                        throwIfVideoDownloadFailed(
                            begin
                        );

                        if (
                            typeof begin?.sessionId !==
                                "string" ||
                            !begin.sessionId ||
                            !Number.isFinite(
                                begin.size
                            ) ||
                            Number(begin.size) <= 0
                        ) {
                            throw new VideoPreservationError(
                                "download",
                                "The extension worker could not cache the Facebook video."
                            );
                        }

                        const sessionId =
                            begin.sessionId;

                        try {
                            return await uploadVideo(
                                {
                                    sourceUrl,
                                    rawConfig: n,
                                    actorId:
                                        marketplaceState.user_id,
                                    fbDtsg:
                                        marketplaceState.fb_dtsg,
                                    lsd: i,
                                    transportParams:
                                        r
                                },
                                {
                                    size:
                                        Number(
                                            begin.size
                                        ),
                                    type:
                                        begin.type ||
                                        "video/mp4",

                                    slice:
                                        async (
                                            start,
                                            end
                                        ) => {
                                            const chunk =
                                                await chrome.runtime.sendMessage({
                                                    kind:
                                                        MESSAGE_TYPES.VIDEO_DOWNLOAD_CHUNK,
                                                    args: {
                                                        sessionId,
                                                        start,
                                                        end
                                                    }
                                                });

                                            throwIfVideoDownloadFailed(
                                                chunk
                                            );

                                            if (
                                                typeof chunk?.data !==
                                                "string"
                                            ) {
                                                throw new VideoPreservationError(
                                                    "download",
                                                    "The extension worker returned an invalid video chunk."
                                                );
                                            }

                                            const binary =
                                                atob(
                                                    chunk.data
                                                );

                                            const bytes =
                                                new Uint8Array(
                                                    binary.length
                                                );

                                            for (
                                                let index = 0;
                                                index <
                                                binary.length;
                                                index += 1
                                            ) {
                                                bytes[
                                                    index
                                                ] =
                                                    binary.charCodeAt(
                                                        index
                                                    );
                                            }

                                            const blob =
                                                new Blob(
                                                    [
                                                        bytes
                                                    ],
                                                    {
                                                        type:
                                                            "application/octet-stream"
                                                    }
                                                );

                                            if (
                                                blob.size !==
                                                end - start
                                            ) {
                                                throw new VideoPreservationError(
                                                    "download",
                                                    "The extension worker returned an incomplete video chunk."
                                                );
                                            }

                                            return blob;
                                        }
                                }
                            );
                        }
                        finally {
                            await chrome.runtime
                                .sendMessage({
                                    kind:
                                        MESSAGE_TYPES.VIDEO_DOWNLOAD_END,
                                    args: {
                                        sessionId
                                    }
                                })
                                .catch(
                                    () => {}
                                );
                        }
                    };

                try {
                    o.video_ids = [
                        await preserveVideoFromUrl(
                            getPreferredVideoUrl(
                                u
                            )
                        )
                    ];
                }
                catch (e) {
                    if (
                        !(
                            e instanceof
                                VideoPreservationError &&
                            e.stage ===
                                "download" &&
                            [
                                401,
                                403,
                                404
                            ].includes(
                                e.status ?? 0
                            )
                        )
                    ) {
                        throw e;
                    }

                    const n =
                        await buildRelistPayload(
                            t
                        );

                    const r =
                        firstNonNullish(
                            n
                                .group_commerce_product_item
                                .pre_recorded_videos,
                            n
                                .marketplace_product_details
                                .target
                                .pre_recorded_videos
                        ) ?? [];

                    o.video_ids = [
                        await preserveVideoFromUrl(
                            getPreferredVideoUrl(
                                r
                            )
                        )
                    ];
                }
            }

            let d;

            setRelistStage(
                3,
                "Removing the original listing..."
            );

            await listingDeleteQueue.run(
                async () => {
                    const variables = {
                        input: {
                            client_mutation_id:
                                "-1",
                            actor_id:
                                marketplaceState.user_id,
                            batch_delete_variants:
                                true,
                            for_sale_item_id:
                                t,
                            referral_surface:
                                "MARKETPLACE_INSIGHTS",
                            surface:
                                "MARKETPLACE_PAGE_SELLING"
                        }
                    };

                    const response =
                        await facebookGraphqlRequest(
                            MARKETPLACE_SELLING_URL,
                            marketplaceState.delete_listing_doc_id,
                            "useCometMarketplaceForSaleItemDeleteMutation",
                            variables
                        );

                    const result =
                        await response
                            ?.clone()
                            .json();

                    if (
                        result?.errors?.length
                    ) {
                        throw new Error(
                            "Facebook returned errors while deleting the listing."
                        );
                    }
                }
            );

            try {
                const recent =
                    (
                        await chrome.storage.local.get(
                            RECENTLY_RELISTED_KEY
                        )
                    )[
                        RECENTLY_RELISTED_KEY
                    ] || {};

                const now =
                    Date.now();

                recent[t] = now;

                for (
                    const id of Object.keys(
                        recent
                    )
                ) {
                    if (
                        now - recent[id] >
                        RECENT_RELIST_WINDOW_MS
                    ) {
                        delete recent[id];
                    }
                }

                await chrome.storage.local.set({
                    [RECENTLY_RELISTED_KEY]:
                        recent
                });
            }
            catch {
            }

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        3000 +
                        Math.floor(
                            3000 *
                            Math.random()
                        )
                    )
            );

            setRelistStage(
                4,
                "Creating the refreshed listing..."
            );

            try {
                d =
                    await createMarketplaceListing(
                        o
                    );
            }
            catch {
                setRelistProgress(
                    `Step 4 of ${RELIST_STEP_COUNT}: Re-uploading listing photos...`
                );

                o.photo_ids =
                    await reuploadListingPhotos(
                        t,
                        o.photo_ids,
                        l
                    );

                setRelistProgress(
                    `Step 4 of ${RELIST_STEP_COUNT}: Creating the refreshed listing...`
                );

                d =
                    await createMarketplaceListing(
                        o
                    );
            }

            if (
                typeof d !== "string" ||
                !d
            ) {
                throw new Error(
                    "Facebook did not return the replacement listing ID."
                );
            }

            setRelistStage(
                5,
                "Finishing refreshed listing..."
            );

            completeRelistStage();

            return {
                newListingId: d
            };
        }
        catch (e) {
            throw new RelistFailedError(
                t,
                e
            );
        }
    }

    async function reuploadListingPhotos(
        e,
        t,
        n
    ) {
        let r;

        if (n !== undefined) {
            r = n;
        }
        else {
            try {
                r =
                    await fetchListingPhotoUrls(
                        e
                    );
            }
            catch {
                logDiagnostic(
                    `Could not re-read photos for ${e}; reusing existing ids`,
                    "relist_recovery",
                    "warning"
                );

                return t;
            }
        }

        if (r.length === 0)
            return t;

        const results =
            await Promise.allSettled(
                r.map(
                    async e => {
                        const photoBlob =
                            await (
                                await fetch(e)
                            ).blob();

                        const form =
                            new FormData();

                        form.append(
                            "fb_dtsg",
                            marketplaceState.fb_dtsg
                        );

                        form.append(
                            "target_id",
                            marketplaceState.marketplace_id
                        );

                        form.append(
                            "source",
                            "8"
                        );

                        form.append(
                            "profile_id",
                            marketplaceState.user_id
                        );

                        form.append(
                            "farr",
                            photoBlob,
                            "blob"
                        );

                        const url =
                            `https://upload.facebook.com/ajax/react_composer/attachments/photo/upload?av=${marketplaceState.user_id}&__user=${marketplaceState.user_id}&__a=1&fb_dtsg=${marketplaceState.fb_dtsg}`;

                        const response =
                            await fetch(url, {
                                method:
                                    "POST",
                                headers: {
                                    accept:
                                        "*/*"
                                },
                                referrer:
                                    "https://www.facebook.com/",
                                referrerPolicy:
                                    "strict-origin-when-cross-origin",
                                body:
                                    form,
                                mode:
                                    "cors",
                                credentials:
                                    "include"
                            });

                        const text =
                            await response.text();

                        const json =
                            JSON.parse(
                                text.substring(9)
                            );

                        const photoID =
                            json?.payload?.photoID;

                        if (!photoID) {
                            throw new Error(
                                "Photo upload succeeded but returned no photoID"
                            );
                        }

                        return photoID;
                    }
                )
            );

        const ids =
            results
                .filter(
                    e =>
                        e.status ===
                        "fulfilled"
                )
                .map(
                    e => e.value
                );

        return ids.length > 0
            ? ids
            : t;
    }

    // ---------------------------------------------------------------------------
    // Cached GraphQL document IDs
    // ---------------------------------------------------------------------------

    const GRAPHQL_DOC_ID_CACHE_KEY =
        "FB_DOC_ID_CACHE";

    class GraphqlDocIdCache {
        static async get() {
            try {
                const e =
                    (
                        await chrome.storage.local.get(
                            GRAPHQL_DOC_ID_CACHE_KEY
                        )
                    )[
                        GRAPHQL_DOC_ID_CACHE_KEY
                    ];

                if (!e)
                    return null;

                if (Date.now() > e.expiry) {
                    await this.clear();
                    return null;
                }

                return e.docIds;
            }
            catch {
                return null;
            }
        }

        static async set(e) {
            try {
                const t = {
                    docIds: {
                        ...e,
                        timestamp:
                            Date.now()
                    },
                    expiry:
                        Date.now() +
                        864e5
                };

                await chrome.storage.local.set({
                    [GRAPHQL_DOC_ID_CACHE_KEY]:
                        t
                });
            }
            catch {
            }
        }

        static async clear() {
            try {
                await chrome.storage.local.remove(
                    GRAPHQL_DOC_ID_CACHE_KEY
                );
            }
            catch {
            }
        }
    }

    // ---------------------------------------------------------------------------
    // Marketplace page lifecycle and selection-panel UI
    // ---------------------------------------------------------------------------

    const LISTING_PICK_BUTTON_CLASS =
        "mrf-pick-btn";

    const SELLING_PATHS = new Set([
        "/marketplace/you/selling",
        "/marketplace/seller/listings"
    ]);

    function findListingCardContainer(element) {
        return (
            element.closest(
                '[aria-label][role="button"]'
            )?.parentElement ?? null
        );
    }

    const sleep = milliseconds =>
        new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    milliseconds
                )
        );

    let staleDaysThreshold = 30;
    let panelInitialized = false;

    const HAS_RELISTED_KEY =
        "mrf_has_relisted";

    const SHOW_CELEBRATION_KEY =
        "mrf_show_celebration";

    const RELIST_BUTTON_ID =
        "mrf-relist-btn";

    const PANEL_ID =
        "mrf-select-btn";

    let listingObserver;
    let scanScheduled = false;
    let selectedListingIds = [];

    async function restoreCachedListings() {
        try {
            const value =
                (
                    await chrome.storage.local.get(
                        LISTING_CACHE_KEY
                    )
                )[
                    LISTING_CACHE_KEY
                ];

            if (
                !value ||
                !Array.isArray(
                    value.listings
                ) ||
                value.listings.length === 0 ||
                Date.now() -
                    (value.ts || 0) >
                    864e5
            ) {
                return false;
            }

            const recentlyRelistedIds =
                await getRecentlyRelistedIds();

            const listings =
                recentlyRelistedIds.size
                    ? value.listings.filter(
                        listing =>
                            !recentlyRelistedIds.has(
                                listing.id
                            )
                    )
                    : value.listings;

            marketplaceState.active_listings =
                listings;

            marketplaceState.active_listings_id_map =
                Object.fromEntries(
                    listings.map(
                        listing => [
                            listing.id,
                            true
                        ]
                    )
                );

            marketplaceState.sync_done =
                true;

            return true;
        }
        catch {
            return false;
        }
    }

    let progressContainer = null;
    let currentRelistIndex = 0;
    let currentRelistTotal = 0;

    const RELIST_STEP_COUNT = 5;

    function getBackgroundLuminance(color) {
        const values =
            String(color)
                .match(/[\d.]+/g)
                ?.map(Number);

        if (
            !values ||
            values.length < 3 ||
            (
                values.length > 3 &&
                values[3] === 0
            )
        ) {
            return null;
        }

        const [
            red,
            green,
            blue
        ] = values;

        return (
            .2126 * red +
            .7152 * green +
            .0722 * blue
        );
    }

    function facebookUsesDarkTheme() {
        const root =
            document.documentElement;

        const body =
            document.body;

        if (
            root?.classList.contains(
                "__fb-dark-mode"
            ) ||
            body?.classList.contains(
                "__fb-dark-mode"
            )
        ) {
            return true;
        }

        if (
            root?.classList.contains(
                "__fb-light-mode"
            ) ||
            body?.classList.contains(
                "__fb-light-mode"
            )
        ) {
            return false;
        }

        const candidates = [
            document.querySelector(
                '[role="main"]'
            ),
            body,
            root
        ];

        for (const candidate of candidates) {
            if (!candidate)
                continue;

            const luminance =
                getBackgroundLuminance(
                    getComputedStyle(
                        candidate
                    ).backgroundColor
                );

            if (luminance !== null)
                return luminance < 128;
        }

        return window
            .matchMedia(
                "(prefers-color-scheme: dark)"
            )
            .matches;
    }

    function syncMarketplaceTheme() {
        document.documentElement
            .dataset.mrfTheme =
            facebookUsesDarkTheme()
                ? "dark"
                : "light";
    }

    function positionProgressAbovePanel() {
        if (!progressContainer)
            return;

        const panel =
            document.getElementById(
                PANEL_ID
            );

        if (!panel)
            return;

        const rect =
            panel.getBoundingClientRect();

        progressContainer.style.left =
            `${Math.round(
                rect.left
            )}px`;

        progressContainer.style.right =
            "auto";

        progressContainer.style.width =
            `${Math.round(
                rect.width
            )}px`;

        progressContainer.style.bottom =
            `${Math.max(
                5,
                Math.round(
                    window.innerHeight -
                    rect.top +
                    8
                )
            )}px`;
    }

    function setRelistProgress(message) {
        if (!progressContainer)
            return;

        const status =
            progressContainer.querySelector(
                "#mrf-progress-status"
            );

        if (!status)
            return;

        const prefix =
            currentRelistTotal > 1 &&
            currentRelistIndex > 0
                ? `Listing ${currentRelistIndex} of ${currentRelistTotal} · `
                : "";

        status.textContent =
            prefix + message;
    }

    function setRelistStage(step, message) {
        const safeStep = Math.max(
            1,
            Math.min(RELIST_STEP_COUNT, step)
        );

        setRelistProgress(
            `Step ${safeStep} of ${RELIST_STEP_COUNT}: ${message}`
        );

        if (
            currentRelistTotal <= 0 ||
            currentRelistIndex <= 0
        ) {
            updateProgressBar(
                0,
                1,
                "0%"
            );
            return;
        }

        const completedListings =
            currentRelistIndex - 1;

        const completedSteps =
            safeStep - 1;

        const overallProgress =
            (
                completedListings +
                completedSteps / RELIST_STEP_COUNT
            ) / currentRelistTotal;

        updateProgressBar(
            overallProgress,
            1,
            `${Math.round(overallProgress * 100)}% · Listing ${currentRelistIndex} of ${currentRelistTotal}`
        );
    }

    function completeRelistStage() {
        if (
            currentRelistTotal <= 0 ||
            currentRelistIndex <= 0
        ) {
            return;
        }

        const overallProgress =
            currentRelistIndex /
            currentRelistTotal;

        setRelistProgress(
            `Step ${RELIST_STEP_COUNT} of ${RELIST_STEP_COUNT}: Refreshed listing created.`
        );

        updateProgressBar(
            overallProgress,
            1,
            `${Math.round(overallProgress * 100)}% · Listing ${currentRelistIndex} of ${currentRelistTotal}`
        );
    }

    function showRelistOverlay() {
        document
            .getElementById(
                "mrf-relist-overlay"
            )
            ?.remove();

        const overlay =
            document.createElement(
                "div"
            );

        overlay.id =
            "mrf-relist-overlay";

        Object.assign(
            overlay.style,
            {
                position: "fixed",
                inset: "0",
                zIndex: "2147483645",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
                background: "rgba(0, 0, 0, 0.18)",
                opacity: "0",
                transition: "opacity 0.2s ease"
            }
        );

        const card =
            document.createElement(
                "div"
            );

        Object.assign(
            card.style,
            {
                minWidth: "260px",
                maxWidth: "calc(100vw - 32px)",
                padding: "18px 22px",
                border: "1px solid var(--mrf-border)",
                borderRadius: "12px",
                background: "var(--mrf-surface)",
                color: "var(--mrf-text)",
                boxShadow: "var(--mrf-shadow-panel)",
                fontFamily: "var(--mrf-font)",
                textAlign: "center"
            }
        );

        const title =
            document.createElement(
                "div"
            );

        title.textContent =
            "RE:new";

        Object.assign(
            title.style,
            {
                fontSize: "18px",
                fontWeight: "700",
                lineHeight: "1.2"
            }
        );

        const subtitle =
            document.createElement(
                "div"
            );

        subtitle.textContent =
            "Relisting selected listings";

        Object.assign(
            subtitle.style,
            {
                marginTop: "5px",
                color: "var(--mrf-text-secondary)",
                fontSize: "13px",
                fontWeight: "600",
                lineHeight: "1.4"
            }
        );

        card.append(
            title,
            subtitle
        );

        overlay.appendChild(
            card
        );

        document.body.appendChild(
            overlay
        );

        requestAnimationFrame(
            () => {
                overlay.style.opacity =
                    "1";
            }
        );
    }

    function hideRelistOverlay() {
        const overlay =
            document.getElementById(
                "mrf-relist-overlay"
            );

        if (!overlay)
            return;

        overlay.style.opacity =
            "0";

        setTimeout(
            () => {
                overlay.remove();
            },
            200
        );
    }

    const pageContext = {
        isSellingPage() {
            const path =
                location.pathname.length > 1
                    ? location.pathname.replace(
                        /\/+$/,
                        ""
                    )
                    : location.pathname;

            return SELLING_PATHS.has(
                path
            );
        },

        validateCurrentPage(context) {
            if (this.isSellingPage())
                return true;

            logDiagnostic(
                `Extension loaded but user navigated away from selling page (${context})`,
                "navigation_validation",
                "info"
            );

            return false;
        }
    };

    let contentInitialized = false;
    let wasSellingPage = false;

    const startedOnSellingPage =
        pageContext.isSellingPage();

    async function requestListingScan() {
        try {
            await chrome.runtime.sendMessage({
                kind:
                    MESSAGE_TYPES.REQUEST_SCAN,
                args:
                    undefined
            });
        }
        catch {
        }
    }

    function syncPageLifecycle() {
        syncMarketplaceTheme();

        const t =
            pageContext.isSellingPage();

        if (t === wasSellingPage)
            return;

        wasSellingPage = t;

        if (!t) {
            listingObserver?.disconnect();
            removeMarketplaceUi();
            return;
        }

        if (contentInitialized) {
            void requestListingScan();
            return;
        }

        contentInitialized = true;

        void (async function (
            requestScanAfterInit = false
        ) {
            marketplaceState.active_listings =
                [];

            marketplaceState.active_listings_id_map =
                {};

            document
                .querySelectorAll(
                    'link[data-REnew-css]'
                )
                .forEach(
                    link => link.remove()
                );

            const stylesheet =
                document.createElement(
                    "link"
                );

            stylesheet.rel =
                "stylesheet";

            stylesheet.type =
                "text/css";

            stylesheet.dataset.REnewCss =
                "true";

            stylesheet.href =
                chrome.runtime.getURL(
                    "assets/overlay.css"
                ) +
                `?v=${
                    chrome.runtime
                        .getManifest()
                        .version
                }`;

            (
                document.head ||
                document.documentElement
            ).appendChild(
                stylesheet
            );

            const ensureOverlay = () => {
                if (
                    document.getElementById(
                        "mrf-overlay"
                    )
                ) {
                    return;
                }

                const e =
                    document.createElement(
                        "div"
                    );

                e.id =
                    "mrf-overlay";

                e.setAttribute(
                    "aria-hidden",
                    "true"
                );

                const t =
                    document.createElement(
                        "div"
                    );

                t.className =
                    "mrf-overlay-card";

                const n =
                    document.createElement(
                        "span"
                    );

                n.className =
                    "mrf-spinner";

                n.setAttribute(
                    "role",
                    "status"
                );

                n.setAttribute(
                    "aria-label",
                    "Working"
                );

                const r =
                    document.createElement(
                        "p"
                    );

                r.className =
                    "mrf-overlay-text";

                r.textContent =
                    "RE:new is working…";

                t.append(
                    n,
                    r
                );

                e.appendChild(t);

                (
                    document.body ||
                    document.documentElement
                ).appendChild(e);
            };

            if (document.body) {
                ensureOverlay();
            }
            else {
                document.addEventListener(
                    "DOMContentLoaded",
                    ensureOverlay,
                    {
                        once: true
                    }
                );
            }

            if (isSellingPage()) {
                setTimeout(
                    async () => {
                        try {
                            if (
                                document.getElementById(
                                    RELIST_BUTTON_ID
                                )
                            ) {
                                return;
                            }

                            const restored =
                                await restoreCachedListings();

                            await retryAsync(
                                attachListingSelectionControls,
                                {
                                    everyMs:
                                        1000,
                                    untilMs:
                                        5000
                                }
                            ).catch(
                                () => null
                            );

                            await retryAsync(
                                ensureControlPanel,
                                {
                                    everyMs:
                                        1000,
                                    untilMs:
                                        5000
                                }
                            ).catch(
                                () => null
                            );

                            updateExtensionBadge();

                            await hasRelistedBefore();

                            retryAsync(
                                () =>
                                    refreshMarketplaceState({
                                        revalidate:
                                            restored
                                    }),
                                {
                                    everyMs:
                                        1000,
                                    untilMs:
                                        5000
                                }
                            ).catch(
                                () => {}
                            );
                        }
                        catch {
                        }
                    },
                    3000
                );
            }

            chrome.runtime.onMessage.addListener(
                async t => {
                    try {
                        if (
                            t.type ===
                            "AI_PROGRESS_UPDATE"
                        ) {
                            return;
                        }

                        if (
                            t.kind !==
                            MESSAGE_TYPES.SCAN_LISTINGS
                        ) {
                            return;
                        }

                        listingObserver?.disconnect();

                        selectedListingIds =
                            [];

                        removeMarketplaceUi();

                        const restored =
                            await restoreCachedListings();

                        retryAsync(
                            attachListingSelectionControls,
                            {
                                everyMs:
                                    1000,
                                untilMs:
                                    5000
                            }
                        ).catch(
                            () => null
                        );

                        await retryAsync(
                            ensureControlPanel,
                            {
                                everyMs:
                                    1000,
                                untilMs:
                                    5000
                            }
                        );

                        updateExtensionBadge();

                        if (
                            await hasRelistedBefore()
                        ) {
                            try {
                                if (
                                    (
                                        await chrome.storage.local.get(
                                            SHOW_CELEBRATION_KEY
                                        )
                                    )[
                                        SHOW_CELEBRATION_KEY
                                    ]
                                ) {
                                    await chrome.storage.local.remove(
                                        SHOW_CELEBRATION_KEY
                                    );

                                    const e =
                                        document.createElement(
                                            "div"
                                        );

                                    e.id =
                                        "mrf-celebration";

                                    e.innerHTML =
                                        `
    <div class="mrf-toast-card">
      <div class="mrf-toast-icon">&#10003;</div>
      <div>
        <div class="mrf-toast-title">Your listing is back on top!</div>
        <div class="mrf-toast-text">Come back whenever your listings get stale. We'll show you how many need a refresh.</div>
      </div>
    </div>
  `;

                                    document.body.appendChild(
                                        e
                                    );

                                    setTimeout(
                                        () =>
                                            e.remove(),
                                        8000
                                    );
                                }
                            }
                            catch {
                            }
                        }

                        listingObserver =
                            new MutationObserver(
                                () => {
                                    if (
                                        !pageContext.isSellingPage()
                                    ) {
                                        listingObserver?.disconnect();
                                        removeMarketplaceUi();
                                        return;
                                    }

                                    if (
                                        scanScheduled
                                    ) {
                                        return;
                                    }

                                    scanScheduled =
                                        true;

                                    setTimeout(
                                        () => {
                                            scanScheduled =
                                                false;

                                            attachListingSelectionControls()
                                                .catch(
                                                    () => {}
                                                );
                                        },
                                        250
                                    );
                                }
                            );

                        listingObserver.observe(
                            document.body,
                            {
                                childList:
                                    true,
                                subtree:
                                    true,
                                attributes:
                                    false,
                                characterData:
                                    false
                            }
                        );

                        try {
                            await retryAsync(
                                () =>
                                    refreshMarketplaceState({
                                        revalidate:
                                            restored
                                    }),
                                {
                                    everyMs:
                                        1000,
                                    untilMs:
                                        5000
                                }
                            );
                        }
                        catch {
                            marketplaceState.sync_done =
                                true;

                            try {
                                refreshSelectionUi();
                            }
                            catch {
                            }
                        }

                        if (
                            !pageContext.validateCurrentPage(
                                "post_initialization"
                            )
                        ) {
                            removeMarketplaceUi();
                            listingObserver?.disconnect();
                        }
                    }
                    catch (e) {
                        if (
                            pageContext.isSellingPage()
                        ) {
                            reportError(e, {
                                context:
                                    "main_function_execution"
                            });
                        }
                    }
                }
            );

            if (
                requestScanAfterInit &&
                pageContext.isSellingPage()
            ) {
                await requestListingScan();
            }
        })(
            !startedOnSellingPage
        );
    }

    async function handleRelistSelected(e) {
        e.preventDefault();

        if (
            selectedListingIds.length ===
            0
        ) {
            return;
        }

        if (
            selectedListingIds.length > 20
        ) {
            const decision =
                await showDialog(
                    "⚠️ Relisting a large batch",
                    `
          <div style="text-align: center; margin: 16px 0;">
            <div style="font-size: 15px; color: #333; margin-bottom: 12px;">
              You're about to relist <b>${selectedListingIds.length}</b> listings at once.
            </div>
            <div style="font-size: 14px; color: #666;">
              Relisting many items in quick succession can trigger Facebook's
              activity checks. For safety, consider relisting in smaller batches
              over a few days.
            </div>
          </div>
          `,
                    [
                        {
                            text:
                                "Cancel",
                            value:
                                "cancel",
                            className:
                                "dialog-btn-secondary"
                        },
                        {
                            text:
                                `Relist ${selectedListingIds.length} anyway`,
                            value:
                                "proceed",
                            className:
                                "dialog-btn-primary"
                        }
                    ]
                );

            if (
                decision !==
                "proceed"
            ) {
                return;
            }
        }

        const relistButton =
            document.getElementById(
                RELIST_BUTTON_ID
            );

        if (
            relistButton instanceof
            HTMLButtonElement
        ) {
            relistButton.disabled =
                true;
        }

        const panel =
            document.getElementById(
                PANEL_ID
            );

        if (panel) {
            Array.from(
                panel.getElementsByTagName(
                    "button"
                )
            ).forEach(
                button => {
                    button.disabled =
                        true;
                }
            );
        }

        showRelistOverlay();

        progressContainer =
            document.createElement(
                "div"
            );

        progressContainer.id =
            "ai-progress-container";

        const status =
            document.createElement(
                "div"
            );

        status.id =
            "mrf-progress-status";

        status.setAttribute(
            "role",
            "status"
        );

        status.setAttribute(
            "aria-live",
            "polite"
        );

        const progressBar =
            document.createElement(
                "div"
            );

        progressBar.id =
            "ai-progress-bar-container";

        progressBar.innerHTML =
            `
    <div
        id="ai-progress-bar"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow="0"
    ></div>
    <div id="ai-progress-text">0%</div>
  `;

        Object.assign(
            progressBar.style,
            {
                position: "relative",
                height: "8px",
                marginTop: "10px",
                overflow: "visible",
                borderRadius: "999px",
                background: "var(--mrf-facebook-gray-hover)"
            }
        );

        const progressFill =
            progressBar.querySelector(
                "#ai-progress-bar"
            );

        if (progressFill instanceof HTMLElement) {
            Object.assign(
                progressFill.style,
                {
                    width: "0%",
                    height: "8px",
                    borderRadius: "inherit",
                    background: "var(--mrf-blue)",
                    transition: "width 0.3s ease-out"
                }
            );
        }

        progressContainer.appendChild(
            status
        );

        progressContainer.appendChild(
            progressBar
        );

        document.body.appendChild(
            progressContainer
        );

        currentRelistIndex = 0;
        currentRelistTotal =
            selectedListingIds.length;

        updateProgressBar(
            0,
            1,
            `0% · ${currentRelistTotal} listing${currentRelistTotal === 1 ? "" : "s"} selected`
        );

        setRelistProgress(
            "Preparing selected listings..."
        );

        syncMarketplaceTheme();
        positionProgressAbovePanel();

        window.addEventListener(
            "resize",
            positionProgressAbovePanel
        );

        setTimeout(
            () => {
                progressContainer
                    ?.classList.add(
                        "show"
                    );
            },
            50
        );

        const results = [];

        let createDocId;
        let deleteDocId;
        let listingDocId;

        const cached =
            await GraphqlDocIdCache.get();

        if (cached) {
            createDocId =
                cached.create_listing_doc_id;

            deleteDocId =
                cached.delete_listing_doc_id;

            listingDocId =
                cached.listing_doc_id;

            logDiagnostic(
                "Using cached doc_ids",
                "doc_id_cache",
                "info"
            );
        }
        else {
            logDiagnostic(
                "Doc_id cache miss - extracting fresh",
                "doc_id_cache",
                "info"
            );

            const [
                createResult,
                deleteResult,
                listingResult
            ] =
                await Promise.allSettled([
                    readPageVariable(
                        "useCometMarketplaceListingCreateMutation_facebookRelayOperation",
                        "https://www.facebook.com/marketplace/create/item"
                    ),
                    readPageVariable(
                        "useCometMarketplaceForSaleItemDeleteMutation_facebookRelayOperation",
                        "https://www.facebook.com/marketplace/you/selling"
                    ),
                    readPageVariable(
                        "MarketplacePDPC2CMediaViewerWithImagesQuery_facebookRelayOperation",
                        "https://www.facebook.com/marketplace/"
                    )
                ]);

            const mappings = [
                {
                    result:
                        createResult,
                    name:
                        "create"
                },
                {
                    result:
                        deleteResult,
                    name:
                        "delete"
                },
                {
                    result:
                        listingResult,
                    name:
                        "listing"
                }
            ];

            const resolved = {};

            for (const {
                result,
                name
            } of mappings) {
                if (
                    result.status !==
                        "fulfilled" ||
                    typeof result.value !==
                        "string" ||
                    !result.value
                ) {
                    logDiagnostic(
                        `Could not resolve the ${name} doc_id; reloading`,
                        "doc_id",
                        "error"
                    );

                    window.location.reload();
                    return;
                }

                resolved[name] =
                    result.value;
            }

            createDocId =
                resolved.create;

            deleteDocId =
                resolved.delete;

            listingDocId =
                resolved.listing;

            await GraphqlDocIdCache.set({
                create_listing_doc_id:
                    createDocId,
                delete_listing_doc_id:
                    deleteDocId,
                listing_doc_id:
                    listingDocId
            });

            logDiagnostic(
                "Cached fresh doc_ids (24 hour expiry)",
                "doc_id_cache",
                "info"
            );
        }

        marketplaceState.create_listing_doc_id =
            createDocId;

        marketplaceState.delete_listing_doc_id =
            deleteDocId;

        marketplaceState.listing_doc_id =
            listingDocId;

        let stopped = false;

        for (
            let index = 0;
            index <
            selectedListingIds.length;
            index += 1
        ) {
            const listingId =
                selectedListingIds[
                    index
                ];

            currentRelistIndex =
                index + 1;

            currentRelistTotal =
                selectedListingIds.length;

            setRelistStage(
                1,
                "Reading listing details..."
            );

            try {
                const result =
                    await relistSingleListing(
                        listingId
                    );

                logDiagnostic(
                    `Successfully processed listing: ${listingId}`,
                    "relist_operation",
                    "info"
                );

                results.push({
                    status:
                        "fulfilled",
                    value:
                        result
                });

                await sleep(
                    1000 +
                    Math.floor(
                        2000 *
                        Math.random()
                    )
                );
            }
            catch (e) {
                logDiagnostic(
                    `Failed to process listing: ${listingId}`,
                    "relist_operation",
                    "error"
                );

                reportError(e, {
                    context:
                        "relist_operation",
                    listing_id:
                        listingId
                });

                results.push({
                    status:
                        "rejected",
                    reason:
                        e
                });

                if (
                    e instanceof
                    RelistFailedError
                ) {
                    stopped = true;
                    break;
                }
            }
        }

        const successful =
            results.filter(
                e =>
                    e.status ===
                    "fulfilled"
            );

        window.removeEventListener(
            "resize",
            positionProgressAbovePanel
        );

        hideRelistOverlay();

        if (progressContainer) {
            const container =
                progressContainer;

            container.classList.remove(
                "show"
            );

            setTimeout(
                () => {
                    container.remove();

                    if (
                        progressContainer ===
                        container
                    ) {
                        progressContainer =
                            null;
                    }
                },
                400
            );
        }

        currentRelistIndex = 0;
        currentRelistTotal = 0;

        if (
            successful.length > 0
        ) {
            await chrome.storage.local.set({
                [HAS_RELISTED_KEY]:
                    true,
                [SHOW_CELEBRATION_KEY]:
                    true
            });
        }

        if (stopped) {
            await showDialog(
                "⚠️ Relisting Stopped to Protect Your Listings",
                `
            <div style="text-align: center; margin: 20px 0;">
              <div style="font-size: 16px; color: #333; margin-bottom: 12px;">
                Facebook couldn't finish recreating this listing, so we stopped here.
              </div>
              <div style="font-size: 14px; color: #666;">
                No other listings were touched. Check this item in Marketplace,
                then refresh Facebook and try again shortly.
              </div>
            </div>
                `,
                [
                    {
                        text:
                            "OK",
                        value:
                            "ok",
                        className:
                            "dialog-btn-primary"
                    }
                ]
            );
        }

        window.location.reload();
    }

    function ensureControlPanel() {
        if (
            !pageContext.validateCurrentPage(
                "overlay_relist_button"
            )
        ) {
            return;
        }

        selectedListingIds = [];

        let panel =
            document.getElementById(
                PANEL_ID
            );

        if (!panel) {
            panel =
                document.createElement(
                    "div"
                );

            panel.id =
                PANEL_ID;

            document.body.appendChild(
                panel
            );
        }

        panel.style.display =
            "flex";

        panelInitialized =
            false;

        renderControlPanel();
        refreshSelectionUi();
    }

    function getListingAgeDays(listing) {
        const creationTime =
            Number(
                listing?.creation_time
            );

        if (
            !Number.isFinite(
                creationTime
            ) ||
            creationTime <= 0
        ) {
            return null;
        }

        const seconds =
            creationTime > 1e12
                ? creationTime / 1000
                : creationTime;

        const age =
            Math.floor(
                (
                    Date.now() / 1000 -
                    seconds
                ) /
                86400
            );

        return age < 0
            ? 0
            : age;
    }

    function getStaleListingIds(e) {
        return marketplaceState
            .active_listings
            .filter(
                t => {
                    const n =
                        getListingAgeDays(
                            t
                        );

                    return (
                        n !== null &&
                        n >= e
                    );
                }
            )
            .slice()
            .sort(
                (e, t) =>
                    (e.creation_time || 0) -
                    (t.creation_time || 0)
            )
            .map(
                e => e.id
            );
    }

    function normalizeStaleDays(value) {
        const parsed =
            Number.parseInt(
                String(value),
                10
            );

        if (!Number.isFinite(parsed))
            return staleDaysThreshold;

        return Math.max(
            1,
            Math.min(
                365,
                parsed
            )
        );
    }

    function updateStaleControls() {
        const e =
            document.getElementById(
                "mrf-stale-days"
            );

        if (
            e instanceof
            HTMLInputElement
        ) {
            e.value =
                String(
                    staleDaysThreshold
                );
        }
        else if (e) {
            e.textContent =
                `${staleDaysThreshold}`;
        }

        const t =
            document.getElementById(
                "mrf-stale-count"
            );

        if (t) {
            t.textContent =
                `${
                    getStaleListingIds(
                        staleDaysThreshold
                    ).length
                }`;
        }
    }

    function setStaleDays(value) {
        staleDaysThreshold =
            normalizeStaleDays(
                value
            );

        updateStaleControls();
        updateExtensionBadge();
    }

    function adjustStaleDays(e) {
        setStaleDays(
            staleDaysThreshold + e
        );
    }

    function updateExtensionBadge() {
        const t =
            getStaleListingIds(
                staleDaysThreshold
            ).length;

        chrome.runtime
            .sendMessage({
                kind:
                    MESSAGE_TYPES.UPDATE_BADGE,
                args: {
                    staleCount:
                        t
                }
            })
            .catch(
                () => {}
            );
    }

    async function hasRelistedBefore() {
        try {
            return Boolean(
                (
                    await chrome.storage.local.get(
                        HAS_RELISTED_KEY
                    )
                )[
                    HAS_RELISTED_KEY
                ]
            );
        }
        catch {
            return true;
        }
    }

    function setSelectedListings(e) {
        const setListingButtonSelected =
            (id, selected) => {
                const button =
                    document.getElementById(
                        id
                    );

                if (!button)
                    return;

                button.classList.toggle(
                    "selected",
                    selected
                );

                button.innerHTML =
                    selected
                        ? "✓"
                        : "";

                button.setAttribute(
                    "aria-pressed",
                    String(selected)
                );

                button.setAttribute(
                    "aria-label",
                    selected
                        ? "Deselect listing"
                        : "Select listing"
                );
            };

        selectedListingIds.forEach(
            e =>
                setListingButtonSelected(
                    e,
                    false
                )
        );

        selectedListingIds =
            e.slice();

        selectedListingIds.forEach(
            e =>
                setListingButtonSelected(
                    e,
                    true
                )
        );

        refreshSelectionUi();
    }

    const handleListingsUpdated = () => {
        retryAsync(
            async () => {
                await attachListingSelectionControls();
                refreshSelectionUi();
                updateExtensionBadge();
            },
            {
                everyMs: 500,
                maxTries: 3
            }
        ).catch(
            () => {}
        );
    };

    document.addEventListener(
        "RE:new:listings-updated",
        handleListingsUpdated
    );

    syncPageLifecycle();

    window.setInterval(
        syncPageLifecycle,
        500
    );

    const EXTENSION_VERSION =
        chrome.runtime
            .getManifest()
            .version;

    const BRAND_GLYPH_HTML =
        `<img class="mrf-brand-glyph" src="${chrome.runtime.getURL(
            "assets/brand-glyph.png"
        )}" width="20" height="20" alt="">`;

    function renderPanelHeader() {
        return `
    <div class="mrf-panel-head">
      <div class="mrf-brand-wrap">
        <span class="mrf-brand-mark">${BRAND_GLYPH_HTML}</span>
        <span class="mrf-brand-name">RE:new</span>
      </div>
      <span class="mrf-version" title="Extension version">v${EXTENSION_VERSION}</span>
    </div>`;
    }

    function updateSelectionBar() {
        const bar =
            document.getElementById(
                "mrf-selbar"
            );

        if (!bar)
            return;

        const count =
            selectedListingIds.length;

        bar.style.display =
            count > 0
                ? "flex"
                : "none";

        const label =
            document.getElementById(
                "mrf-sel-count"
            );

        if (label) {
            label.textContent =
                String(count);
        }
    }

    function renderControlPanel() {
        const panel =
            document.getElementById(
                PANEL_ID
            );

        if (!panel)
            return;

        const totalListings =
            marketplaceState
                .active_listings
                .length;

        if (
            !marketplaceState.sync_done
        ) {
            panelInitialized =
                false;

            panel.className =
                "mrf-panel";

            panel.innerHTML =
                renderPanelHeader() +
                `
<div class="mrf-panel-body" id="mrf-panel-relist">
    <span class="mrf-pick-loading">
        Loading your listings… (${totalListings})
    </span>
</div>`;

            return;
        }

        if (totalListings === 0) {
            panelInitialized =
                false;

            panel.className =
                "mrf-panel";

            panel.innerHTML =
                renderPanelHeader() +
                `
<div class="mrf-panel-body" id="mrf-panel-relist">
    <span class="mrf-pick-loading">
        No active listings found. Create a listing on Marketplace and come back — RE:new will be ready.
    </span>
</div>`;

            return;
        }

        if (!panelInitialized) {
            panelInitialized =
                true;

            panel.className =
                "mrf-panel";

            const staleSection =
                marketplaceState
                    .active_listings
                    .some(
                        listing =>
                            getListingAgeDays(
                                listing
                            ) !== null
                    )
                    ? `
<div class="mrf-stale-picker">
    <div class="mrf-stale-title">
        SELECT LISTINGS OLDER THAN
    </div>

    <div class="mrf-stale-grid">
        <div
            class="mrf-stepper"
            aria-label="Listing age threshold in days"
        >
            <button
                class="mrf-step"
                id="mrf-stale-dec"
                type="button"
                aria-label="Decrease listing age threshold"
            >−</button>

            <span
                class="mrf-pick-n mrf-pick-days"
                id="mrf-stale-days"
                title="Days"
            >${staleDaysThreshold}</span>

            <button
                class="mrf-step"
                id="mrf-stale-inc"
                type="button"
                aria-label="Increase listing age threshold"
            >+</button>
        </div>

        <button
            class="mrf-chip mrf-stale-select"
            id="mrf-stale-btn"
            type="button"
        >
            Select
            <span
                class="mrf-count-badge"
                id="mrf-stale-count"
            >${getStaleListingIds(staleDaysThreshold).length}</span>
        </button>
    </div>
</div>`
                    : "";

            panel.innerHTML =
                renderPanelHeader() +
                `
<div class="mrf-panel-body" id="mrf-panel-relist">

    <div
        class="mrf-selbar"
        id="mrf-selbar"
        style="display:none"
    >
        <span>
            <b id="mrf-sel-count">0</b>
            selected
        </span>
    </div>

    <div class="mrf-section">
        <div class="mrf-section-title">
            Selection
        </div>

        <div class="mrf-selection-actions">
            <button
                class="mrf-chip"
                id="mrf-select-all"
                type="button"
            >
                Select all
            </button>

            <button
                class="mrf-chip mrf-chip-secondary"
                id="mrf-deselect-all"
                type="button"
            >
                Deselect all
            </button>
        </div>

        ${staleSection}
    </div>

    <div class="mrf-section mrf-primary-action-section">
        <button
            id="${RELIST_BUTTON_ID}"
            type="button"
            disabled
        >
            <span class="mrf-btn-content">
                <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                >
                    <path
                        d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16m0 5v-5h-5"
                        stroke="currentColor"
                        stroke-width="2.2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    />
                </svg>

                Relist Selected (${selectedListingIds.length})
            </span>
        </button>
    </div>
</div>`;

            const relistButton =
                document.getElementById(
                    RELIST_BUTTON_ID
                );

            if (relistButton) {
                relistButton.onclick =
                    handleRelistSelected;
            }

            const selectAll =
                document.getElementById(
                    "mrf-select-all"
                );

            if (selectAll) {
                selectAll.onclick =
                    () => {
                        setSelectedListings(
                            marketplaceState
                                .active_listings
                                .map(
                                    listing =>
                                        listing.id
                                )
                        );
                    };
            }

            const deselectAll =
                document.getElementById(
                    "mrf-deselect-all"
                );

            if (deselectAll) {
                deselectAll.onclick =
                    () =>
                        setSelectedListings(
                            []
                        );
            }

            const staleButton =
                document.getElementById(
                    "mrf-stale-btn"
                );

            if (staleButton) {
                staleButton.onclick =
                    () =>
                        setSelectedListings(
                            getStaleListingIds(
                                staleDaysThreshold
                            )
                        );
            }

            const staleDaysInput =
                document.getElementById(
                    "mrf-stale-days"
                );

            if (
                staleDaysInput instanceof
                HTMLInputElement
            ) {
                staleDaysInput.addEventListener(
                    "input",
                    () => {
                        if (
                            staleDaysInput.value ===
                            ""
                        ) {
                            return;
                        }

                        staleDaysThreshold =
                            normalizeStaleDays(
                                staleDaysInput.value
                            );

                        const staleCount =
                            document.getElementById(
                                "mrf-stale-count"
                            );

                        if (staleCount) {
                            staleCount.textContent =
                                String(
                                    getStaleListingIds(
                                        staleDaysThreshold
                                    ).length
                                );
                        }
                    }
                );

                staleDaysInput.addEventListener(
                    "change",
                    () => {
                        setStaleDays(
                            staleDaysInput.value
                        );
                    }
                );

                staleDaysInput.addEventListener(
                    "blur",
                    () => {
                        setStaleDays(
                            staleDaysInput.value
                        );
                    }
                );

                staleDaysInput.addEventListener(
                    "keydown",
                    event => {
                        if (
                            event.key ===
                            "Enter"
                        ) {
                            staleDaysInput.blur();
                        }
                    }
                );
            }

            const staleDec =
                document.getElementById(
                    "mrf-stale-dec"
                );

            if (staleDec) {
                staleDec.onclick =
                    () =>
                        adjustStaleDays(
                            -1
                        );
            }

            const staleInc =
                document.getElementById(
                    "mrf-stale-inc"
                );

            if (staleInc) {
                staleInc.onclick =
                    () =>
                        adjustStaleDays(
                            1
                        );
            }

            updateSelectionBar();
        }

        updateStaleControls();
        updateSelectionBar();
    }

    function isSellingPage() {
        return pageContext.isSellingPage();
    }

    function getPrimaryPhotoFilename(e) {
        const t =
            e?.primary_listing_photo
                ?.image?.uri;

        if (!t)
            return null;

        try {
            return (
                new URL(t)
                    .pathname
                    .split("/")
                    .pop() ||
                null
            );
        }
        catch {
            return (
                t
                    .split("/")
                    .pop()
                    ?.split("?")[0] ||
                null
            );
        }
    }

    function getListingIdFromUrl(e) {
        try {
            return new URL(
                e,
                window.location.href
            ).searchParams.get(
                "listing_id"
            );
        }
        catch {
            return null;
        }
    }

    async function attachListingSelectionControls() {
        if (
            !pageContext.validateCurrentPage(
                "overlay_listing_checkboxes"
            )
        ) {
            return;
        }

        await scanInlineListingData();

        const e = new Map();
        const t = new Map();

        for (
            const n of marketplaceState
                .active_listings
        ) {
            t.set(
                String(n.id),
                n
            );

            if (
                document.getElementById(
                    n.id
                )
            ) {
                continue;
            }

            const r =
                getPrimaryPhotoFilename(
                    n
                );

            if (
                r &&
                !e.has(r)
            ) {
                e.set(
                    r,
                    n
                );
            }
        }

        for (
            const image of Array.from(
                document.getElementsByTagName(
                    "img"
                )
            )
        ) {
            if (e.size === 0)
                break;

            let listing;
            let filename;

            for (
                const [
                    candidateFilename,
                    candidateListing
                ] of e
            ) {
                if (
                    image.src.includes(
                        candidateFilename
                    )
                ) {
                    listing =
                        candidateListing;

                    filename =
                        candidateFilename;

                    break;
                }
            }

            if (!listing)
                continue;

            const card =
                findListingCardContainer(
                    image
                );

            if (!card)
                continue;

            if (
                card.getElementsByClassName(
                    LISTING_PICK_BUTTON_CLASS
                ).length === 0
            ) {
                addListingSelectionButton(
                    card,
                    listing,
                    image
                );
            }

            if (filename)
                e.delete(filename);
        }

        for (
            const anchor of Array.from(
                document.querySelectorAll(
                    'a[href*="listing_id="]'
                )
            )
        ) {
            if (
                !(anchor instanceof
                    HTMLAnchorElement)
            ) {
                continue;
            }

            const id =
                getListingIdFromUrl(
                    anchor.href
                );

            if (
                !id ||
                document.getElementById(
                    id
                )
            ) {
                continue;
            }

            const listing =
                t.get(id);

            if (!listing)
                continue;

            const row =
                anchor.closest(
                    '[role="row"]'
                ) ??
                anchor.closest(
                    "tr"
                );

            const image =
                row?.querySelector(
                    "img"
                );

            if (!image)
                continue;

            const card =
                findListingCardContainer(
                    image
                );

            if (
                card &&
                card.getElementsByClassName(
                    LISTING_PICK_BUTTON_CLASS
                ).length === 0
            ) {
                addListingSelectionButton(
                    card,
                    listing,
                    image
                );
            }
        }
    }

    function addListingSelectionButton(
        e,
        t,
        listingImage
    ) {
        const selected =
            selectedListingIds.includes(
                t.id
            );

        const r =
            document.createElement(
                "button"
            );

        r.type =
            "button";

        r.className =
            LISTING_PICK_BUTTON_CLASS;

        r.id =
            t.id;

        if (selected)
            r.classList.add(
                "selected"
            );

        r.innerHTML =
            selected
                ? "✓"
                : "";

        r.setAttribute(
            "aria-pressed",
            String(selected)
        );

        r.setAttribute(
            "aria-label",
            selected
                ? "Deselect listing"
                : "Select listing"
        );

        r.onclick =
            event => {
                event.preventDefault();
                event.stopPropagation();

                const listingId =
                    r.id;

                const isSelected =
                    selectedListingIds.includes(
                        listingId
                    );

                if (isSelected) {
                    selectedListingIds =
                        selectedListingIds.filter(
                            id =>
                                id !==
                                listingId
                        );

                    r.classList.remove(
                        "selected"
                    );

                    r.innerHTML =
                        "";

                    r.setAttribute(
                        "aria-pressed",
                        "false"
                    );

                    r.setAttribute(
                        "aria-label",
                        "Select listing"
                    );
                }
                else {
                    selectedListingIds.push(
                        listingId
                    );

                    r.classList.add(
                        "selected"
                    );

                    r.innerHTML =
                        "✓";

                    r.setAttribute(
                        "aria-pressed",
                        "true"
                    );

                    r.setAttribute(
                        "aria-label",
                        "Deselect listing"
                    );
                }

                refreshSelectionUi();
            };

        if (
            getComputedStyle(e)
                .position ===
            "static"
        ) {
            e.style.position =
                "relative";
        }

        e.appendChild(r);

        const age =
            getListingAgeDays(t);

        let ageBadge = null;

        if (
            age !== null &&
            e.getElementsByClassName(
                "mrf-age"
            ).length === 0
        ) {
            ageBadge =
                document.createElement(
                    "span"
                );

            ageBadge.className =
                "mrf-age" +
                (
                    age >=
                    staleDaysThreshold
                        ? " stale"
                        : ""
                );

            ageBadge.textContent =
                age === 0
                    ? "today"
                    : `${age}d`;

            ageBadge.title =
                `Listed ${age} day${
                    age === 1
                        ? ""
                        : "s"
                } ago`;

            e.appendChild(
                ageBadge
            );
        }

        const positionControlsOverImage =
            () => {
                if (
                    !(listingImage instanceof
                        HTMLImageElement)
                ) {
                    return;
                }

                const cardRect =
                    e.getBoundingClientRect();

                const imageRect =
                    listingImage
                        .getBoundingClientRect();

                if (
                    imageRect.width <= 0 ||
                    imageRect.height <= 0
                ) {
                    return;
                }

                r.style.top =
                    `${
                        Math.max(
                            0,
                            imageRect.top -
                            cardRect.top +
                            8
                        )
                    }px`;

                r.style.left =
                    `${
                        Math.max(
                            0,
                            imageRect.left -
                            cardRect.left +
                            8
                        )
                    }px`;

                if (ageBadge) {
                    ageBadge.style.top =
                        `${
                            Math.max(
                                0,
                                imageRect.top -
                                cardRect.top +
                                8
                            )
                        }px`;

                    ageBadge.style.right =
                        `${
                            Math.max(
                                0,
                                cardRect.right -
                                imageRect.right +
                                8
                            )
                        }px`;
                }
            };

        requestAnimationFrame(
            positionControlsOverImage
        );

        listingImage?.addEventListener(
            "load",
            positionControlsOverImage,
            {
                once: true
            }
        );
    }

    function refreshSelectionUi() {
        renderControlPanel();

        const e =
            document.getElementById(
                RELIST_BUTTON_ID
            );

        if (
            e instanceof
            HTMLButtonElement
        ) {
            e.disabled =
                selectedListingIds.length ===
                0;

            e.innerHTML =
                `
      <span class="mrf-btn-content">
        <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
        >
            <path
                d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16m0 5v-5h-5"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
            />
        </svg>

        Relist Selected (${selectedListingIds.length})
      </span>
    `;
        }

        updateSelectionBar();
    }

    function removeMarketplaceUi() {
        panelInitialized =
            false;

        const panel =
            document.getElementById(
                PANEL_ID
            );

        panel?.remove();

        Array.from(
            document.getElementsByClassName(
                LISTING_PICK_BUTTON_CLASS
            )
        ).forEach(
            node => node.remove()
        );

        Array.from(
            document.getElementsByClassName(
                "mrf-age"
            )
        ).forEach(
            node => node.remove()
        );
    }

    function updateProgressBar(
        e,
        t,
        label = ""
    ) {
        if (!progressContainer)
            return;

        const n =
            progressContainer.querySelector(
                "#ai-progress-bar"
            );

        const r =
            progressContainer.querySelector(
                "#ai-progress-text"
            );

        const percent =
            t > 0
                ? Math.max(
                    0,
                    Math.min(
                        100,
                        e / t * 100
                    )
                )
                : 0;

        if (n) {
            n.style.width =
                `${percent}%`;

            n.setAttribute(
                "aria-valuenow",
                String(
                    Math.round(
                        percent
                    )
                )
            );
        }

        if (r) {
            r.textContent =
                label ||
                `${Math.round(percent)}%`;
        }
    }

    function showDialog(e, t, n) {
        return new Promise(
            r => {
                const i =
                    document.createElement(
                        "div"
                    );

                i.className =
                    "dialog-overlay";

                const s =
                    document.createElement(
                        "div"
                    );

                s.className =
                    "dialog";

                const o =
                    document.createElement(
                        "div"
                    );

                o.className =
                    "dialog-message";

                o.innerHTML =
                    `
      <div class="dialog-title">${e}</div>
      <div class="dialog-subtitle">${t}</div>
    `;

                const a =
                    document.createElement(
                        "div"
                    );

                a.className =
                    "dialog-buttons";

                n.forEach(
                    e => {
                        const t =
                            document.createElement(
                                "button"
                            );

                        t.type =
                            "button";

                        t.innerHTML =
                            e.text;

                        t.className =
                            `dialog-btn ${
                                e.className ||
                                "dialog-btn-secondary"
                            }`;

                        t.onclick =
                            () => {
                                i.remove();

                                r(
                                    e.value
                                );
                            };

                        a.appendChild(
                            t
                        );
                    }
                );

                s.appendChild(o);
                s.appendChild(a);

                i.appendChild(s);

                document.body.appendChild(
                    i
                );

                syncMarketplaceTheme();
            }
        );
    }
})();
