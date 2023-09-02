/* Manages OpenAI API keys. Tracks usage, disables expired keys, and provides
round-robin access to keys. Keys are stored in the OPENAI_KEY environment
variable as a comma-separated list of keys. */
import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { KeyProvider, Key, Model } from "../index";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { OpenAIKeyChecker } from "./checker";
import { OpenAIModelFamily, getOpenAIModelFamily } from "../../models";

export type OpenAIModel = "gpt-3.5-turbo" | "gpt-4" | "gpt-4-32k";
export const OPENAI_SUPPORTED_MODELS: readonly OpenAIModel[] = [
  "gpt-3.5-turbo",
  "gpt-4",
] as const;

// Flattening model families instead of using a nested object for easier
// cloning.
type OpenAIKeyUsage = {
  [K in OpenAIModelFamily as `${K}Tokens`]: number;
};

export interface OpenAIKey extends Key, OpenAIKeyUsage {
  readonly service: "openai";
  modelFamilies: OpenAIModelFamily[];
  /**
   * Some keys are assigned to multiple organizations, each with their own quota
   * limits. We clone the key for each organization and track usage/disabled
   * status separately.
   */
  organizationId?: string;
  /** Set when key check returns a 401. */
  isRevoked: boolean;
  /** Set when key check returns a non-transient 429. */
  isOverQuota: boolean;
  /** The time at which this key was last rate limited. */
  rateLimitedAt: number;
  /**
   * Last known X-RateLimit-Requests-Reset header from OpenAI, converted to a
   * number.
   * Formatted as a `\d+(m|s)` string denoting the time until the limit resets.
   * Specifically, it seems to indicate the time until the key's quota will be
   * fully restored; the key may be usable before this time as the limit is a
   * rolling window.
   *
   * Requests which return a 429 do not count against the quota.
   *
   * Requests which fail for other reasons (e.g. 401) count against the quota.
   */
  rateLimitRequestsReset: number;
  /**
   * Last known X-RateLimit-Tokens-Reset header from OpenAI, converted to a
   * number.
   * Appears to follow the same format as `rateLimitRequestsReset`.
   *
   * Requests which fail do not count against the quota as they do not consume
   * tokens.
   */
  rateLimitTokensReset: number;
}

export type OpenAIKeyUpdate = Omit<
  Partial<OpenAIKey>,
  "key" | "hash" | "promptCount"
>;

export class OpenAIKeyProvider implements KeyProvider<OpenAIKey> {
  readonly service = "openai" as const;

  private keys: OpenAIKey[] = [];
  private checker?: OpenAIKeyChecker;
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyString = config.openaiKey?.trim();
    if (!keyString) {
      this.log.warn("OPENAI_KEY is not set. OpenAI API will not be available.");
      return;
    }
    let bareKeys: string[];
    bareKeys = keyString.split(",").map((k) => k.trim());
    bareKeys = [...new Set(bareKeys)];
    for (const k of bareKeys) {
      const newKey: OpenAIKey = {
        key: k,
        service: "openai" as const,
        modelFamilies: ["turbo" as const, "gpt4" as const],
        isTrial: false,
        isDisabled: false,
        isRevoked: false,
        isOverQuota: false,
        lastUsed: 0,
        lastChecked: 0,
        promptCount: 0,
        hash: `oai-${crypto
          .createHash("sha256")
          .update(k)
          .digest("hex")
          .slice(0, 8)}`,
        rateLimitedAt: 0,
        rateLimitRequestsReset: 0,
        rateLimitTokensReset: 0,
        turboTokens: 0,
        gpt4Tokens: 0,
        "gpt4-32kTokens": 0,
      };
      this.keys.push(newKey);
    }
    this.log.info({ keyCount: this.keys.length }, "Loaded OpenAI keys.");
  }

  public init() {
    if (config.checkKeys) {
      const cloneFn = this.clone.bind(this);
      const updateFn = this.update.bind(this);
      this.checker = new OpenAIKeyChecker(this.keys, cloneFn, updateFn);
      this.checker.start();
    }
  }

  /**
   * Returns a list of all keys, with the key field removed.
   * Don't mutate returned keys, use a KeyPool method instead.
   **/
  public list() {
    return this.keys.map((key) => {
      return Object.freeze({
        ...key,
        key: undefined,
      });
    });
  }

  public get(model: Model) {
    const neededFamily = getOpenAIModelFamily(model);
    const availableKeys = this.keys.filter(
      (key) => !key.isDisabled && key.modelFamilies.includes(neededFamily)
    );

    if (availableKeys.length === 0) {
      throw new Error(`No active keys available for ${neededFamily} models.`);
    }

    if (!config.allowedModelFamilies.includes(neededFamily)) {
      throw new Error(
        `Proxy operator has disabled access to ${neededFamily} models.`
      );
    }

    // Select a key, from highest priority to lowest priority:
    // 1. Keys which are not rate limited
    //    a. We ignore rate limits from >30 seconds ago
    //    b. If all keys were rate limited in the last minute, select the
    //       least recently rate limited key
    // 2. Keys which are trials
    // 3. Keys which do *not* have access to GPT-4-32k
    // 4. Keys which have not been used in the longest time

    const now = Date.now();
    const rateLimitThreshold = 30 * 1000;

    const keysByPriority = availableKeys.sort((a, b) => {
      // TODO: this isn't quite right; keys are briefly artificially rate-
      // limited when they are selected, so this will deprioritize keys that
      // may not actually be limited, simply because they were used recently.
      // This should be adjusted to use a new `rateLimitedUntil` field instead
      // of `rateLimitedAt`.
      const aRateLimited = now - a.rateLimitedAt < rateLimitThreshold;
      const bRateLimited = now - b.rateLimitedAt < rateLimitThreshold;

      if (aRateLimited && !bRateLimited) return 1;
      if (!aRateLimited && bRateLimited) return -1;
      if (aRateLimited && bRateLimited) {
        return a.rateLimitedAt - b.rateLimitedAt;
      }
      // Neither key is rate limited, continue

      if (a.isTrial && !b.isTrial) return -1;
      if (!a.isTrial && b.isTrial) return 1;
      // Neither or both keys are trials, continue

      const aHas32k = a.modelFamilies.includes("gpt4-32k");
      const bHas32k = b.modelFamilies.includes("gpt4-32k");
      if (aHas32k && !bHas32k) return 1;
      if (!aHas32k && bHas32k) return -1;
      // Neither or both keys have 32k, continue

      return a.lastUsed - b.lastUsed;
    });

    // logger.debug(
    //   {
    //     byPriority: keysByPriority.map((k) => ({
    //       hash: k.hash,
    //       isRateLimited: now - k.rateLimitedAt < rateLimitThreshold,
    //       modelFamilies: k.modelFamilies,
    //     })),
    //   },
    //   "Keys sorted by priority"
    // );

    const selectedKey = keysByPriority[0];
    selectedKey.lastUsed = now;

    // When a key is selected, we rate-limit it for a brief period of time to
    // prevent the queue processor from immediately flooding it with requests
    // while the initial request is still being processed (which is when we will
    // get new rate limit headers).
    // Instead, we will let a request through every second until the key
    // becomes fully saturated and locked out again.
    selectedKey.rateLimitedAt = now;
    selectedKey.rateLimitRequestsReset = 1000;
    return { ...selectedKey };
  }

  /** Called by the key checker to update key information. */
  public update(keyHash: string, update: OpenAIKeyUpdate) {
    const keyFromPool = this.keys.find((k) => k.hash === keyHash)!;
    Object.assign(keyFromPool, { lastChecked: Date.now(), ...update });
    // this.writeKeyStatus();
  }

  /** Called by the key checker to create clones of keys for the given orgs. */
  public clone(keyHash: string, newOrgIds: string[]) {
    const keyFromPool = this.keys.find((k) => k.hash === keyHash)!;
    const clones = newOrgIds.map((orgId) => {
      const clone: OpenAIKey = {
        ...keyFromPool,
        organizationId: orgId,
        isDisabled: false,
        hash: `oai-${crypto
          .createHash("sha256")
          .update(keyFromPool.key + orgId)
          .digest("hex")
          .slice(0, 8)}`,
        lastChecked: 0, // Force re-check in case the org has different models
      };
      this.log.info(
        { cloneHash: clone.hash, parentHash: keyFromPool.hash, orgId },
        "Cloned organization key"
      );
      return clone;
    });
    this.keys.push(...clones);
  }

  /** Disables a key, or does nothing if the key isn't in this pool. */
  public disable(key: Key) {
    const keyFromPool = this.keys.find((k) => k.hash === key.hash);
    if (!keyFromPool || keyFromPool.isDisabled) return;
    this.update(key.hash, { isDisabled: true });
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public available() {
    return this.keys.filter((k) => !k.isDisabled).length;
  }

  public anyUnchecked() {
    return !!config.checkKeys && this.keys.some((key) => !key.lastChecked);
  }

  /**
   * Given a model, returns the period until a key will be available to service
   * the request, or returns 0 if a key is ready immediately.
   */
  public getLockoutPeriod(model: Model = "gpt-4"): number {
    const neededFamily = getOpenAIModelFamily(model);
    const activeKeys = this.keys.filter(
      (key) => !key.isDisabled && key.modelFamilies.includes(neededFamily)
    );

    if (activeKeys.length === 0) {
      // If there are no active keys for this model we can't fulfill requests.
      // We'll return 0 to let the request through and return an error,
      // otherwise the request will be stuck in the queue forever.
      return 0;
    }

    // A key is rate-limited if its `rateLimitedAt` plus the greater of its
    // `rateLimitRequestsReset` and `rateLimitTokensReset` is after the
    // current time.

    // If there are any keys that are not rate-limited, we can fulfill requests.
    const now = Date.now();
    const rateLimitedKeys = activeKeys.filter((key) => {
      const resetTime = Math.max(
        key.rateLimitRequestsReset,
        key.rateLimitTokensReset
      );
      return now < key.rateLimitedAt + resetTime;
    }).length;
    const anyNotRateLimited = rateLimitedKeys < activeKeys.length;

    if (anyNotRateLimited) {
      return 0;
    }

    // If all keys are rate-limited, return the time until the first key is
    // ready.
    const timeUntilFirstReady = Math.min(
      ...activeKeys.map((key) => {
        const resetTime = Math.max(
          key.rateLimitRequestsReset,
          key.rateLimitTokensReset
        );
        return key.rateLimitedAt + resetTime - now;
      })
    );
    return timeUntilFirstReady;
  }

  public markRateLimited(keyHash: string) {
    this.log.warn({ key: keyHash }, "Key rate limited");
    const key = this.keys.find((k) => k.hash === keyHash)!;
    key.rateLimitedAt = Date.now();
  }

  public incrementUsage(keyHash: string, model: string, tokens: number) {
    const key = this.keys.find((k) => k.hash === keyHash);
    if (!key) return;
    key.promptCount++;
    key[`${getOpenAIModelFamily(model)}Tokens`] += tokens;
  }

  public updateRateLimits(keyHash: string, headers: http.IncomingHttpHeaders) {
    const key = this.keys.find((k) => k.hash === keyHash)!;
    const requestsReset = headers["x-ratelimit-reset-requests"];
    const tokensReset = headers["x-ratelimit-reset-tokens"];

    // Sometimes OpenAI only sends one of the two rate limit headers, it's
    // unclear why.

    if (requestsReset && typeof requestsReset === "string") {
      this.log.info(
        { key: key.hash, requestsReset },
        `Updating rate limit requests reset time`
      );
      key.rateLimitRequestsReset = getResetDurationMillis(requestsReset);
    }

    if (tokensReset && typeof tokensReset === "string") {
      this.log.info(
        { key: key.hash, tokensReset },
        `Updating rate limit tokens reset time`
      );
      key.rateLimitTokensReset = getResetDurationMillis(tokensReset);
    }

    if (!requestsReset && !tokensReset) {
      this.log.warn(
        { key: key.hash },
        `No rate limit headers in OpenAI response; skipping update`
      );
      return;
    }
  }

  public recheck() {
    this.keys.forEach((key) => {
      this.update(key.hash, {
        isRevoked: false,
        isOverQuota: false,
        isDisabled: false,
        lastChecked: 0,
      });
    });
    this.checker?.scheduleNextCheck();
  }

  /** Writes key status to disk. */
  // public writeKeyStatus() {
  //   const keys = this.keys.map((key) => ({
  //     key: key.key,
  //     isGpt4: key.isGpt4,
  //     usage: key.usage,
  //     hardLimit: key.hardLimit,
  //     isDisabled: key.isDisabled,
  //   }));
  //   fs.writeFileSync(
  //     path.join(__dirname, "..", "keys.json"),
  //     JSON.stringify(keys, null, 2)
  //   );
  // }
}

/**
 * Converts reset string ("21.0032s" or "21ms") to a number of milliseconds.
 * Result is clamped to 10s even though the API returns up to 60s, because the
 * API returns the time until the entire quota is reset, even if a key may be
 * able to fulfill requests before then due to partial resets.
 **/
function getResetDurationMillis(resetDuration?: string): number {
  const match = resetDuration?.match(/(\d+(\.\d+)?)(s|ms)/);
  if (match) {
    const [, time, , unit] = match;
    const value = parseFloat(time);
    const result = unit === "s" ? value * 1000 : value;
    return Math.min(result, 10000);
  }
  return 0;
}