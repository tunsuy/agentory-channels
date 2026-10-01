/**
 * @agentoryhq/im-channel-mock
 *
 * Deterministic mock IM channel: the reference implementation of the
 * ChannelAdapter contract and the smoke/dev carrier for the Agentory control
 * plane (same role as the billing mock pay channel and the messaging mock
 * runtime). No network, no real IM accounts.
 *
 * Production is env-gated to zero registration: `fromEnv` returns null unless
 * IM_CHANNEL_MOCK=1.
 */
import {
  ADAPTER_API_VERSION,
  type AdapterCapability,
  type AdapterConnectionState,
  type ChannelAdapter,
  ChannelAdapterError,
  type ChannelAdapterEvents,
  type ChannelAdapterFactory,
  type CredentialProbe,
  type InboundMessage,
  KnownChannel,
  type OutboundReply,
  type SendResult,
} from "@agentoryhq/im-channel-contract";

/** Deterministic inbound event seed (test hook input). */
export type MockInboundSeed = {
  externalUserId: string;
  externalUserName?: string;
  conversationId: string;
  conversationType?: "private" | "group";
  messageId?: string;
  text: string;
  /** Group only: false → dropped at the channel layer (zero emission), per contract normalization rules. */
  mentionedBot?: boolean;
  receivedAt?: string;
  raw?: unknown;
};

export type MockAdapterOptions = {
  /** "invalid" makes probe fail-closed and start reject with credential_invalid. */
  credentials?: "valid" | "invalid";
  /** Fake credential value stored but NEVER echoed anywhere (hygiene sentinel target). */
  secretValue?: string;
};

export const MOCK_ENV_KEY = "IM_CHANNEL_MOCK";
export const MOCK_CREDENTIALS_ENV_KEY = "IM_CHANNEL_MOCK_CREDENTIALS";
export const MOCK_SECRET_ENV_KEY = "IM_CHANNEL_MOCK_SECRET";

/** Text prefixes that make `send` fail deterministically (smoke carriers). */
export const MOCK_FAIL_PREFIX = "MOCK_FAIL:";
export const MOCK_LIMIT_PREFIX = "MOCK_LIMIT:";

export class MockChannelAdapter implements ChannelAdapter {
  readonly channel: string = KnownChannel.Mock;
  readonly apiVersion = ADAPTER_API_VERSION;
  readonly capabilities: readonly AdapterCapability[] = ["private", "group"];

  /** Captured outbound replies (assertion surface). */
  readonly sent: OutboundReply[] = [];

  private events: ChannelAdapterEvents | null = null;
  private started = false;
  private seq = 0;
  /** Stored, never echoed. */
  private readonly secretValue: string | undefined;

  constructor(private readonly opts: MockAdapterOptions = {}) {
    this.secretValue = opts.secretValue;
  }

  async start(events: ChannelAdapterEvents): Promise<void> {
    if (this.opts.credentials === "invalid") {
      throw new ChannelAdapterError(this.channel, "credential_invalid", "mock credentials rejected");
    }
    if (this.started) return; // idempotent
    this.events = events;
    this.started = true;
    events.onStateChange?.("connected");
  }

  async stop(): Promise<void> {
    if (!this.started) return; // idempotent, safe before start
    const events = this.events;
    this.started = false;
    this.events = null;
    events?.onStateChange?.("disconnected");
  }

  async send(reply: OutboundReply): Promise<SendResult> {
    if (!this.started) {
      throw new ChannelAdapterError(this.channel, "not_started", "adapter not started");
    }
    if (reply.text.startsWith(MOCK_FAIL_PREFIX)) {
      throw new ChannelAdapterError(this.channel, "send_failed", reply.text.slice(MOCK_FAIL_PREFIX.length));
    }
    if (reply.text.startsWith(MOCK_LIMIT_PREFIX)) {
      throw new ChannelAdapterError(this.channel, "rate_limited", "channel rate limit hit", true);
    }
    this.sent.push(reply);
    this.seq += 1;
    return { channelMessageId: `mock-out-${this.seq}` };
  }

  async probeCredentials(): Promise<CredentialProbe> {
    if (this.opts.credentials === "invalid") {
      return { ok: false, reason: "mock credentials rejected" };
    }
    return { ok: true };
  }

  // ── Test hooks (deterministic, offline) ──

  /**
   * Inject an inbound event through the same normalization path a real
   * channel uses. Non-mention group messages are dropped (zero emission).
   * Returns the emitted message, or null when dropped.
   */
  async emitInbound(seed: MockInboundSeed): Promise<InboundMessage | null> {
    if (!this.started || !this.events) {
      throw new ChannelAdapterError(this.channel, "not_started", "adapter not started");
    }
    const conversationType = seed.conversationType ?? "private";
    const mentionedBot = conversationType === "group" ? seed.mentionedBot === true : true;
    if (conversationType === "group" && !mentionedBot) {
      return null; // dropped at the channel layer, per contract
    }
    this.seq += 1;
    const msg: InboundMessage = {
      channel: this.channel,
      externalUserId: seed.externalUserId,
      externalUserName: seed.externalUserName,
      conversationId: seed.conversationId,
      conversationType,
      messageId: seed.messageId ?? `mock-in-${this.seq}`,
      // Reference normalization: trim + strip the leading @bot mention token
      // (real channels strip their own mention markup, e.g. Feishu @_user_1).
      text: seed.text.trim().replace(/^@bot\s+/i, ""),
      mentionedBot: true,
      receivedAt: seed.receivedAt ?? new Date().toISOString(),
      raw: seed.raw,
    };
    await this.events.onMessage(msg);
    return msg;
  }

  /** Simulate a transport state transition (disconnect/reconnect drills). */
  simulateState(state: AdapterConnectionState): void {
    this.events?.onStateChange?.(state);
  }

  /** Simulate a transport-level error surfacing to the control plane. */
  simulateError(code: "connection_lost" | "internal", message: string, retryable = false): void {
    this.events?.onError?.(new ChannelAdapterError(this.channel, code, message, retryable));
  }
}

/** Env-gated factory: production (IM_CHANNEL_MOCK unset) → null → channel not registered. */
export function createMockChannelAdapterFactory(): ChannelAdapterFactory {
  return {
    channel: KnownChannel.Mock,
    envKeys: [MOCK_ENV_KEY, MOCK_CREDENTIALS_ENV_KEY, MOCK_SECRET_ENV_KEY],
    fromEnv(env: Record<string, string | undefined>): ChannelAdapter | null {
      if (env[MOCK_ENV_KEY] !== "1") return null;
      return new MockChannelAdapter({
        credentials: env[MOCK_CREDENTIALS_ENV_KEY] === "invalid" ? "invalid" : "valid",
        secretValue: env[MOCK_SECRET_ENV_KEY],
      });
    },
  };
}
