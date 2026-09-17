import { BROWSER_AI_MODELS, type BrowserAiModelProfile, type BrowserAiTier } from "./browser-ai-protocol";

/**
 * Which model this device may load — decided before anything is downloaded or
 * allocated.
 *
 * The failure this guards against is not a failed download: on a 16 GB laptop
 * with an integrated GPU the weights arrived and the renderer was killed while
 * the engine allocated them, and on 8 GB machines the whole desktop stalls.
 * Loading the large model first and falling back after that happens is not a
 * recovery — the machine is already gone — so the choice is made from what the
 * browser will tell us up front.
 *
 * What the browser actually offers is weak: `navigator.deviceMemory` is
 * rounded to a power of two and **clamped to 8 GiB**, so an 8 GB machine and a
 * 32 GB machine both report 8. It can prove a device is small; it can never
 * prove one is large. The adapter limits say nothing about system memory
 * either — Chrome reports the same 2 GiB `maxBufferSize` on this hardware
 * regardless of how much RAM is installed.
 *
 * So the policy is: believe the signal when it says "small", never infer
 * "large" from a capped value, and let the operator opt into the standard
 * model when they know their machine. Automatic selection is conservative;
 * `preference` is the explicit human answer and wins, except where a signal
 * proves the standard model cannot fit.
 */
export interface DeviceSignals {
  /** `navigator.deviceMemory`, in GiB. Absent when the browser withholds it. */
  deviceMemoryGb?: number;
  /** `GPUAdapter.limits.maxBufferSize`, in bytes. */
  maxBufferSize?: number;
  /** `GPUAdapter.limits.maxStorageBufferBindingSize`, in bytes. */
  maxStorageBufferBindingSize?: number;
}

export interface BrowserAiModelDecision {
  profile: BrowserAiModelProfile;
  /** Whether the tier came from the device signals or from the operator. */
  source: "signals" | "preference";
  /** Why this tier, in one line, for the console and the diagnostics artifact. */
  reason: string;
  /** True when the standard model is known not to fit, so it is not offered. */
  standardBlocked: boolean;
}

/** The largest single weight buffer the engine binds, with headroom. */
function fitsAdapter(profile: BrowserAiModelProfile, signals: DeviceSignals): boolean {
  const binding = signals.maxStorageBufferBindingSize ?? signals.maxBufferSize;
  if (binding === undefined) return true;
  // Weights are bound in shards, so the ceiling that matters is a shard, not
  // the whole model; a binding smaller than a quarter of the model cannot
  // hold one.
  return binding >= (profile.vramRequiredMb / 4) * 1024 * 1024;
}

/**
 * Headroom, not capacity: the engine reserves `vramRequiredMb` of device
 * memory, and on an integrated GPU that is system RAM shared with the OS, the
 * browser and the document worker. Three times the working set is what
 * separates a machine that loads the standard model from one whose desktop
 * stalls while it allocates.
 */
const HEADROOM_FACTOR = 3;

/**
 * `navigator.deviceMemory` is rounded to a power of two, and some browsers
 * clamp it to 8 GiB. A report above the clamp is evidence of real headroom; a
 * report at the clamp proves nothing on its own, because an 8 GiB machine and
 * a clamped 32 GiB machine read the same.
 */
const CLAMP_GB = 8;

export function resolveBrowserAiModel(
  signals: DeviceSignals,
  preference?: BrowserAiTier,
): BrowserAiModelDecision {
  const standard = BROWSER_AI_MODELS.standard;
  const light = BROWSER_AI_MODELS.light;
  const memoryGb = signals.deviceMemoryGb;
  const requiredGb = (standard.vramRequiredMb * HEADROOM_FACTOR) / 1024;

  if (memoryGb !== undefined && memoryGb < requiredGb) {
    return {
      profile: light,
      source: "signals",
      reason: `device reports ${memoryGb} GiB, below the ${requiredGb.toFixed(1)} GiB the standard model needs to load safely`,
      standardBlocked: true,
    };
  }
  if (!fitsAdapter(standard, signals)) {
    return {
      profile: light,
      source: "signals",
      reason: "the graphics adapter cannot bind a buffer large enough for the standard model",
      standardBlocked: true,
    };
  }
  if (preference) {
    return {
      profile: BROWSER_AI_MODELS[preference],
      source: "preference",
      reason: `operator selected the ${preference} model`,
      standardBlocked: false,
    };
  }
  if (memoryGb !== undefined && memoryGb > CLAMP_GB) {
    return {
      profile: standard,
      source: "signals",
      reason: `device reports ${memoryGb} GiB, above the ${CLAMP_GB} GiB reporting clamp, so the headroom is measured rather than assumed`,
      standardBlocked: false,
    };
  }
  // At the clamp, or with no report at all, and nobody has answered: an 8 GiB
  // machine and a clamped larger one read the same, and guessing high costs a
  // frozen desktop, so the smaller model runs until someone says otherwise.
  return {
    profile: light,
    source: "signals",
    reason: memoryGb === undefined
      ? "the browser reports no memory signal, so the smaller model is used until asked otherwise"
      : `device memory reads ${memoryGb} GiB, at or below the reporting clamp, so headroom cannot be proven`,
    standardBlocked: false,
  };
}
