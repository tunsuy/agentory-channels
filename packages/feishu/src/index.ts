/**
 * @agentoryhq/im-channel-feishu
 *
 * Feishu/Lark channel adapter — official reference implementation of the
 * ChannelAdapter contract on top of `@larksuiteoapi/node-sdk` (pinned).
 *
 * Transport: WSClient outbound long connection (no public webhook endpoint,
 * no inbound listener — contract v1 red line). Inbound events arrive through
 * the SDK's EventDispatcher on `im.message.receive_v1`.
 *
 * Phase-1 honest boundary: plain-text messages only. Non-text message types
 * (image/audio/file/post/…) are dropped at the channel layer — rich media is
 * a future additive capability of the contract.
 *
 * Secret hygiene: app credentials are held in this instance only, read from
 * the factory's `env` argument (never process.env), and never echoed into
 * error messages, probe reasons, or `raw` payloads.
 */
import {
  Client,
  EventDispatcher,
  LoggerLevel,
  WSClient,
} from "@larksuiteoapi/node-sdk";
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

export const FEISHU_APP_ID_ENV_KEY = "FEISHU_APP_ID";
export const FEISHU_APP_SECRET_ENV_KEY = "FEISHU_APP_SECRET";

/** Conservative plain-text clamp for a single Feishu text message. */
export const FEISHU_TEXT_LIMIT = 4096;

/** Non-destructive credential validation endpoint (tenant access token, internal app). */
export const FEISHU_PROBE_URL =
  "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
export const FEISHU_PROBE_TIMEOUT_MS = 5_000;

export type FeishuAdapterOptions = {
  appId: string;
  appSecret: string;
};

/**
 * Minimal structural shape of the SDK's `im.message.receive_v1` payload —
 * kept local so normalization stays unit-testable offline without depending
 * on the SDK's generated event types.
 */
export type FeishuInboundEvent = {
  sender?: {
    sender_id?: { open_id?: string; union_id?: string; user_id?: string };
    sender_type?: string;
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    /** "p2p" | "group" (SDK types it as plain string). */
    chat_type?: string;
    message_type?: string;
    /** JSON-encoded body, e.g. `{"text":"@_user_1 hello"}` for text messages. */
    content?: string;
    /** Milliseconds epoch, as a string. */
    create_time?: string;
    mentions?: Array<{ key?: string; name?: string }>;
  };
};

/**
 * Normalize one Feishu event into the contract's InboundMessage.
 * Returns null (= drop at the channel layer, zero emission) when:
 * - sender is not a human user (bot/system echo);
 * - message type is not plain text (phase-1 boundary);
 * - sender open_id / chat id / message id missing (unattributable);
 * - unknown chat_type;
 * - content is malformed JSON or has no string text;
 * - group message without any mention (contract: non-mention group messages
 *   never reach the control plane);
 * - text is empty after mention-key stripping (bare "@bot" is not an instruction).
 */
export function normalizeFeishuEvent(event: FeishuInboundEvent): InboundMessage | null {
  const message = event.message;
  if (!message?.message_id || !message.chat_id) return null;
  const senderType = event.sender?.sender_type;
  if (senderType && senderType !== "user") return null;
  if (message.message_type !== "text") return null;
  const externalUserId = event.sender?.sender_id?.open_id;
  if (!externalUserId) return null;

  const conversationType =
    message.chat_type === "p2p" ? "private" : message.chat_type === "group" ? "group" : null;
  if (!conversationType) return null;

  let text: unknown;
  try {
    text = (JSON.parse(message.content ?? "") as { text?: unknown }).text;
  } catch {
    return null;
  }
  if (typeof text !== "string") return null;
  let textBody: string = text;

  const mentions = message.mentions ?? [];
  if (conversationType === "group" && mentions.length === 0) return null;

  // Mention markup ("@_user_1 …") is the channel's, the control plane never sees it.
  for (const mention of mentions) {
    if (mention.key) textBody = textBody.split(mention.key).join("");
  }
  const normalized = textBody.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  const created = Number(message.create_time);
  return {
    channel: KnownChannel.Feishu,
    externalUserId,
    conversationId: message.chat_id,
    conversationType,
    messageId: message.message_id,
    text: normalized,
    // Emitted group messages always mention the bot (non-mentions dropped above);
    // private chats have no mention concept — contract says true on every emission.
    mentionedBot: true,
    receivedAt: new Date(
      Number.isFinite(created) && created > 0 ? created : Date.now(),
    ).toISOString(),
    raw: { chatType: message.chat_type, messageType: message.message_type },
  };
}

/** Defensive outbound clamp (the control plane usually pre-clamps). */
export function clampFeishuText(text: string): { text: string; truncated: boolean } {
  if (text.length <= FEISHU_TEXT_LIMIT) return { text, truncated: false };
  return { text: `${text.slice(0, FEISHU_TEXT_LIMIT - 1)}…`, truncated: true };
}

/** Classify a WSClient start failure WITHOUT echoing any part of it (hygiene). */
function classifyStartError(err: unknown): "credential_invalid" | "internal" {
  const s = `${(err as Error)?.name ?? ""} ${(err as Error)?.message ?? ""}`.toLowerCase();
  return /token|auth|secret|credential|invalid|forbidden|unauthorized|401|403/.test(s)
    ? "credential_invalid"
    : "internal";
}

function isRateLimitedError(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string };
  const s = `${e?.code ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return /rate|frequen|limit|230002|99991400/.test(s);
}

export class FeishuChannelAdapter implements ChannelAdapter {
  readonly channel: string = KnownChannel.Feishu;
  readonly apiVersion = ADAPTER_API_VERSION;
  readonly capabilities: readonly AdapterCapability[] = ["private", "group"];

  private events: ChannelAdapterEvents | null = null;
  private started = false;
  private ws: WSClient | null = null;
  private client: Client | null = null;
  private state: AdapterConnectionState = "disconnected";

  constructor(private readonly opts: FeishuAdapterOptions) {}

  private credentialsPresent(): boolean {
    return Boolean(this.opts.appId?.trim()) && Boolean(this.opts.appSecret?.trim());
  }

  private setState(next: AdapterConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.events?.onStateChange?.(next);
  }

  async start(events: ChannelAdapterEvents): Promise<void> {
    // Fail-closed before touching the network (contract guard tests run offline).
    if (!this.credentialsPresent()) {
      throw new ChannelAdapterError(
        this.channel,
        "credential_invalid",
        "missing FEISHU_APP_ID or FEISHU_APP_SECRET",
      );
    }
    if (this.started) return; // idempotent
    this.events = events;

    const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.error }).register({
      "im.message.receive_v1": (data) => {
        const msg = normalizeFeishuEvent(data);
        if (msg) return this.events?.onMessage(msg);
      },
    });

    const ws = new WSClient({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      loggerLevel: LoggerLevel.error,
      source: "agentory-channels",
      onReady: () => this.setState("connected"),
      onError: () => {
        this.setState("disconnected");
        this.events?.onError?.(
          new ChannelAdapterError(this.channel, "connection_lost", "feishu connection failed", true),
        );
      },
      onReconnecting: () => this.setState("reconnecting"),
      onReconnected: () => this.setState("connected"),
    });

    this.setState("connecting");
    try {
      await ws.start({ eventDispatcher: dispatcher });
    } catch (err) {
      // Static messages only — never echo SDK error text (hygiene).
      this.setState("disconnected");
      this.events = null;
      throw new ChannelAdapterError(
        this.channel,
        classifyStartError(err),
        "feishu start failed",
        true,
      );
    }
    this.ws = ws;
    this.client = new Client({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      loggerLevel: LoggerLevel.error,
    });
    this.started = true;
  }

  async stop(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    this.client = null;
    this.started = false;
    this.events = null;
    this.state = "disconnected";
    if (ws) {
      try {
        ws.close({ force: true });
      } catch {
        // close is best-effort; stop must stay idempotent and safe before start
      }
    }
  }

  async send(reply: OutboundReply): Promise<SendResult> {
    const client = this.client;
    if (!this.started || !client) {
      throw new ChannelAdapterError(this.channel, "not_started", "feishu adapter not started");
    }
    const { text } = clampFeishuText(reply.text);
    try {
      const res = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: reply.conversationId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      });
      const messageId = (res as unknown as { data?: { message_id?: string } })?.data?.message_id;
      return messageId ? { channelMessageId: messageId } : {};
    } catch (err) {
      const limited = isRateLimitedError(err);
      throw new ChannelAdapterError(
        this.channel,
        limited ? "rate_limited" : "send_failed",
        limited ? "feishu rate limited" : "feishu send failed",
        true,
      );
    }
  }

  /**
   * Validate credentials by fetching a tenant access token (non-destructive,
   * no long-lived connection). Never throws; never echoes credential values —
   * reasons carry only Feishu's numeric error code or transport status.
   */
  async probeCredentials(): Promise<CredentialProbe> {
    if (!this.credentialsPresent()) {
      return { ok: false, reason: "missing FEISHU_APP_ID / FEISHU_APP_SECRET" };
    }
    try {
      const res = await fetch(FEISHU_PROBE_URL, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: this.opts.appId, app_secret: this.opts.appSecret }),
        signal: AbortSignal.timeout(FEISHU_PROBE_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => ({}))) as { code?: number };
      if (res.ok && data.code === 0) return { ok: true };
      return {
        ok: false,
        reason: `feishu rejected credentials (code ${data.code ?? res.status})`,
      };
    } catch {
      return { ok: false, reason: "feishu api unreachable" };
    }
  }
}

export class FeishuChannelFactory implements ChannelAdapterFactory {
  readonly channel: string = KnownChannel.Feishu;
  readonly envKeys: readonly string[] = [FEISHU_APP_ID_ENV_KEY, FEISHU_APP_SECRET_ENV_KEY];

  fromEnv(env: Record<string, string | undefined>): ChannelAdapter | null {
    const appId = env[FEISHU_APP_ID_ENV_KEY]?.trim();
    const appSecret = env[FEISHU_APP_SECRET_ENV_KEY]?.trim();
    // Fail-closed: incomplete credentials → not registered, startup never blocked.
    if (!appId || !appSecret) return null;
    return new FeishuChannelAdapter({ appId, appSecret });
  }
}

export function createFeishuChannelFactory(): FeishuChannelFactory {
  return new FeishuChannelFactory();
}
