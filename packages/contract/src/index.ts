/**
 * @agentoryhq/im-channel-contract
 *
 * ChannelAdapter contract between Agentory's (private) control plane and
 * open-source IM channel adapters. Adapters are loaded by the control plane
 * as pinned npm dependencies and run **inside the control-plane process**;
 * every transport is an outbound long-lived connection or long poll — an
 * adapter MUST NOT open inbound network listeners (no public webhook
 * endpoints in contract v1).
 *
 * Versioning: `ADAPTER_API_VERSION` evolves **additively only** (same policy
 * as @agentoryhq/runtime-contract). Removing/renaming exported members or
 * changing method signatures requires a major bump of this constant and a
 * control-plane migration — avoid it; add optional members instead.
 *
 * Secret hygiene (hard rules, enforced by the contract test suite):
 * - Credential values MUST never appear in thrown error messages, probe
 *   reasons, `InboundMessage.raw`, or any log line an adapter emits.
 * - Adapters read credentials only from the `env` passed to the factory;
 *   they never read process.env directly and never persist credentials.
 */

/** Wire protocol version between the control plane and ChannelAdapter implementations. */
export const ADAPTER_API_VERSION = 1 as const;

/** Stable channel identifier (lowercase snake_case). Open set — community adapters add their own. */
export type ChannelId = string;

/** Well-known channel ids of the official reference implementations. */
export const KnownChannel = {
  Feishu: "feishu",
  DingTalk: "dingtalk",
  Wecom: "wecom",
  WechatPersonal: "wechat_personal",
  Mock: "mock",
} as const;

/** Conversation shape capability declared by an adapter (plain-text era; rich media is a future additive capability). */
export type AdapterCapability = "private" | "group";

export type ConversationType = "private" | "group";

/**
 * Normalized inbound message handed to the control plane.
 *
 * Normalization rules the adapter MUST apply before emitting:
 * - `text` is plain text, trimmed, with the @bot mention prefix stripped
 *   (group messages) — the control plane never sees mention markup.
 * - Group messages that do NOT mention the bot are dropped at the channel
 *   layer (zero emission, zero persistence downstream). Private-chat
 *   messages are always emitted.
 * - `raw` is optional diagnostic payload and MUST NOT contain credentials.
 */
export type InboundMessage = {
  channel: ChannelId;
  /** IM-side user identity (openid / unionid / staffId / …). Opaque to the contract. */
  externalUserId: string;
  /** Display name if cheaply available; never used for authorization. */
  externalUserName?: string;
  /** IM-side conversation identity (group id, or the 1:1 conversation/user key). */
  conversationId: string;
  conversationType: ConversationType;
  /** Channel-side message id — the control plane uses it for idempotent dedupe. */
  messageId: string;
  text: string;
  /** True on every emitted message (non-mention group messages are dropped, see normalization rules). */
  mentionedBot: boolean;
  /** ISO-8601 timestamp of the channel-side event. */
  receivedAt: string;
  /** Optional channel-native event for diagnostics. MUST NOT contain credentials. */
  raw?: unknown;
};

/** Outbound reply the control plane asks the adapter to deliver back into the origin conversation. */
export type OutboundReply = {
  conversationId: string;
  /** Plain text, already clamped to the channel length limit by the caller or by the adapter (set `truncated`). */
  text: string;
  truncated?: boolean;
  replyToMessageId?: string;
};

export type SendResult = {
  /** Channel-side message id of the delivered reply, when obtainable. */
  channelMessageId?: string;
};

/**
 * Credential probing result. Fail-closed by contract: an adapter with
 * missing/invalid credentials reports `{ ok: false, reason }` — it never
 * throws from `probeCredentials` and never echoes credential values in
 * `reason`.
 */
export type CredentialProbe = { ok: true } | { ok: false; reason: string };

export type AdapterConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export type ChannelAdapterErrorCode =
  | "credential_invalid"
  | "not_started"
  | "connection_lost"
  | "send_failed"
  | "rate_limited"
  | "internal";

/** The only error type adapters may reject with. Messages never contain credentials. */
export class ChannelAdapterError extends Error {
  constructor(
    readonly channel: ChannelId,
    readonly code: ChannelAdapterErrorCode,
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(`[${channel}] ${code}: ${message}`);
    this.name = "ChannelAdapterError";
  }
}

/** Callbacks the control plane passes to `start`. */
export type ChannelAdapterEvents = {
  /** One normalized inbound message. Backpressure is the control plane's concern; adapters may await it. */
  onMessage(msg: InboundMessage): void | Promise<void>;
  /** Transport-level failure worth surfacing (state flips are reported via onStateChange). */
  onError?(err: ChannelAdapterError): void;
  /** Connection lifecycle transitions, for the control plane's channel-status surface. */
  onStateChange?(state: AdapterConnectionState): void;
};

/**
 * A channel adapter: thin transport shell around one IM platform's official
 * SDK. All product logic (identity binding, tenant isolation, conversation
 * targeting, auditing, rate limiting, execution) lives in the private
 * control plane — adapters MUST NOT reimplement any of it.
 */
export type ChannelAdapter = {
  readonly channel: ChannelId;
  /** Must equal ADAPTER_API_VERSION of the contract the adapter was built against. */
  readonly apiVersion: typeof ADAPTER_API_VERSION;
  /** Conversation shapes this channel supports (e.g. wechat_personal: ["private"] only). */
  readonly capabilities: readonly AdapterCapability[];

  /**
   * Open the outbound transport and begin emitting events.
   * - Idempotent: a second `start` while running resolves as a no-op.
   * - Rejects with ChannelAdapterError(code=credential_invalid) when
   *   credentials are missing/invalid (fail-closed; never throws synchronously).
   */
  start(events: ChannelAdapterEvents): Promise<void>;

  /** Close the transport. Idempotent; safe to call before `start`. */
  stop(): Promise<void>;

  /**
   * Deliver a reply into a conversation.
   * - Rejects with ChannelAdapterError(code=not_started) before `start`.
   * - Clamps over-length text to the channel limit and sets `truncated`
   *   semantics on the channel side (the caller usually pre-clamps).
   */
  send(reply: OutboundReply): Promise<SendResult>;

  /** Non-destructive credential check (no long-lived connection opened). Never throws. */
  probeCredentials(): Promise<CredentialProbe>;
};

/**
 * Factory the control plane uses for env-driven registration
 * (`buildChannelRegistryFromEnv`, same shape as the billing PayRegistry):
 * incomplete credentials → return `null` (channel not registered, startup
 * never blocked).
 */
export type ChannelAdapterFactory = {
  readonly channel: ChannelId;
  /** Environment variable names this factory reads (documentation/audit aid). */
  readonly envKeys: readonly string[];
  fromEnv(env: Record<string, string | undefined>): ChannelAdapter | null;
};
