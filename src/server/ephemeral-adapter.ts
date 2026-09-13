export const EPHEMERAL_RETENTION_MS = 30 * 60 * 1000;
export const TAB_LEASE_MS = 90 * 1000;
export const JOB_LEASE_MS = 60 * 1000;

export type EphemeralAdapterKind = "memory-local" | "valkey-s3";

export type OwnerScope = {
  principalKey: string;
  generation: string;
};

/**
 * Values that every state, queue, and blob operation must carry and verify.
 * `committedExpiresAt` is the only authorization and purge-eligibility deadline.
 */
export type EphemeralFence = OwnerScope & {
  fence: number;
  committedExpiresAt: number;
  tombstonedAt?: number;
};

export type EphemeralAdapterCapabilities = {
  credentialMapping: true;
  physicalRetention: true;
  reconciliationClaims: true;
  conditionalMaxTtl: true;
  atomicQueueClaim: true;
  monotonicFence: true;
  tombstoneDominance: true;
  generationRejection: true;
  idempotentEnqueue: true;
  cursorEnumeration: true;
  markerCompareAndSwap: true;
  strongBlobReadAfterWrite: true;
  blobMetadataRead: true;
  multipartAbort: true;
  blobRangeRead: true;
  idempotentBlobDelete: true;
};

export type EphemeralAdapterProfile = {
  kind: EphemeralAdapterKind;
  capabilities: EphemeralAdapterCapabilities;
  state: {
    url: string;
    tls: true;
    persistenceDisabled: true;
    backupDisabled: true;
    queue: "streams";
  };
  blobs: {
    endpoint: string;
    bucket: string;
    tls: true;
    versioningDisabled: true;
    backupDisabled: true;
  };
};

export type CommittedExpiry = {
  expiresAt: number;
  commitId: string;
};

export type PendingExpiry = {
  expiresAt: number;
  nonce: string;
  baseCommitId: string;
  createdAt: number;
};

/** The object-store marker is authoritative; state-store expiry is only a mirror. */
export type EphemeralMarker = {
  generation: string;
  committed: CommittedExpiry;
  pending?: PendingExpiry;
  tombstonedAt?: number;
};

export type EphemeralStateQueueAdapter = {
  readonly capabilities: EphemeralAdapterCapabilities;
  claim(owner: OwnerScope, fence: number): Promise<EphemeralFence>;
  commit(fence: EphemeralFence): Promise<void>;
  tombstone(owner: OwnerScope): Promise<void>;
};

export type EphemeralBlobAdapter = {
  readonly capabilities: Pick<
    EphemeralAdapterCapabilities,
    "markerCompareAndSwap" | "strongBlobReadAfterWrite" | "blobMetadataRead" | "multipartAbort" | "blobRangeRead" | "idempotentBlobDelete"
  >;
  readMarker(owner: OwnerScope): Promise<EphemeralMarker>;
  compareAndSwapMarker(owner: OwnerScope, marker: EphemeralMarker, version: string): Promise<string>;
};

export class EphemeralAdapterConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EphemeralAdapterConfigurationError";
  }
}

const requiredCapabilities: EphemeralAdapterCapabilities = {
  credentialMapping: true,
  physicalRetention: true,
  reconciliationClaims: true,
  conditionalMaxTtl: true,
  atomicQueueClaim: true,
  monotonicFence: true,
  tombstoneDominance: true,
  generationRejection: true,
  idempotentEnqueue: true,
  cursorEnumeration: true,
  markerCompareAndSwap: true,
  strongBlobReadAfterWrite: true,
  blobMetadataRead: true,
  multipartAbort: true,
  blobRangeRead: true,
  idempotentBlobDelete: true,
};

export function assertEphemeralCapabilities(
  capabilities: Partial<EphemeralAdapterCapabilities>,
): asserts capabilities is EphemeralAdapterCapabilities {
  for (const [name, required] of Object.entries(requiredCapabilities)) {
    if (required && capabilities[name as keyof EphemeralAdapterCapabilities] !== true) {
      throw new EphemeralAdapterConfigurationError(`Required ephemeral capability is unavailable: ${name}.`);
    }
  }
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new EphemeralAdapterConfigurationError(`${name} must be configured in production.`);
  return value;
}

function requiredFlag(name: string, value: string | undefined): true {
  if (value !== "true") throw new EphemeralAdapterConfigurationError(`${name}=true is required in production.`);
  return true;
}

function requiredChoice<T extends string>(name: string, value: string | undefined, expected: T): T {
  if (value !== expected) throw new EphemeralAdapterConfigurationError(`${name}=${expected} is required in production.`);
  return expected;
}

function secureUrl(name: string, value: string, protocols: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EphemeralAdapterConfigurationError(`${name} must be an absolute URL.`);
  }
  if (!protocols.includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new EphemeralAdapterConfigurationError(`${name} must use ${protocols.join(" or ")} without embedded credentials.`);
  }
  return url.toString();
}

/**
 * Selects only the production shared adapter profile. This is intentionally a
 * configuration gate, not a local fallback: a caller must supply a concrete
 * Valkey/S3 adapter that implements this profile before it may serve traffic.
 */
export function productionEphemeralAdapterProfile(env: NodeJS.ProcessEnv = process.env): EphemeralAdapterProfile {
  if (env.WORKLENS_EPHEMERAL_ADAPTER !== "valkey-s3") {
    throw new EphemeralAdapterConfigurationError("WORKLENS_EPHEMERAL_ADAPTER=valkey-s3 is required in production.");
  }
  const stateUrl = secureUrl("WORKLENS_VALKEY_URL", required("WORKLENS_VALKEY_URL", env.WORKLENS_VALKEY_URL), ["rediss:"]);
  const endpoint = secureUrl("WORKLENS_BLOB_ENDPOINT", required("WORKLENS_BLOB_ENDPOINT", env.WORKLENS_BLOB_ENDPOINT), ["https:"]);
  const bucket = required("WORKLENS_BLOB_BUCKET", env.WORKLENS_BLOB_BUCKET);

  return {
    kind: "valkey-s3",
    capabilities: requiredCapabilities,
    state: {
      url: stateUrl,
      tls: requiredFlag("WORKLENS_VALKEY_TLS", env.WORKLENS_VALKEY_TLS),
      persistenceDisabled: requiredFlag("WORKLENS_VALKEY_PERSISTENCE_DISABLED", env.WORKLENS_VALKEY_PERSISTENCE_DISABLED),
      backupDisabled: requiredFlag("WORKLENS_VALKEY_BACKUP_DISABLED", env.WORKLENS_VALKEY_BACKUP_DISABLED),
      queue: requiredChoice("WORKLENS_VALKEY_QUEUE", env.WORKLENS_VALKEY_QUEUE, "streams"),
    },
    blobs: {
      endpoint,
      bucket,
      tls: requiredFlag("WORKLENS_BLOB_TLS", env.WORKLENS_BLOB_TLS),
      versioningDisabled: requiredFlag("WORKLENS_BLOB_VERSIONING_DISABLED", env.WORKLENS_BLOB_VERSIONING_DISABLED),
      backupDisabled: requiredFlag("WORKLENS_BLOB_BACKUP_DISABLED", env.WORKLENS_BLOB_BACKUP_DISABLED),
    },
  };
}

export function selectedEphemeralAdapter(env: NodeJS.ProcessEnv = process.env): EphemeralAdapterKind {
  return env.NODE_ENV === "production" ? productionEphemeralAdapterProfile(env).kind : "memory-local";
}

/** Local memory/OS-temp implementation is development and test only. */
export function assertLocalEphemeralAdapterAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "production" && env.WORKLENS_ALLOW_LOCAL_EPHEMERAL !== "true") {
    throw new EphemeralAdapterConfigurationError("The memory/local ephemeral adapter is forbidden in production. Set WORKLENS_ALLOW_LOCAL_EPHEMERAL=true for reference deployments.");
  }
}

export function assertFenceOwner(fence: EphemeralFence, owner: OwnerScope, now = Date.now()): void {
  if (fence.principalKey !== owner.principalKey || fence.generation !== owner.generation) {
    throw new EphemeralAdapterConfigurationError("Owner or store generation does not match the fenced resource.");
  }
  if (!Number.isSafeInteger(fence.fence) || fence.fence < 0) {
    throw new EphemeralAdapterConfigurationError("Fence must be a non-negative safe integer.");
  }
  if (fence.tombstonedAt !== undefined || now >= fence.committedExpiresAt) {
    throw new EphemeralAdapterConfigurationError("Expired or tombstoned resources cannot be authorized.");
  }
}
