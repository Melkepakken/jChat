const YOUTUBE_API_ROOT = "https://www.googleapis.com/youtube/v3/";
const YOUTUBE_RESOLVER_VERSION = "4";
const YOUTUBE_API_TIMEOUT_MS = 15000;
const MAX_UPLOADS = 50;
const MAX_METADATA_BATCH_SIZE = 50;
const MAX_PENDING_METADATA = 50;
const MAX_RETAINED_CANDIDATES = 5;
const MAX_PENDING_SEARCH_CANDIDATES = 5;
const CACHE_VERSION = "v1";
const GLOBAL_CACHE_KEY = "global";
const OFFLINE_BACKOFF_MS = [60 * 1000, 120 * 1000, 300 * 1000];
const SEARCH_BACKOFF_MS = [
  6 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];
const TEMPORARY_COOLDOWN_MS = 60 * 1000;
const CONFIGURATION_COOLDOWN_MS = 5 * 60 * 1000;
const PACIFIC_RESET_BUFFER_MS = 60 * 1000;
// Keep verified ordinary upload metadata fresh for 30 minutes independently of
// the uploads cache storage TTL. Candidate and unresolved entries are checked
// on the cheap path.
const ORDINARY_METADATA_REFRESH_MS = 30 * 60 * 1000;
const RETAINED_CANDIDATE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_MISSING_METADATA_CHECKS = 3;
const MAX_MEMORY_CACHE_ENTRIES = 256;
const CACHE_TTL = {
  channel: 3 * 24 * 60 * 60,
  unavailable: 60 * 60,
  knownLive: 24 * 60 * 60,
  liveResult: 60,
  offlineState: 7 * 24 * 60 * 60,
  uploadsState: 7 * 24 * 60 * 60,
  searchState: 7 * 24 * 60 * 60,
  searchClientCooldown: 30 * 60,
};
const DAILY_QUOTA_REASONS = new Set([
  "quotaExceeded",
  "dailyLimitExceeded",
  "variableTermExpiredDailyExceeded",
]);
const CONFIGURATION_REASONS = new Set([
  "accessNotConfigured",
  "dailyLimitExceededUnreg",
  "forbidden",
  "keyExpired",
  "keyInvalid",
  "rateLimitExceededUnreg",
  "userRateLimitExceededUnreg",
]);
const TEMPORARY_REASONS = new Set([
  "concurrentLimitExceeded",
  "rateLimitExceeded",
  "servingLimitExceeded",
  "userRateLimitExceeded",
]);
const inFlightResolutions = new Map();
const memoryCache = new Map();
const warningDeadlines = new Map();
const CHANNEL_KEYED_CACHE_KINDS = new Set([
  "searchState",
  "searchTemporary",
  "uploadsState",
]);

function validRetryAfterMs(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : null;
}

function jsonResponse(body, status = 200, retryAfterMs = null) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-JChat-Resolver-Version": YOUTUBE_RESOLVER_VERSION,
  };
  const retryDelay = validRetryAfterMs(retryAfterMs);

  if (retryDelay !== null) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(retryDelay / 1000)));
  }

  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

function normalizeHandle(value) {
  const handle = String(value || "")
    .trim()
    .replace(/^@+/, "");

  return handle && /^[a-zA-Z0-9._-]+$/.test(handle) ? handle : null;
}

function isVideoId(value) {
  return /^[a-zA-Z0-9_-]{11}$/.test(String(value || ""));
}

function apiError(stage, status = null, reason = null) {
  const error = new Error("YouTube Data API request failed.");
  error.name = "YouTubeApiError";
  error.stage = stage;
  error.status = status;
  error.reason = reason;
  return error;
}

function configurationError(stage = "configuration", reason = null) {
  const error = new Error("YouTube discovery is not configured correctly.");
  error.name = "YouTubeConfigurationError";
  error.stage = stage;
  error.status = null;
  error.reason = reason;
  return error;
}

function channelUnavailableError(stage, reason) {
  const error = new Error(
    "This YouTube channel is not available for automatic discovery.",
  );
  error.name = "YouTubeChannelUnavailableError";
  error.stage = stage;
  error.reason = reason;
  return error;
}

function discoveryError(code, message, retryAt, details = {}) {
  const error = new Error(message);
  error.name = "YouTubeDiscoveryError";
  error.code = code;
  error.retryAt = retryAt;
  error.stage = details.stage || "unknown";
  error.status = details.status ?? null;
  error.reason = details.reason || null;
  return error;
}

function safeLogToken(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value)
    ? value
    : null;
}

function readClientVersion(request) {
  let value = null;

  try {
    value = request?.headers?.get?.("X-JChat-Client-Version");
  } catch {
    return null;
  }

  const version = typeof value === "string" ? value.trim() : "";

  return version.length <= 32 &&
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)
    ? version
    : null;
}

function diagnosticDetails(context, details = {}) {
  return {
    ...details,
    clientVersion: readClientVersion(context?.request),
    resolverVersion: YOUTUBE_RESOLVER_VERSION,
  };
}

function logWarningOnce(context, key, message, details = {}) {
  const now = Date.now();
  const deadline = warningDeadlines.get(key) || 0;

  if (deadline > now) {
    return;
  }

  warningDeadlines.set(key, now + TEMPORARY_COOLDOWN_MS);

  while (warningDeadlines.size > 32) {
    warningDeadlines.delete(warningDeadlines.keys().next().value);
  }

  console.warn(message, diagnosticDetails(context, details));
}

async function fetchApi(path, params, apiKey, stage) {
  const url = new URL(path, YOUTUBE_API_ROOT);

  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    YOUTUBE_API_TIMEOUT_MS,
  );

  try {
    let response;

    try {
      response = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          "X-Goog-Api-Key": apiKey,
        },
        signal: controller.signal,
      });
    } catch {
      throw apiError(stage);
    }

    if (!response.ok) {
      let reason = null;

      try {
        const errorData = await response.json();
        const firstReason = errorData?.error?.errors?.[0]?.reason;

        if (typeof firstReason === "string") {
          reason = firstReason;
        }
      } catch {
        if (controller.signal.aborted) {
          throw apiError(stage);
        }

        // The status and stage are enough when Google does not return JSON.
      }

      throw apiError(stage, response.status, reason);
    }

    try {
      return await response.json();
    } catch {
      if (controller.signal.aborted) {
        throw apiError(stage);
      }

      throw apiError(`${stage}-json`, response.status);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

function responseItems(data, stage, options = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw apiError(`${stage}-shape`, 200);
  }

  if (!Object.prototype.hasOwnProperty.call(data, "items")) {
    if (
      data.pageInfo?.totalResults === 0 ||
      options.allowMissingItems === true
    ) {
      return [];
    }

    throw apiError(`${stage}-shape`, 200);
  }

  if (!Array.isArray(data.items)) {
    throw apiError(`${stage}-shape`, 200);
  }

  return data.items;
}

function candidateVideoIds(items, getVideoId, stage) {
  const seen = new Set();
  const videoIds = [];

  for (const item of items) {
    const videoId = getVideoId(item);

    if (!isVideoId(videoId)) {
      throw apiError(`${stage}-shape`, 200);
    }

    if (!seen.has(videoId)) {
      seen.add(videoId);
      videoIds.push(videoId);
    }
  }

  return videoIds;
}

function zonedDateParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(new Date(timestamp));
  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }

  return values;
}

function zonedTimeToUtc(parts, timeZone) {
  const desired = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0,
  );
  let candidate = desired;

  for (let attempt = 0; attempt < 4; attempt++) {
    const observed = zonedDateParts(candidate, timeZone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const adjustment = desired - observedAsUtc;

    candidate += adjustment;

    if (adjustment === 0) {
      break;
    }
  }

  return candidate;
}

function nextPacificQuotaReset(now = Date.now()) {
  const timeZone = "America/Los_Angeles";
  const current = zonedDateParts(now, timeZone);
  const nextDate = new Date(
    Date.UTC(current.year, current.month - 1, current.day + 1),
  );
  const resetAt = zonedTimeToUtc(
    {
      day: nextDate.getUTCDate(),
      hour: 0,
      minute: 0,
      month: nextDate.getUTCMonth() + 1,
      second: 0,
      year: nextDate.getUTCFullYear(),
    },
    timeZone,
  );

  return resetAt + PACIFIC_RESET_BUFFER_MS;
}

function isDailyQuotaError(error) {
  return (
    error?.status === 403 &&
    DAILY_QUOTA_REASONS.has(safeLogToken(error.reason))
  );
}

function isConfigurationError(error) {
  return (
    error?.name === "YouTubeConfigurationError" ||
    CONFIGURATION_REASONS.has(safeLogToken(error?.reason))
  );
}

function isTemporaryError(error) {
  const status = error?.status;

  return (
    status === null ||
    status === undefined ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599) ||
    TEMPORARY_REASONS.has(safeLogToken(error?.reason)) ||
    /-(json|shape)$/.test(String(error?.stage || ""))
  );
}

function isChannelDiscoveryStage(stage) {
  return /^(?:channels|playlistItems|videos)\.list(?:-(?:json|shape))?$/.test(
    String(stage || ""),
  );
}

function isSearchListStage(stage) {
  return /^search\.list(?:-(?:json|shape))?$/.test(String(stage || ""));
}

function defaultCache() {
  try {
    return globalThis.caches?.default || null;
  } catch {
    return null;
  }
}

function cacheKey(context, kind, handle) {
  const url = new URL(context.request.url);
  const cacheHandle = CHANNEL_KEYED_CACHE_KINDS.has(kind)
    ? String(handle)
    : String(handle).toLowerCase();
  url.pathname =
    `/__jchat-youtube-live-cache/${CACHE_VERSION}/${kind}/` +
    encodeURIComponent(cacheHandle);
  url.search = "";
  url.hash = "";
  return new Request(url.toString(), { method: "GET" });
}

function memoryCacheKey(context, kind, handle) {
  return cacheKey(context, kind, handle).url;
}

function pruneMemoryCache(now = Date.now()) {
  for (const [key, entry] of memoryCache) {
    if (!entry || entry.expiresAt <= now) {
      memoryCache.delete(key);
    }
  }

  while (memoryCache.size > MAX_MEMORY_CACHE_ENTRIES) {
    memoryCache.delete(memoryCache.keys().next().value);
  }
}

function readMemoryCache(context, kind, handle) {
  const now = Date.now();
  const key = memoryCacheKey(context, kind, handle);
  const entry = memoryCache.get(key);

  if (!entry || entry.expiresAt <= now) {
    memoryCache.delete(key);
    return null;
  }

  // Keep frequently consulted global cooldowns from being displaced by a
  // burst of one-off channel handles when the shared Cache API is unavailable.
  memoryCache.delete(key);
  memoryCache.set(key, entry);
  return entry.value;
}

function writeMemoryCache(context, kind, handle, value, ttl) {
  const key = memoryCacheKey(context, kind, handle);
  const expiresAt = Date.now() + Math.max(1, ttl) * 1000;

  pruneMemoryCache();
  memoryCache.delete(key);
  memoryCache.set(key, { expiresAt, value });
  pruneMemoryCache();
}

function deleteMemoryCache(context, kind, handle) {
  memoryCache.delete(memoryCacheKey(context, kind, handle));
}

async function readCache(context, kind, handle) {
  const cache = defaultCache();
  const inMemory = readMemoryCache(context, kind, handle);

  if (!cache) {
    return inMemory;
  }

  try {
    const response = await cache.match(cacheKey(context, kind, handle));

    if (!response) {
      return inMemory;
    }

    const shared = await response.json();
    const sharedWrittenAt = Number(shared?._cachedAt || 0);
    const memoryWrittenAt = Number(inMemory?._cachedAt || 0);
    const sharedResetAt = Number(shared?.resetAt || 0);
    const memoryResetAt = Number(inMemory?.resetAt || 0);
    const sharedResetIsNewer =
      kind === "searchState" &&
      Number.isFinite(sharedResetAt) &&
      sharedResetAt > memoryResetAt;
    const memoryResetIsNewer =
      kind === "searchState" &&
      Number.isFinite(memoryResetAt) &&
      memoryResetAt > sharedResetAt;

    if (
      inMemory !== null &&
      (memoryResetIsNewer ||
        (memoryWrittenAt > sharedWrittenAt && !sharedResetIsNewer))
    ) {
      return inMemory;
    }

    const sharedExpiresAt = Number(shared?._expiresAt || 0);
    const remainingTtl = Math.ceil((sharedExpiresAt - Date.now()) / 1000);

    if (Number.isFinite(remainingTtl) && remainingTtl > 0) {
      writeMemoryCache(context, kind, handle, shared, remainingTtl);
    } else {
      // Older cache entries have no absolute expiry metadata. Do not retain a
      // stale local value after the shared cache has proved it obsolete.
      deleteMemoryCache(context, kind, handle);
    }

    return shared;
  } catch {
    logWarningOnce(
      context,
      `cache-read-${kind}`,
      "[youtube-live] Internal cache read failed; using isolate memory.",
      { kind },
    );
    return inMemory;
  }
}

async function writeCache(context, kind, handle, value, ttl) {
  const cache = defaultCache();
  const storedValue =
    value && typeof value === "object" && !Array.isArray(value)
      ? {
          ...value,
          _cachedAt: Date.now(),
          _expiresAt: Date.now() + Math.max(1, ttl) * 1000,
        }
      : value;

  writeMemoryCache(context, kind, handle, storedValue, ttl);

  if (!cache) {
    return;
  }

  try {
    await cache.put(
      cacheKey(context, kind, handle),
      new Response(JSON.stringify(storedValue), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${ttl}`,
        },
      }),
    );
  } catch {
    logWarningOnce(
      context,
      `cache-write-${kind}`,
      "[youtube-live] Internal cache write failed; using isolate memory.",
      { kind },
    );
  }
}

async function deleteCache(context, kind, handle) {
  const cache = defaultCache();

  deleteMemoryCache(context, kind, handle);

  if (!cache) {
    return;
  }

  try {
    await cache.delete(cacheKey(context, kind, handle));
  } catch {
    logWarningOnce(
      context,
      `cache-delete-${kind}`,
      "[youtube-live] Internal cache delete failed.",
      { kind },
    );
  }
}

function offlineResult(nextCheckAt, now = Date.now()) {
  const retryAfterMs = validRetryAfterMs(nextCheckAt - now);

  return retryAfterMs === null ? null : { live: false, retryAfterMs };
}

function cachedResolution(value, now = Date.now()) {
  if (value?.live === false && Number.isFinite(value.nextCheckAt)) {
    return offlineResult(value.nextCheckAt, now);
  }

  if (value?.live === true && isVideoId(value.videoId)) {
    return { live: true, videoId: value.videoId };
  }

  return null;
}

function cachedOfflineState(value) {
  if (
    !Number.isInteger(value?.offlineCount) ||
    value.offlineCount < 1 ||
    !Number.isFinite(value.nextCheckAt)
  ) {
    return null;
  }

  return {
    nextCheckAt: value.nextCheckAt,
    offlineCount: Math.min(value.offlineCount, OFFLINE_BACKOFF_MS.length),
  };
}

function cachedCooldown(value) {
  if (
    typeof value?.code !== "string" ||
    !Number.isFinite(value.retryAt) ||
    value.retryAt <= Date.now()
  ) {
    return null;
  }

  return {
    code: value.code,
    reason: safeLogToken(value.reason),
    retryAt: value.retryAt,
    stage: safeLogToken(value.stage) || "unknown",
    status: Number.isInteger(value.status) ? value.status : null,
  };
}

function cachedSearchState(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Number.isFinite(value?._expiresAt) && value._expiresAt <= Date.now()) ||
    !Number.isInteger(value.stage) ||
    value.stage < 0 ||
    value.stage > SEARCH_BACKOFF_MS.length ||
    !Number.isFinite(value.nextSearchAt) ||
    (value.lastSearchAt !== null &&
      value.lastSearchAt !== undefined &&
      !Number.isFinite(value.lastSearchAt)) ||
    (value.resetAt !== null &&
      value.resetAt !== undefined &&
      (!Number.isFinite(value.resetAt) || value.resetAt < 0))
  ) {
    return null;
  }

  let pendingCandidates = [];

  if (value.pendingCandidates !== undefined) {
    if (
      !Array.isArray(value.pendingCandidates) ||
      value.pendingCandidates.length > MAX_PENDING_SEARCH_CANDIDATES
    ) {
      return null;
    }

    const parsedCandidates = value.pendingCandidates.map(cachedMetadataEntry);

    if (
      parsedCandidates.some(
        (entry) =>
          !entry ||
          !["missing", "unknown", "upcoming"].includes(entry.state),
      )
    ) {
      return null;
    }

    pendingCandidates = retainSearchCandidates(parsedCandidates);
  }

  return {
    lastSearchAt:
      value.lastSearchAt === null || value.lastSearchAt === undefined
        ? null
        : value.lastSearchAt,
    nextSearchAt: value.nextSearchAt,
    pendingCandidates,
    resetAt:
      value.resetAt === null || value.resetAt === undefined
        ? null
        : value.resetAt,
    stage: value.stage,
  };
}

function uploadFingerprint(videoIds) {
  return videoIds.join(",");
}

function cachedMetadataEntry(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !isVideoId(value.videoId) ||
    !["ordinary", "live", "upcoming", "unknown", "missing"].includes(
      value.state,
    ) ||
    (value.scheduledStartTime !== null &&
      value.scheduledStartTime !== undefined &&
      typeof value.scheduledStartTime !== "string") ||
    (value.actualStartTime !== null &&
      value.actualStartTime !== undefined &&
      typeof value.actualStartTime !== "string") ||
    (value.actualEndTime !== null &&
      value.actualEndTime !== undefined &&
      typeof value.actualEndTime !== "string") ||
    (value.verifiedAt !== null &&
      value.verifiedAt !== undefined &&
      (!Number.isFinite(value.verifiedAt) || value.verifiedAt < 0)) ||
    (value.lastSeenAt !== null &&
      value.lastSeenAt !== undefined &&
      (!Number.isFinite(value.lastSeenAt) || value.lastSeenAt < 0)) ||
    (value.missingChecks !== null &&
      value.missingChecks !== undefined &&
      (!Number.isInteger(value.missingChecks) || value.missingChecks < 0)) ||
    (value.nextCheckAt !== null &&
      value.nextCheckAt !== undefined &&
      (!Number.isFinite(value.nextCheckAt) || value.nextCheckAt < 0))
  ) {
    return null;
  }

  return {
    actualEndTime: value.actualEndTime || null,
    actualStartTime: value.actualStartTime || null,
    lastSeenAt: Number.isFinite(value.lastSeenAt) ? value.lastSeenAt : 0,
    missingChecks: Number.isInteger(value.missingChecks)
      ? Math.min(value.missingChecks, MAX_MISSING_METADATA_CHECKS)
      : 0,
    nextCheckAt: Number.isFinite(value.nextCheckAt)
      ? value.nextCheckAt
      : null,
    scheduledStartTime: value.scheduledStartTime || null,
    state: value.state,
    videoId: value.videoId,
    verifiedAt: Number.isFinite(value.verifiedAt) ? value.verifiedAt : 0,
  };
}

function cachedCandidate(value) {
  const candidate = cachedMetadataEntry(value);

  return candidate && ["live", "upcoming"].includes(candidate.state)
    ? candidate
    : null;
}

function dedupeMetadata(entries) {
  const seen = new Set();
  const result = [];

  for (const entry of entries) {
    if (!entry || seen.has(entry.videoId)) {
      continue;
    }

    seen.add(entry.videoId);
    result.push(entry);
  }

  return result;
}

function cachedUploadsState(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Number.isFinite(value?._expiresAt) && value._expiresAt <= Date.now()) ||
    !Array.isArray(value.uploadIds) ||
    value.uploadIds.length > MAX_UPLOADS ||
    value.uploadIds.some((videoId) => !isVideoId(videoId)) ||
    typeof value.fingerprint !== "string" ||
    value.fingerprint !== uploadFingerprint(value.uploadIds)
  ) {
    return null;
  }

  const now = Date.now();
  let metadata;

  if (Array.isArray(value.metadata)) {
    if (value.metadata.length > MAX_UPLOADS + MAX_RETAINED_CANDIDATES) {
      return null;
    }

    const parsed = value.metadata.map(cachedMetadataEntry);

    if (parsed.some((entry) => !entry)) {
      return null;
    }

    metadata = dedupeMetadata(parsed);
  } else if (Array.isArray(value.candidates)) {
    // Migrate the previous bounded candidate-only format safely. Uploads that
    // were not candidates are unknown until their metadata is checked again.
    if (value.candidates.length > MAX_RETAINED_CANDIDATES) {
      return null;
    }

    const legacyCandidates = dedupeMetadata(
      value.candidates.map(cachedCandidate).filter(Boolean),
    );
    const legacyById = new Map(
      legacyCandidates.map((candidate) => [candidate.videoId, candidate]),
    );

    metadata = [
      ...value.uploadIds.map(
        (videoId) =>
          legacyById.get(videoId) || {
            actualEndTime: null,
            actualStartTime: null,
            lastSeenAt: now,
            missingChecks: 0,
            nextCheckAt: null,
            scheduledStartTime: null,
            state: "unknown",
            videoId,
            verifiedAt: 0,
          },
      ),
      ...legacyCandidates.filter(
        (candidate) => !value.uploadIds.includes(candidate.videoId),
      ).map((candidate) => ({ ...candidate, lastSeenAt: now })),
    ];
  } else {
    return null;
  }

  let pendingIds = [];

  if (value.pendingIds !== undefined) {
    if (
      !Array.isArray(value.pendingIds) ||
      value.pendingIds.length > MAX_PENDING_METADATA ||
      value.pendingIds.some((videoId) => !isVideoId(videoId))
    ) {
      return null;
    }

    pendingIds = Array.from(new Set(value.pendingIds));
  }

  const candidates = metadata.filter((entry) =>
    ["live", "upcoming"].includes(entry.state),
  );

  return {
    candidates,
    fingerprint: value.fingerprint,
    metadata,
    pendingIds,
    uploadIds: [...value.uploadIds],
  };
}

function cacheTtlUntil(deadline) {
  return Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
}

async function activeCooldown(context, kind, cacheHandle = GLOBAL_CACHE_KEY) {
  return cachedCooldown(await readCache(context, kind, cacheHandle));
}

async function activeGeneralCooldown(context) {
  const kinds = [
    "generalQuotaCooldown",
    "generalConfigurationCooldown",
    "generalTemporaryCooldown",
  ];

  for (const kind of kinds) {
    const cooldown = await activeCooldown(context, kind);

    if (cooldown) {
      return cooldown;
    }
  }

  return null;
}

function generalCooldownKind(code) {
  if (code === "youtube_quota_exceeded") {
    return "generalQuotaCooldown";
  }

  if (code === "youtube_configuration_error") {
    return "generalConfigurationCooldown";
  }

  return "generalTemporaryCooldown";
}

function cooldownPriority(code) {
  if (
    code === "youtube_quota_exceeded" ||
    code === "youtube_search_quota_exceeded"
  ) {
    return 3;
  }

  return code === "youtube_configuration_error" ? 2 : 1;
}

async function establishCooldown(
  context,
  kind,
  cooldown,
  cacheHandle = GLOBAL_CACHE_KEY,
) {
  const existing = await activeCooldown(context, kind, cacheHandle);

  if (
    existing &&
    cooldownPriority(existing.code) >= cooldownPriority(cooldown.code)
  ) {
    return existing;
  }

  await writeCache(
    context,
    kind,
    cacheHandle,
    cooldown,
    cacheTtlUntil(cooldown.retryAt),
  );
  return cooldown;
}

function searchStateRecord(previous, overrides = {}) {
  const readValue = (key, fallback) =>
    Object.prototype.hasOwnProperty.call(overrides, key)
      ? overrides[key]
      : fallback;

  return {
    lastSearchAt: readValue("lastSearchAt", previous?.lastSearchAt ?? null),
    nextSearchAt: readValue("nextSearchAt", previous?.nextSearchAt ?? 0),
    pendingCandidates: retainSearchCandidates(
      readValue("pendingCandidates", previous?.pendingCandidates || []),
    ),
    resetAt: readValue("resetAt", previous?.resetAt ?? null),
    stage: readValue("stage", previous?.stage ?? 0),
  };
}

async function saveSearchState(context, channelId, state) {
  await writeCache(
    context,
    "searchState",
    channelId,
    state,
    CACHE_TTL.searchState,
  );
  return state;
}

async function storeSearchMiss(
  context,
  channelId,
  pendingCandidates = undefined,
) {
  const previous = cachedSearchState(
    await readCache(context, "searchState", channelId),
  );
  const stage = Math.min((previous?.stage || 0) + 1, SEARCH_BACKOFF_MS.length);
  const lastSearchAt = Date.now();
  const state = searchStateRecord(previous, {
    lastSearchAt,
    nextSearchAt: lastSearchAt + SEARCH_BACKOFF_MS[stage - 1],
    pendingCandidates:
      pendingCandidates === undefined
        ? previous?.pendingCandidates || []
        : pendingCandidates,
    // A miss advances within the current reset generation, not before it.
    stage,
  });

  return saveSearchState(context, channelId, state);
}

async function clearSearchState(
  context,
  channelId,
  pendingCandidates = undefined,
) {
  const previous = cachedSearchState(
    await readCache(context, "searchState", channelId),
  );
  const now = Date.now();
  const state = searchStateRecord(previous, {
    lastSearchAt: null,
    nextSearchAt: 0,
    pendingCandidates:
      pendingCandidates === undefined
        ? previous?.pendingCandidates || []
        : pendingCandidates,
    resetAt: now,
    stage: 0,
  });

  // A reset marker is deliberately written instead of relying on deletion.
  // Cache API writes are still best-effort across isolates; this only gives
  // readers a newer state to prefer when the shared cache is available.
  return saveSearchState(context, channelId, state);
}

async function resetSearchBackoffOnActivity(context, channelId) {
  const previous = cachedSearchState(
    await readCache(context, "searchState", channelId),
  );

  if (!previous || previous.stage === 0) {
    return previous;
  }

  const now = Date.now();
  const state = searchStateRecord(previous, {
    lastSearchAt: previous.lastSearchAt,
    nextSearchAt: Math.min(
      previous.nextSearchAt,
      now + SEARCH_BACKOFF_MS[0],
    ),
    resetAt: now,
    stage: 0,
  });

  return saveSearchState(context, channelId, state);
}

async function establishGeneralCooldown(context, cooldown) {
  const existing = await activeGeneralCooldown(context);

  if (
    existing &&
    cooldownPriority(existing.code) >= cooldownPriority(cooldown.code)
  ) {
    return existing;
  }

  await writeCache(
    context,
    generalCooldownKind(cooldown.code),
    GLOBAL_CACHE_KEY,
    cooldown,
    cacheTtlUntil(cooldown.retryAt),
  );

  // Each priority has its own key so a late weaker write cannot overwrite a
  // quota cooldown in another isolate or concurrent request.
  return (await activeGeneralCooldown(context)) || cooldown;
}

function cooldownMessage(code) {
  if (code === "youtube_channel_unavailable") {
    return "This YouTube channel is not available for automatic discovery.";
  }

  if (code === "youtube_quota_exceeded") {
    return "YouTube discovery is paused because its API quota is exhausted.";
  }

  if (code === "youtube_configuration_error") {
    return "YouTube discovery is not configured correctly.";
  }

  return "YouTube discovery is temporarily unavailable.";
}

function throwCooldown(cooldown) {
  throw discoveryError(
    cooldown.code,
    cooldownMessage(cooldown.code),
    cooldown.retryAt,
    cooldown,
  );
}

function cachedChannel(value) {
  if (
    typeof value?.channelId !== "string" ||
    !value.channelId.trim() ||
    typeof value?.uploadsPlaylistId !== "string" ||
    !value.uploadsPlaylistId.trim()
  ) {
    return null;
  }

  return {
    channelId: value.channelId,
    uploadsPlaylistId: value.uploadsPlaylistId,
  };
}

async function resolveChannel(context, handle, apiKey, forceRefresh = false) {
  if (forceRefresh) {
    await deleteCache(context, "channel", handle);
  } else {
    const cached = cachedChannel(await readCache(context, "channel", handle));

    if (cached) {
      return cached;
    }
  }

  const data = await fetchApi(
    "channels",
    {
      part: "contentDetails",
      forHandle: handle,
      maxResults: "1",
      fields:
        "items(id,contentDetails/relatedPlaylists/uploads),pageInfo(totalResults)",
    },
    apiKey,
    "channels.list",
  );
  const items = responseItems(data, "channels.list");

  // Empty filtered responses need explicit evidence of no matching channel.
  if (
    !Object.prototype.hasOwnProperty.call(data, "items") &&
    data.pageInfo?.totalResults !== 0
  ) {
    throw apiError("channels.list-shape", 200);
  }

  if (!items.length) {
    throw channelUnavailableError("channels.list", "channelNotFound");
  }

  const item = items[0];
  const details = item?.contentDetails;
  const playlists = details?.relatedPlaylists;
  const uploads = playlists?.uploads;

  if (
    !item ||
    typeof item !== "object" ||
    Array.isArray(item) ||
    typeof item.id !== "string" ||
    !item.id.trim() ||
    (details !== undefined &&
      (!details || typeof details !== "object" || Array.isArray(details))) ||
    (playlists !== undefined &&
      (!playlists || typeof playlists !== "object" || Array.isArray(playlists))) ||
    (uploads !== undefined && typeof uploads !== "string")
  ) {
    throw apiError("channels.list-shape", 200);
  }

  if (!uploads?.trim()) {
    throw channelUnavailableError("channels.list", "uploadsPlaylistMissing");
  }

  const channel = {
    channelId: item.id,
    uploadsPlaylistId: uploads,
  };

  await writeCache(context, "channel", handle, channel, CACHE_TTL.channel);
  return channel;
}

async function latestUploadIds(uploadsPlaylistId, apiKey) {
  const items = responseItems(
    await fetchApi(
      "playlistItems",
      {
        part: "contentDetails",
        playlistId: uploadsPlaylistId,
        maxResults: String(MAX_UPLOADS),
        fields: "items(contentDetails/videoId),pageInfo(totalResults)",
      },
      apiKey,
      "playlistItems.list",
    ),
    "playlistItems.list",
  );

  return candidateVideoIds(
    items,
    (item) => item?.contentDetails?.videoId,
    "playlistItems.list",
  );
}

function isMissingUploadsPlaylist(error) {
  return (
    error?.stage === "playlistItems.list" &&
    error.status === 404 &&
    error.reason === "playlistNotFound"
  );
}

async function searchLiveVideoIds(channelId, apiKey) {
  const items = responseItems(
    await fetchApi(
      "search",
      {
        part: "snippet",
        channelId,
        eventType: "live",
        type: "video",
        maxResults: "5",
        fields: "items(id/videoId),pageInfo(totalResults)",
      },
      apiKey,
      "search.list",
    ),
    "search.list",
  );

  return candidateVideoIds(
    items,
    (item) => item?.id?.videoId,
    "search.list",
  );
}

async function videosById(videoIds, apiKey) {
  if (!videoIds.length) {
    return [];
  }

  return responseItems(
    await fetchApi(
      "videos",
      {
        part: "snippet,liveStreamingDetails",
        id: videoIds.join(","),
        fields:
          "items(id,snippet(channelId,liveBroadcastContent)," +
          "liveStreamingDetails(scheduledStartTime,actualStartTime,actualEndTime))",
      },
      apiKey,
      "videos.list",
    ),
    "videos.list",
    { allowMissingItems: true },
  );
}

function videoSnapshot(video, videoIds, channelId) {
  const requestedIds = new Set(videoIds);
  const content = video?.snippet?.liveBroadcastContent;
  const details = video?.liveStreamingDetails;

  if (
    !video ||
    typeof video !== "object" ||
    Array.isArray(video) ||
    !isVideoId(video.id) ||
    !requestedIds.has(video.id) ||
    typeof video.snippet?.channelId !== "string" ||
    !["live", "none", "upcoming"].includes(content) ||
    (details != null &&
      (typeof details !== "object" || Array.isArray(details))) ||
    ["scheduledStartTime", "actualStartTime", "actualEndTime"].some(
      (field) =>
        details?.[field] != null && typeof details[field] !== "string",
    )
  ) {
    throw apiError("videos.list-shape", 200);
  }

  const snapshot = {
    actualEndTime: details?.actualEndTime || null,
    actualStartTime: details?.actualStartTime || null,
    scheduledStartTime: details?.scheduledStartTime || null,
    state: "unknown",
    videoId: video.id,
  };

  if (video.snippet.channelId !== channelId) {
    return snapshot;
  }

  if (
    content === "live" &&
    details?.actualStartTime &&
    !details.actualEndTime
  ) {
    snapshot.state = "live";
  } else if (content === "upcoming") {
    snapshot.state = "upcoming";
  } else if (
    content === "none" &&
    (details?.actualEndTime ||
      (!details?.scheduledStartTime && !details?.actualStartTime))
  ) {
    // Conflicting broadcast hints without an end marker need another check.
    snapshot.state = "ordinary";
  }

  return snapshot;
}

function videoSnapshots(videoIds, videos, channelId) {
  const snapshots = new Map();

  for (const video of videos) {
    const snapshot = videoSnapshot(video, videoIds, channelId);
    snapshots.set(snapshot.videoId, snapshot);
  }

  return snapshots;
}

function activeLiveVideoId(videoIds, videos, channelId) {
  const snapshots = videoSnapshots(videoIds, videos, channelId);

  for (const videoId of videoIds) {
    if (snapshots.get(videoId)?.state === "live") {
      return videoId;
    }
  }

  return null;
}

function logResult(context, source, result, details = {}) {
  console.log(
    "[youtube-live] Resolution result:",
    diagnosticDetails(context, {
      source,
      live: result.live,
      videoId: result.videoId || null,
      retryAfterMs: result.retryAfterMs || null,
      ...details,
    }),
  );
}

async function resetOfflineState(context, handle) {
  await deleteCache(context, "offlineState", handle);
  await writeCache(
    context,
    "offlineState",
    handle,
    { nextCheckAt: 0, offlineCount: 0 },
    CACHE_TTL.offlineState,
  );
}

async function storeLiveResult(context, handle, videoId) {
  const result = { live: true, videoId };
  await Promise.all([
    writeCache(context, "known-live", handle, { videoId }, CACHE_TTL.knownLive),
    writeCache(context, "result", handle, result, CACHE_TTL.liveResult),
    resetOfflineState(context, handle),
  ]);
  return result;
}

async function storeOfflineResult(context, handle) {
  const previous = cachedOfflineState(
    await readCache(context, "offlineState", handle),
  );
  const offlineCount = Math.min(
    (previous?.offlineCount || 0) + 1,
    OFFLINE_BACKOFF_MS.length,
  );
  const delay = OFFLINE_BACKOFF_MS[offlineCount - 1];
  const nextCheckAt = Date.now() + delay;
  const cachedResult = { live: false, nextCheckAt };

  await Promise.all([
    writeCache(
      context,
      "offlineState",
      handle,
      { nextCheckAt, offlineCount },
      CACHE_TTL.offlineState,
    ),
    writeCache(
      context,
      "result",
      handle,
      cachedResult,
      Math.ceil(delay / 1000),
    ),
  ]);

  return offlineResult(nextCheckAt);
}

function candidateSignature(metadata) {
  if (!metadata) {
    return "";
  }

  if (metadata.state === "ordinary") {
    return "ordinary";
  }

  return [
    metadata.state,
    metadata.scheduledStartTime || "",
    metadata.actualStartTime || "",
    metadata.actualEndTime || "",
  ].join("|");
}

function metadataMap(metadata) {
  return new Map(metadata.map((entry) => [entry.videoId, entry]));
}

function isRetainedMetadata(entry, currentIds, now) {
  return (
    !currentIds.has(entry.videoId) &&
    ["live", "upcoming", "unknown", "missing"].includes(entry.state) &&
    (entry.state !== "missing" ||
      entry.missingChecks < MAX_MISSING_METADATA_CHECKS) &&
    Number.isFinite(entry.lastSeenAt) &&
    now - entry.lastSeenAt <= RETAINED_CANDIDATE_MAX_AGE_MS
  );
}

function metadataIsDue(entry, now) {
  if (!entry || ["live", "upcoming", "unknown"].includes(entry.state)) {
    return true;
  }

  if (entry.state === "missing") {
    return (
      entry.missingChecks < MAX_MISSING_METADATA_CHECKS ||
      !Number.isFinite(entry.nextCheckAt) ||
      entry.nextCheckAt <= now
    );
  }

  return (
    !Number.isFinite(entry.verifiedAt) ||
    entry.verifiedAt + ORDINARY_METADATA_REFRESH_MS <= now
  );
}

function unknownMetadata(videoId, now) {
  return {
    actualEndTime: null,
    actualStartTime: null,
    lastSeenAt: now,
    missingChecks: 0,
    nextCheckAt: null,
    scheduledStartTime: null,
    state: "unknown",
    videoId,
    verifiedAt: 0,
  };
}

function isSearchCandidateState(entry) {
  return Boolean(
    entry && ["missing", "unknown", "upcoming"].includes(entry.state),
  );
}

function retainSearchCandidates(entries, now = Date.now()) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return dedupeMetadata(entries)
    .filter(
      (entry) =>
        isSearchCandidateState(entry) &&
        Number.isFinite(entry.lastSeenAt) &&
        now - entry.lastSeenAt <= RETAINED_CANDIDATE_MAX_AGE_MS,
    )
    .slice(0, MAX_PENDING_SEARCH_CANDIDATES);
}

function searchCandidateIsDue(entry, now) {
  if (!entry) {
    return false;
  }

  if (Number.isFinite(entry.nextCheckAt) && entry.nextCheckAt > now) {
    return false;
  }

  return metadataIsDue(entry, now);
}

function pendingSearchCandidate(videoId, previous, now) {
  const priorLastSeenAt = Number.isFinite(previous?.lastSeenAt)
    ? previous.lastSeenAt
    : now;

  return {
    ...unknownMetadata(videoId, now),
    lastSeenAt: priorLastSeenAt || now,
    nextCheckAt: now + OFFLINE_BACKOFF_MS[0],
  };
}

function searchCandidateFromSnapshot(snapshot, previous, now) {
  const priorLastSeenAt = Number.isFinite(previous?.lastSeenAt)
    ? previous.lastSeenAt
    : now;

  return {
    ...snapshot,
    lastSeenAt: priorLastSeenAt || now,
    missingChecks: 0,
    nextCheckAt: now + OFFLINE_BACKOFF_MS[0],
    verifiedAt: now,
  };
}

function searchMissingCandidate(videoId, previous, now) {
  const missingChecks = Math.min(
    (previous?.missingChecks || 0) + 1,
    MAX_MISSING_METADATA_CHECKS,
  );
  const priorLastSeenAt = Number.isFinite(previous?.lastSeenAt)
    ? previous.lastSeenAt
    : now;

  return {
    actualEndTime: null,
    actualStartTime: null,
    lastSeenAt: priorLastSeenAt || now,
    missingChecks,
    nextCheckAt:
      now +
      (missingChecks >= MAX_MISSING_METADATA_CHECKS
        ? ORDINARY_METADATA_REFRESH_MS
        : OFFLINE_BACKOFF_MS[0]),
    scheduledStartTime: null,
    state: "missing",
    videoId,
    verifiedAt: now,
  };
}

function mergeSearchCandidates(
  previousCandidates,
  incomingCandidates,
  discardedIds = new Set(),
  now = Date.now(),
) {
  const byId = new Map();

  for (const entry of [...(previousCandidates || []), ...(incomingCandidates || [])]) {
    if (
      entry &&
      !discardedIds.has(entry.videoId) &&
      isSearchCandidateState(entry)
    ) {
      byId.set(entry.videoId, entry);
    }
  }

  return retainSearchCandidates(Array.from(byId.values()), now);
}

function inspectSearchMetadata(
  videoIds,
  videos,
  channelId,
  previousCandidates = [],
  now = Date.now(),
) {
  const snapshots = videoSnapshots(videoIds, videos, channelId);
  const videosById = new Map(videos.map((video) => [video.id, video]));
  const previousById = metadataMap(previousCandidates);
  const incomingCandidates = [];
  const discardedIds = new Set();
  let candidateVideoId = null;

  for (const videoId of videoIds) {
    const video = videosById.get(videoId);

    if (!video) {
      incomingCandidates.push(
        searchMissingCandidate(videoId, previousById.get(videoId), now),
      );
      continue;
    }

    // videoSnapshot deliberately treats ownership mismatch as unknown for
    // callers that need to remain conservative. Search candidates have a
    // stronger discard rule: a returned, different-channel owner is final.
    if (video.snippet.channelId !== channelId) {
      discardedIds.add(videoId);
      continue;
    }

    const snapshot = snapshots.get(videoId);

    if (snapshot?.state === "live") {
      candidateVideoId ||= videoId;
      discardedIds.add(videoId);
    } else if (snapshot?.state === "ordinary") {
      discardedIds.add(videoId);
    } else if (snapshot) {
      incomingCandidates.push(
        searchCandidateFromSnapshot(
          snapshot,
          previousById.get(videoId),
          now,
        ),
      );
    }
  }

  return {
    candidateVideoId,
    pendingCandidates: mergeSearchCandidates(
      previousCandidates.filter((entry) => !videoIds.includes(entry.videoId)),
      incomingCandidates,
      discardedIds,
      now,
    ),
    videosVerified: snapshots.size,
  };
}

async function retainSearchCandidatesForRetry(
  context,
  channelId,
  videoIds,
  options = {},
) {
  const previous = cachedSearchState(
    await readCache(context, "searchState", channelId),
  );
  const now = Date.now();
  const previousCandidates = previous?.pendingCandidates || [];
  const previousById = metadataMap(previousCandidates);
  const incomingCandidates = Array.from(new Set(videoIds)).map((videoId) =>
    pendingSearchCandidate(videoId, previousById.get(videoId), now),
  );
  const stage = options.advanceStage
    ? Math.max(previous?.stage || 0, 1)
    : previous?.stage || 0;
  const deadlineStage = Math.max(stage, 1);
  const nextSearchAt = Math.max(
    previous?.nextSearchAt || 0,
    now + SEARCH_BACKOFF_MS[deadlineStage - 1],
  );
  const state = searchStateRecord(previous, {
    lastSearchAt:
      options.searchAttempted === true
        ? now
        : previous?.lastSearchAt ?? null,
    nextSearchAt,
    pendingCandidates: mergeSearchCandidates(
      // Keep the just-observed IDs if the bounded pending set is already full.
      incomingCandidates,
      previousCandidates.filter((entry) => !videoIds.includes(entry.videoId)),
      new Set(),
      now,
    ),
    stage,
  });

  return saveSearchState(context, channelId, state);
}

async function removeSearchCandidate(context, channelId, videoId) {
  const previous = cachedSearchState(
    await readCache(context, "searchState", channelId),
  );

  if (!previous?.pendingCandidates.some((entry) => entry.videoId === videoId)) {
    return previous;
  }

  return saveSearchState(
    context,
    channelId,
    searchStateRecord(previous, {
      pendingCandidates: previous.pendingCandidates.filter(
        (entry) => entry.videoId !== videoId,
      ),
    }),
  );
}

async function inspectPendingSearchCandidates(
  context,
  channel,
  apiKey,
  excludedIds = [],
) {
  const previous = cachedSearchState(
    await readCache(context, "searchState", channel.channelId),
  );

  if (!previous) {
    return { candidateVideoId: null, videosVerified: 0 };
  }

  const now = Date.now();
  const retainedCandidates = retainSearchCandidates(
    previous.pendingCandidates,
    now,
  );
  const excluded = new Set(excludedIds);
  const dueCandidates = retainedCandidates
    .filter(
      (entry) =>
        !excluded.has(entry.videoId) && searchCandidateIsDue(entry, now),
    )
    .slice(0, MAX_PENDING_SEARCH_CANDIDATES);

  if (!dueCandidates.length) {
    if (retainedCandidates.length !== previous.pendingCandidates.length) {
      await saveSearchState(
        context,
        channel.channelId,
        searchStateRecord(previous, { pendingCandidates: retainedCandidates }),
      );
    }

    return { candidateVideoId: null, videosVerified: 0 };
  }

  const videoIds = dueCandidates.map((entry) => entry.videoId);
  const videos = await videosById(videoIds, apiKey);
  const inspection = inspectSearchMetadata(
    videoIds,
    videos,
    channel.channelId,
    retainedCandidates,
    now,
  );

  await saveSearchState(
    context,
    channel.channelId,
    searchStateRecord(previous, {
      pendingCandidates: inspection.pendingCandidates,
    }),
  );

  if (inspection.candidateVideoId) {
    await clearSearchState(
      context,
      channel.channelId,
      inspection.pendingCandidates,
    );
  }

  return inspection;
}

async function inspectUploads(context, channel, apiKey) {
  const uploadIds = await latestUploadIds(channel.uploadsPlaylistId, apiKey);
  const previous = cachedUploadsState(
    await readCache(context, "uploadsState", channel.channelId),
  );
  const now = Date.now();
  const fingerprint = uploadFingerprint(uploadIds);
  const uploadsChanged = !previous || previous.fingerprint !== fingerprint;
  const previousIds = new Set(previous?.uploadIds || []);
  const currentIds = new Set(uploadIds);
  const previousMetadata = previous?.metadata || [];
  const previousMetadataById = metadataMap(previousMetadata);
  const metadataById = new Map(previousMetadataById);

  for (const videoId of uploadIds) {
    const previousEntry = metadataById.get(videoId);
    metadataById.set(
      videoId,
      previousEntry
        ? { ...previousEntry, lastSeenAt: now }
        : unknownMetadata(videoId, now),
    );
  }

  const newUploadIds = uploadIds.filter((videoId) => !previousIds.has(videoId));
  const retainedIds = new Set(
    previousMetadata
      .filter((entry) => isRetainedMetadata(entry, currentIds, now))
      .map((entry) => entry.videoId),
  );
  const eligibleIds = new Set([...currentIds, ...retainedIds]);
  const pendingIds = previous?.pendingIds || [];
  const missingMetadataIds = uploadIds.filter(
    (videoId) => !previousMetadataById.has(videoId),
  );
  const candidateIds = previousMetadata
    .filter(
      (entry) =>
        ["live", "upcoming", "unknown", "missing"].includes(entry.state) &&
        metadataIsDue(entry, now),
    )
    .map((entry) => entry.videoId);
  const dueOrdinaryIds = previousMetadata
    .filter((entry) => entry.state === "ordinary" && metadataIsDue(entry, now))
    .map((entry) => entry.videoId);
  const forcedIds = new Set([
    ...newUploadIds,
    ...pendingIds,
    ...missingMetadataIds,
  ]);
  const orderedMetadataIds = previous
    ? [
        // Deferred work must precede candidates that are due on every check.
        ...pendingIds,
        ...newUploadIds,
        ...candidateIds,
        ...missingMetadataIds,
        ...dueOrdinaryIds,
      ]
    : uploadIds;
  const metadataIds = Array.from(new Set(orderedMetadataIds)).filter(
    (videoId) =>
      eligibleIds.has(videoId) &&
      (forcedIds.has(videoId) || metadataIsDue(metadataById.get(videoId), now)),
  );
  const videoIdsToVerify = metadataIds.slice(0, MAX_METADATA_BATCH_SIZE);
  const deferredMetadataIds = metadataIds.slice(
    MAX_METADATA_BATCH_SIZE,
    MAX_METADATA_BATCH_SIZE + MAX_PENDING_METADATA,
  );
  const videos = videoIdsToVerify.length
    ? await videosById(videoIdsToVerify, apiKey)
    : [];
  const snapshots = videoSnapshots(
    videoIdsToVerify,
    videos,
    channel.channelId,
  );

  for (const videoId of videoIdsToVerify) {
    const snapshot = snapshots.get(videoId);
    const previousEntry = metadataById.get(videoId);

    if (snapshot) {
      metadataById.set(videoId, {
        ...snapshot,
        lastSeenAt: currentIds.has(videoId)
          ? now
          : previousEntry?.lastSeenAt || now,
        missingChecks: 0,
        nextCheckAt: null,
        verifiedAt: now,
      });
      continue;
    }

    const missingChecks = Math.min(
      (previousEntry?.missingChecks || 0) + 1,
      MAX_MISSING_METADATA_CHECKS,
    );
    metadataById.set(videoId, {
      actualEndTime: null,
      actualStartTime: null,
      lastSeenAt: currentIds.has(videoId)
        ? now
        : previousEntry?.lastSeenAt || now,
      missingChecks,
      nextCheckAt:
        missingChecks >= MAX_MISSING_METADATA_CHECKS
          ? now + ORDINARY_METADATA_REFRESH_MS
          : null,
      scheduledStartTime: null,
      state: "missing",
      videoId,
      verifiedAt: now,
    });
  }

  const currentMetadata = uploadIds.map((videoId) => metadataById.get(videoId));
  const retainedMetadata = Array.from(metadataById.values())
    .filter((entry) => isRetainedMetadata(entry, currentIds, now))
    .sort((first, second) => second.lastSeenAt - first.lastSeenAt)
    .slice(0, MAX_RETAINED_CANDIDATES);
  const metadata = dedupeMetadata([...currentMetadata, ...retainedMetadata]);
  const candidates = metadata.filter((entry) =>
    ["live", "upcoming"].includes(entry.state),
  );
  const previousMetadataMap = metadataMap(previousMetadata);
  const nextMetadataMap = metadataMap(metadata);
  const metadataIdsToCompare = new Set([
    ...previousMetadataMap.keys(),
    ...nextMetadataMap.keys(),
  ]);
  const candidateChanged = Array.from(metadataIdsToCompare).some(
    (videoId) =>
      candidateSignature(previousMetadataMap.get(videoId)) !==
      candidateSignature(nextMetadataMap.get(videoId)),
  );
  const upcomingCandidateChecked =
    videoIdsToVerify.some(
      (videoId) => previousMetadataMap.get(videoId)?.state === "upcoming",
    ) ||
    Array.from(snapshots.values()).some(
      (snapshot) => snapshot.state === "upcoming",
    );
  let candidateVideoId = null;

  for (const videoId of videoIdsToVerify) {
    if (snapshots.get(videoId)?.state === "live") {
      candidateVideoId = videoId;
      break;
    }
  }

  await writeCache(
    context,
    "uploadsState",
    channel.channelId,
    {
      candidates,
      fingerprint,
      metadata,
      pendingIds: deferredMetadataIds.filter((videoId) =>
        metadata.some((entry) => entry.videoId === videoId),
      ),
      uploadIds,
    },
    CACHE_TTL.uploadsState,
  );

  return {
    activityDetected: Boolean(
      previous && (uploadsChanged || candidateChanged),
    ),
    candidateChanged,
    candidateVideoId,
    upcomingCandidateChecked,
    uploadsChanged,
    uploadsChecked: uploadIds.length,
    videosVerified: snapshots.size,
  };
}

async function resolveFromUploadsForChannel(
  context,
  handle,
  apiKey,
  channel,
  source,
  searchDetails,
  options = {},
) {
  const inspection = await inspectUploads(context, channel, apiKey);
  const pendingInspection = inspection.candidateVideoId
    ? { candidateVideoId: null, videosVerified: 0 }
    : await inspectPendingSearchCandidates(
        context,
        channel,
        apiKey,
        options.skipSearchCandidateIds || [],
      );
  const candidateVideoId =
    inspection.candidateVideoId || pendingInspection.candidateVideoId;
  const activitySearchState = inspection.activityDetected
    ? await resetSearchBackoffOnActivity(context, channel.channelId)
    : null;
  const resultDetails = {
    ...searchDetails,
    ...(activitySearchState
      ? {
          nextSearchAt: activitySearchState.nextSearchAt,
          searchBackoffStage: activitySearchState.stage,
      }
      : {}),
    channelId: channel.channelId,
    candidateVideoId,
    liveCandidateFound: Boolean(candidateVideoId),
    upcomingCandidateChecked: inspection.upcomingCandidateChecked,
    uploadsChanged: inspection.uploadsChanged,
    uploadsChecked: inspection.uploadsChecked,
    videosVerified:
      inspection.videosVerified + pendingInspection.videosVerified,
  };

  if (candidateVideoId) {
    const result = await storeLiveResult(
      context,
      handle,
      candidateVideoId,
    );
    logResult(context, source, result, resultDetails);
    return result;
  }

  const result = await storeOfflineResult(context, handle);
  logResult(context, source, result, {
    ...resultDetails,
    liveCandidateFound: false,
  });
  return result;
}

async function resolveFromUploads(
  context,
  handle,
  apiKey,
  channel,
  source = "uploads-playlist",
  searchDetails = {},
  options = {},
) {
  try {
    return await resolveFromUploadsForChannel(
      context,
      handle,
      apiKey,
      channel,
      source,
      searchDetails,
      options,
    );
  } catch (error) {
    if (!isMissingUploadsPlaylist(error)) {
      throw error;
    }

    // Bypass even a stale shared cache whose delete failed; refresh only once.
    channel = await resolveChannel(context, handle, apiKey, true);

    try {
      return await resolveFromUploadsForChannel(
        context,
        handle,
        apiKey,
        channel,
        source,
        searchDetails,
        options,
      );
    } catch (freshError) {
      if (isMissingUploadsPlaylist(freshError)) {
        throw channelUnavailableError("playlistItems.list", "playlistNotFound");
      }

      throw freshError;
    }
  }
}

async function resolveLiveVideo(context, handle, apiKey) {
  const unavailable = cachedCooldown(
    await readCache(context, "unavailable", handle),
  );

  if (unavailable?.code === "youtube_channel_unavailable") {
    throwCooldown(unavailable);
  }

  const now = Date.now();
  const cached = cachedResolution(
    await readCache(context, "result", handle),
    now,
  );

  if (cached) {
    return cached;
  }

  const offlineState = cachedOfflineState(
    await readCache(context, "offlineState", handle),
  );
  const scheduledOffline = offlineState
    ? offlineResult(offlineState.nextCheckAt, now)
    : null;

  if (scheduledOffline) {
    return scheduledOffline;
  }

  const generalCooldown = await activeGeneralCooldown(context);

  if (generalCooldown) {
    throwCooldown(generalCooldown);
  }

  const channelCooldown = cachedCooldown(
    await readCache(context, "channelTemporaryCooldown", handle),
  );

  if (channelCooldown) {
    throwCooldown(channelCooldown);
  }

  if (!apiKey) {
    throw configurationError("configuration");
  }

  const channel = await resolveChannel(context, handle, apiKey);

  const knownLive = await readCache(context, "known-live", handle);
  const knownVideoId = isVideoId(knownLive?.videoId) ? knownLive.videoId : null;

  if (knownVideoId) {
    const knownVideos = await videosById([knownVideoId], apiKey);
    const knownVideo = knownVideos.find((video) => video.id === knownVideoId);
    const knownSnapshot = knownVideo
      ? videoSnapshots([knownVideoId], knownVideos, channel.channelId).get(
          knownVideoId,
        )
      : null;

    if (knownSnapshot?.state === "live") {
      const previousSearchState = cachedSearchState(
        await readCache(context, "searchState", channel.channelId),
      );
      await clearSearchState(
        context,
        channel.channelId,
        (previousSearchState?.pendingCandidates || []).filter(
          (entry) => entry.videoId !== knownVideoId,
        ),
      );
      const result = await storeLiveResult(context, handle, knownVideoId);
      logResult(context, "known-live-cache", result, {
        candidateVideoId: knownVideoId,
        channelId: channel.channelId,
        liveCandidateFound: true,
        searchAttempted: false,
      });
      return result;
    }

    const ownershipIsKnown =
      !knownVideo || knownVideo.snippet?.channelId === channel.channelId;
    const metadataIsUncertain =
      !knownVideo ||
      !knownSnapshot ||
      ["unknown", "upcoming"].includes(knownSnapshot.state);

    if (ownershipIsKnown && metadataIsUncertain) {
      await retainSearchCandidatesForRetry(
        context,
        channel.channelId,
        [knownVideoId],
      );
      // Transfer uncertain metadata to bounded pending retries once. Leaving
      // this ID in known-live would renew its search deadline on every check.
      // Write an invalidation marker so a failed delete cannot resurrect it.
      await writeCache(
        context,
        "known-live",
        handle,
        { videoId: null },
        CACHE_TTL.knownLive,
      );
      return resolveFromUploads(
        context,
        handle,
        apiKey,
        channel,
        "known-live-uncertain-uploads",
        {
          nextSearchAt: null,
          searchAttempted: false,
          searchBackoffStage: null,
          searchSkippedReason: "known-live-uncertain",
        },
        { skipSearchCandidateIds: [knownVideoId] },
      );
    }

    await removeSearchCandidate(context, channel.channelId, knownVideoId);
    await deleteCache(context, "known-live", handle);
  }

  const searchDisabledValue = await readCache(
    context,
    "searchDisabled",
    GLOBAL_CACHE_KEY,
  );
  const searchDisabled =
    cachedCooldown(searchDisabledValue) || searchDisabledValue?.active === true;

  if (searchDisabled) {
    return resolveFromUploads(
      context,
      handle,
      apiKey,
      channel,
      "search-quota-disabled-uploads",
      {
        nextSearchAt: null,
        searchAttempted: false,
        searchBackoffStage: null,
        searchSkippedReason: "quota-disabled",
      },
    );
  }

  const searchTemporary = await activeCooldown(
    context,
    "searchTemporary",
    channel.channelId,
  );

  if (searchTemporary) {
    return resolveFromUploads(
      context,
      handle,
      apiKey,
      channel,
      "search-temporary-uploads",
      {
        nextSearchAt: null,
        searchAttempted: false,
        searchBackoffStage: null,
        searchSkippedReason: "temporary-cooldown",
      },
    );
  }

  const searchState = cachedSearchState(
    await readCache(context, "searchState", channel.channelId),
  );

  if (searchState && searchState.nextSearchAt > now) {
    return resolveFromUploads(
      context,
      handle,
      apiKey,
      channel,
      "search-backoff-uploads",
      {
        nextSearchAt: searchState.nextSearchAt,
        searchAttempted: false,
        searchBackoffStage: searchState.stage,
        searchSkippedReason: "backoff",
      },
    );
  }

  const searchClient = context.request.headers.get("CF-Connecting-IP");

  if (
    searchClient &&
    (await readCache(context, "searchClientCooldown", searchClient)) !== null
  ) {
    return resolveFromUploads(
      context,
      handle,
      apiKey,
      channel,
      "search-client-throttled-uploads",
      {
        nextSearchAt: searchState?.nextSearchAt || null,
        searchAttempted: false,
        searchBackoffStage: searchState?.stage ?? null,
        searchSkippedReason: "client-cooldown",
      },
    );
  }

  const pendingSearchInspection = await inspectPendingSearchCandidates(
    context,
    channel,
    apiKey,
  );

  if (pendingSearchInspection.candidateVideoId) {
    const result = await storeLiveResult(
      context,
      handle,
      pendingSearchInspection.candidateVideoId,
    );
    logResult(context, "pending-search-candidate", result, {
      candidateVideoId: pendingSearchInspection.candidateVideoId,
      channelId: channel.channelId,
      liveCandidateFound: true,
      searchAttempted: false,
      videosVerified: pendingSearchInspection.videosVerified,
    });
    return result;
  }

  if (searchClient) {
    await writeCache(
      context,
      "searchClientCooldown",
      searchClient,
      { active: true },
      CACHE_TTL.searchClientCooldown,
    );
  }

  let searchVideoIds;

  try {
    searchVideoIds = await searchLiveVideoIds(channel.channelId, apiKey);
  } catch (error) {
    const searchStage = isSearchListStage(error?.stage);
    const quotaExceeded = searchStage && isDailyQuotaError(error);

    if (!quotaExceeded && searchClient) {
      await deleteCache(context, "searchClientCooldown", searchClient);
    }

    if (!searchStage) {
      throw error;
    }

    if (isConfigurationError(error)) {
      throw error;
    }

    if (!quotaExceeded && !isTemporaryError(error)) {
      throw error;
    }

    const cooldown = quotaExceeded
      ? await establishCooldown(context, "searchDisabled", {
          code: "youtube_search_quota_exceeded",
          reason: safeLogToken(error.reason),
          retryAt: nextPacificQuotaReset(),
          stage: "search.list",
          status: error.status,
        })
      : await establishCooldown(context, "searchTemporary", {
          code: "youtube_search_unavailable",
          reason: safeLogToken(error.reason),
          retryAt: Date.now() + TEMPORARY_COOLDOWN_MS,
          stage: safeLogToken(error.stage) || "search.list",
          status: Number.isInteger(error.status) ? error.status : null,
        }, channel.channelId);

    logWarningOnce(
      context,
      `search-${channel.channelId}-${cooldown.code}-` +
        `${cooldown.reason || "unknown"}`,
      quotaExceeded
        ? "[youtube-live] search.list quota exhausted; using uploads fallback."
        : "[youtube-live] search.list unavailable; using uploads fallback.",
      {
        channelId: channel.channelId,
        reason: cooldown.reason,
        retryAt: cooldown.retryAt,
        stage: cooldown.stage,
        status: cooldown.status,
      },
    );

    return resolveFromUploads(
      context,
      handle,
      apiKey,
      channel,
      quotaExceeded
        ? "search-quota-disabled-uploads"
        : "search-temporary-uploads",
      {
        nextSearchAt: searchState?.nextSearchAt || null,
        searchAttempted: true,
        searchBackoffStage: searchState?.stage ?? 0,
        searchFailed: true,
        searchSkippedReason: quotaExceeded
          ? "quota-exhausted"
          : "temporary-failure",
      },
    );
  }

  let searchVideos;

  try {
    searchVideos = await videosById(searchVideoIds, apiKey);
  } catch (error) {
    if (isChannelDiscoveryStage(error?.stage) && searchVideoIds.length) {
      await retainSearchCandidatesForRetry(
        context,
        channel.channelId,
        searchVideoIds,
        { advanceStage: true, searchAttempted: true },
      );
    }

    throw error;
  }

  const latestSearchState = cachedSearchState(
    await readCache(context, "searchState", channel.channelId),
  );
  let searchInspection;

  try {
    searchInspection = searchVideoIds.length
      ? inspectSearchMetadata(
          searchVideoIds,
          searchVideos,
          channel.channelId,
          latestSearchState?.pendingCandidates || [],
        )
      : {
          candidateVideoId: null,
          pendingCandidates: latestSearchState?.pendingCandidates || [],
          videosVerified: 0,
        };
  } catch (error) {
    if (isChannelDiscoveryStage(error?.stage) && searchVideoIds.length) {
      await retainSearchCandidatesForRetry(
        context,
        channel.channelId,
        searchVideoIds,
        { advanceStage: true, searchAttempted: true },
      );
    }

    throw error;
  }

  if (searchInspection.candidateVideoId) {
    await clearSearchState(
      context,
      channel.channelId,
      searchInspection.pendingCandidates,
    );
    const result = await storeLiveResult(
      context,
      handle,
      searchInspection.candidateVideoId,
    );
    logResult(context, "search-list", result, {
      channelId: channel.channelId,
      candidateVideoId: searchInspection.candidateVideoId,
      liveCandidateFound: true,
      nextSearchAt: null,
      searchAttempted: true,
      searchBackoffStage: searchState?.stage ?? 0,
      searchCandidatesChecked: searchVideoIds.length,
      videosVerified: searchVideos.length,
    });
    return result;
  }

  const nextSearchState = await storeSearchMiss(
    context,
    channel.channelId,
    searchInspection.pendingCandidates,
  );
  return resolveFromUploads(
    context,
    handle,
    apiKey,
    channel,
    "search-result-miss-uploads",
    {
      nextSearchAt: nextSearchState.nextSearchAt,
      searchAttempted: true,
      searchBackoffStage: nextSearchState.stage,
      searchCandidatesChecked: searchVideoIds.length,
      searchResult: "miss",
      searchVideosVerified: searchVideos.length,
    },
    { skipSearchCandidateIds: searchVideoIds },
  );
}

async function resolveWithFailureHandling(context, handle, apiKey) {
  try {
    return await resolveLiveVideo(context, handle, apiKey);
  } catch (error) {
    if (error?.name === "YouTubeDiscoveryError") {
      throw error;
    }

    if (error?.name === "YouTubeChannelUnavailableError") {
      const unavailable = {
        code: "youtube_channel_unavailable",
        reason: safeLogToken(error.reason),
        retryAt: Date.now() + CACHE_TTL.unavailable * 1000,
        stage: safeLogToken(error.stage) || "unknown",
      };

      await writeCache(
        context,
        "unavailable",
        handle,
        unavailable,
        CACHE_TTL.unavailable,
      );
      await Promise.all(
        [
          "result",
          "offlineState",
          "known-live",
          "channel",
          "channelTemporaryCooldown",
        ].map(
          (kind) => deleteCache(context, kind, handle),
        ),
      );
      console.warn(
        "[youtube-live] Channel unavailable",
        diagnosticDetails(context, {
          reason: unavailable.reason,
          stage: unavailable.stage,
        }),
      );
      throwCooldown(unavailable);
    }

    const stage = safeLogToken(error?.stage) || "unknown";
    const status = Number.isInteger(error?.status) ? error.status : null;
    const reason = safeLogToken(error?.reason);
    let code = "youtube_upstream_unavailable";
    let retryAt = Date.now() + TEMPORARY_COOLDOWN_MS;
    const channelScoped =
      isTemporaryError(error) && isChannelDiscoveryStage(error?.stage);

    if (
      isDailyQuotaError(error) &&
      ["channels.list", "playlistItems.list", "videos.list"].includes(stage)
    ) {
      code = "youtube_quota_exceeded";
      retryAt = nextPacificQuotaReset();
    } else if (isConfigurationError(error)) {
      code = "youtube_configuration_error";
      retryAt = Date.now() + CONFIGURATION_COOLDOWN_MS;
    }

    const cooldown = channelScoped
      ? await establishCooldown(
          context,
          "channelTemporaryCooldown",
          {
            code,
            reason,
            retryAt,
            stage,
            status,
          },
          handle,
        )
      : await establishGeneralCooldown(context, {
          code,
          reason,
          retryAt,
          stage,
          status,
        });

    logWarningOnce(
      context,
      `${channelScoped ? "channel" : "general"}-${handle}-` +
        `${cooldown.code}-${cooldown.stage}-${cooldown.reason || "unknown"}`,
      channelScoped
        ? "[youtube-live] Channel discovery cooldown established."
        : "[youtube-live] Discovery cooldown established.",
      {
        code: cooldown.code,
        reason: cooldown.reason,
        retryAt: cooldown.retryAt,
        scope: channelScoped ? "channel" : "global",
        stage: cooldown.stage,
        status: cooldown.status,
        temporary: isTemporaryError(error),
      },
    );
    throwCooldown(cooldown);
  }
}

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const handle = normalizeHandle(requestUrl.searchParams.get("handle"));

  if (!handle) {
    return jsonResponse({ error: "Missing or invalid YouTube handle." }, 400);
  }

  const apiKey = String(context.env?.YOUTUBE_API_KEY || "").trim();
  const resolutionKey = handle.toLowerCase();
  let resolutionPromise = inFlightResolutions.get(resolutionKey);

  if (!resolutionPromise) {
    resolutionPromise = resolveWithFailureHandling(context, handle, apiKey);
    inFlightResolutions.set(resolutionKey, resolutionPromise);
  }

  try {
    const result = await resolutionPromise;
    return jsonResponse(
      result,
      200,
      result.live === false ? result.retryAfterMs : null,
    );
  } catch (error) {
    const retryAfterMs = Math.max(
      1000,
      Number(error?.retryAt || 0) - Date.now(),
    );
    const code =
      typeof error?.code === "string"
        ? error.code
        : "youtube_upstream_unavailable";
    const message = cooldownMessage(code);

    return jsonResponse(
      { code, error: message, retryAfterMs },
      code === "youtube_channel_unavailable" ? 410 : 503,
      retryAfterMs,
    );
  } finally {
    if (inFlightResolutions.get(resolutionKey) === resolutionPromise) {
      inFlightResolutions.delete(resolutionKey);
    }
  }
}
