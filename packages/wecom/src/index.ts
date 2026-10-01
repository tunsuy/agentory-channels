/**
 * @agentoryhq/im-channel-wecom
 *
 * WeCom (企业微信) smart-robot channel adapter — official reference
 * implementation of the ChannelAdapter contract on top of
 * `@wecom/aibot-node-sdk` (pinned).
 *
 * Transport: WSClient outbound WebSocket long connection to
 * `wss://openws.work.weixin.qq.com` with an in-band auth frame
 * (`aibot_subscribe`). Plaintext JSON over TLS — no corpId/token/AES-key
 * callback crypto. No public webhook endpoint, no inbound listener —
 * contract v1 red line.
 *
 * Protocol boundaries honored honestly:
 * - Single chats carry NO chatid: the conversation key is `from.userid`.
 * - Group bots only receive @-mentioned messages, so every emitted group
 *   message has mentionedBot=true (platform-enforced, same posture as the
 *   Feishu/DingTalk adapters).
 * - The active-send API has NO plain-text msgtype: outbound replies are sent
 *   as `markdown` (plain text renders identically for contract-era replies).
 * - The payload has no sender display name — externalUserName is omitted.
 *
 * Phase-1 honest boundary: plain-text messages only (`message.text`);
 * image/voice/file/video/mixed are a future additive capability.
 *
 * Secret hygiene: botId/secret are held in this instance only, read from the
 * factory's `env` argument (never process.env), and never echoed into error
 * messages, probe reasons, or `raw` payloads.
 */
import { WSClient } from "@wecom/aibot-node-sdk";
import {
  ADAPTER_API_VERSION,
  type AdapterCapability,
  type AdapterConnectionState,
  type ChannelAdapter,
  ChannelAdapterError,
  type ChannelAdapterErrorCode,
  type ChannelAdapterEvents,
  type ChannelAdapterFactory,
  type CredentialProbe,
  type InboundMessage,
  KnownChannel,
  type OutboundReply,
  type SendResult,
} from "@agentoryhq/im-channel-contract";

export const WECOM_AIBOT_BOT_ID_ENV_KEY = "WECOM_AIBOT_BOT_ID";
export const WECOM_AIBOT_SECRET_ENV_KEY = "WECOM_AIBOT_SECRET";

/**
 * Conservative plain-text clamp for a single WeCom reply. (The passive stream
 * reply cap is 20480 bytes; the active markdown-send cap is not published —
 * stay conservative, the control plane usually pre-clamps.)
 */
export const WECOM_TEXT_LIMIT = 4096;

/** Fail-fast auth attempts at start: auth failure is unrecoverable without new credentials. */
export const WECOM_START_AUTH_ATTEMPTS = 2;
export const WECOM_START_TIMEOUT_MS = 20_000;
export const WECOM_PROBE_TIMEOUT_MS = 10_000;

export type WecomAdapterOptions = {
  botId: string;
  secret: string;
};

/**
 * Minimal structural shape of a `message.text` frame — kept local so
 * normalization stays unit-testable offline without the SDK's generated
 * types. `response_url` (temporary reply URL) is treated as token-bearing:
 * it never reaches `raw` or error text.
 */
export type WecomTextFrame = {
  headers?: { req_id?: string };
  body?: {
    msgid?: string;
    aibotid?: string;
    /** Present on group messages only. */
    chatid?: string;
    chattype?: string;
    from?: { userid?: string };
    msgtype?: string;
    text?: { content?: string };
    /** Wire timestamp; WeCom convention is seconds, guarded heuristically. */
    create_time?: number;
    response_url?: string;
  };
};

/**
 * Normalize one WeCom text frame into the contract's InboundMessage.
 * Returns null (= drop at the channel layer, zero emission) when:
 * - body / msgid / from.userid missing (unattributable);
 * - msgtype is not text (phase-1 boundary);
 * - unknown chattype, or group message without chatid;
 * - text is empty after trimming.
 *
 * Conversation key: group → chatid; single → from.userid (single chats carry
 * no chatid on the wire).
 */
export function normalizeWecomMessage(frame: WecomTextFrame): InboundMessage | null {
  const body = frame?.body;
  if (!body?.msgid) return null;
  if (body.msgtype !== "text") return null;
  const externalUserId = body.from?.userid?.trim();
  if (!externalUserId) return null;

  let conversationType: "private" | "group";
  let conversationId: string;
  if (body.chattype === "single") {
    conversationType = "private";
    conversationId = externalUserId;
  } else if (body.chattype === "group") {
    if (!body.chatid) return null;
    conversationType = "group";
    conversationId = body.chatid;
  } else {
    return null;
  }

  const content = body.text?.content;
  if (typeof content !== "string") return null;
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  const rawTime = Number(body.create_time);
  // WeCom timestamps are seconds by convention; accept ms defensively.
  const ms = Number.isFinite(rawTime) && rawTime > 0 ? (rawTime < 1e12 ? rawTime * 1000 : rawTime) : Date.now();
  return {
    channel: KnownChannel.Wecom,
    externalUserId,
    // No sender display name exists in the protocol — omitted honestly.
    conversationId,
    conversationType,
    messageId: body.msgid,
    text: normalized,
    mentionedBot: true,
    receivedAt: new Date(ms).toISOString(),
    // response_url deliberately excluded (temporary token-bearing reply URL).
    raw: { chattype: body.chattype, msgtype: body.msgtype },
  };
}

/** Defensive outbound clamp. */
export function clampWecomText(text: string): { text: string; truncated: boolean } {
  if (text.length <= WECOM_TEXT_LIMIT) return { text, truncated: false };
  return { text: `${text.slice(0, WECOM_TEXT_LIMIT - 1)}…`, truncated: true };
}

/** SDK error codes this adapter classifies (string literals — no instanceof across module copies). */
const AUTH_EXHAUSTED = "WS_AUTH_FAILURE_EXHAUSTED";
const RECONNECT_EXHAUSTED = "WS_RECONNECT_EXHAUSTED";

/**
 * Classify an SDK send error (pure — unit-testable offline). The SDK exposes
 * no dedicated rate-limit signal, so rate classification is a defensive
 * errmsg text match; everything else is an honest send_failed.
 */
export function classifyWecomSendError(err: unknown): { code: ChannelAdapterErrorCode; retryable: boolean } {
  const e = err as { code?: string; message?: string };
  if (e?.code === AUTH_EXHAUSTED) return { code: "credential_invalid", retryable: false };
  const s = `${e?.message ?? ""}`.toLowerCase();
  if (/rate|frequen|too many|limit/.test(s)) return { code: "rate_limited", retryable: true };
  return { code: "send_failed", retryable: true };
}

/** Silent logger — the control plane logs adapter-level events itself (secret hygiene: no SDK console noise). */
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export class WecomChannelAdapter implements ChannelAdapter {
  readonly channel: string = KnownChannel.Wecom;
  readonly apiVersion = ADAPTER_API_VERSION;
  readonly capabilities: readonly AdapterCapability[] = ["private", "group"];

  private events: ChannelAdapterEvents | null = null;
  private started = false;
  private client: WSClient | null = null;
  private state: AdapterConnectionState = "disconnected";

  constructor(private readonly opts: WecomAdapterOptions) {}

  private credentialsPresent(): boolean {
    return Boolean(this.opts.botId?.trim()) && Boolean(this.opts.secret?.trim());
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
        "missing WECOM_AIBOT_BOT_ID or WECOM_AIBOT_SECRET",
      );
    }
    if (this.started) return; // idempotent
    this.events = events;

    const client = new WSClient({
      botId: this.opts.botId,
      secret: this.opts.secret,
      maxAuthFailureAttempts: WECOM_START_AUTH_ATTEMPTS,
      logger: silentLogger,
    });

    this.setState("connecting");
    // connect() is event-driven (returns `this`): await the auth handshake so
    // start() can honor the contract's credential_invalid guarantee.
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(new Error("wecom start timeout")), WECOM_START_TIMEOUT_MS);
        const onAuthed = () => finish(null);
        const onError = (err: Error) => finish(err);
        const finish = (err: Error | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          client.off("authenticated", onAuthed);
          client.off("error", onError);
          if (err) reject(err);
          else resolve();
        };
        client.once("authenticated", onAuthed);
        client.on("error", onError);
        client.connect();
      });
    } catch (err) {
      try {
        client.disconnect();
      } catch {
        // best-effort cleanup
      }
      this.events = null;
      this.setState("disconnected");
      const code = (err as { code?: string })?.code;
      if (code === AUTH_EXHAUSTED) {
        throw new ChannelAdapterError(this.channel, "credential_invalid", "wecom rejected credentials");
      }
      // Static messages only — never echo SDK error text (hygiene).
      throw new ChannelAdapterError(this.channel, "internal", "wecom start failed", true);
    }

    client.on("message.text", (frame) => this.onFrame(frame));
    client.on("connected", () => this.setState("connected"));
    client.on("reconnecting", () => this.setState("reconnecting"));
    client.on("disconnected", () => {
      this.setState("disconnected");
      this.events?.onError?.(
        new ChannelAdapterError(this.channel, "connection_lost", "wecom connection lost", true),
      );
    });
    client.on("event.disconnected_event", () => {
      // Kicked by a newer connection elsewhere — SDK does not auto-reconnect this case.
      this.setState("disconnected");
      this.events?.onError?.(
        new ChannelAdapterError(
          this.channel,
          "connection_lost",
          "wecom session taken over by a newer connection",
          true,
        ),
      );
    });
    client.on("error", (err: Error) => {
      const code = (err as { code?: string })?.code;
      this.events?.onError?.(
        new ChannelAdapterError(
          this.channel,
          code === AUTH_EXHAUSTED ? "credential_invalid" : code === RECONNECT_EXHAUSTED ? "connection_lost" : "internal",
          "wecom transport error",
          code !== AUTH_EXHAUSTED,
        ),
      );
    });

    this.client = client;
    this.started = true;
    this.setState("connected");
  }

  private onFrame(frame: WecomTextFrame): void {
    const msg = normalizeWecomMessage(frame);
    if (!msg) return;
    void Promise.resolve(this.events?.onMessage(msg)).catch((err: unknown) => {
      this.events?.onError?.(
        err instanceof ChannelAdapterError
          ? err
          : new ChannelAdapterError(this.channel, "internal", "wecom inbound handler failed"),
      );
    });
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.started = false;
    this.events = null;
    this.state = "disconnected";
    if (client) {
      try {
        client.removeAllListeners();
        client.disconnect();
      } catch {
        // disconnect is best-effort; stop must stay idempotent and safe before start
      }
    }
  }

  async send(reply: OutboundReply): Promise<SendResult> {
    const client = this.client;
    if (!this.started || !client) {
      throw new ChannelAdapterError(this.channel, "not_started", "wecom adapter not started");
    }
    const { text } = clampWecomText(reply.text);
    try {
      // Active send has no plain-text msgtype — markdown is the honest carrier.
      const res = await client.sendMessage(reply.conversationId, {
        msgtype: "markdown",
        markdown: { content: text },
      });
      const msgid = (res?.body as { msgid?: string } | undefined)?.msgid;
      return msgid ? { channelMessageId: msgid } : {};
    } catch (err) {
      const { code, retryable } = classifyWecomSendError(err);
      // Static messages only — never echo SDK error text (hygiene).
      throw new ChannelAdapterError(this.channel, code, `wecom send failed (${code})`, retryable);
    }
  }

  /**
   * Validate credentials by opening a throwaway WSClient and awaiting the
   * auth handshake (WeCom exposes no HTTP probe endpoint). Non-destructive,
   * always disconnects. Never throws; never echoes credential values.
   */
  async probeCredentials(): Promise<CredentialProbe> {
    if (!this.credentialsPresent()) {
      return { ok: false, reason: "missing WECOM_AIBOT_BOT_ID / WECOM_AIBOT_SECRET" };
    }
    const probe = new WSClient({
      botId: this.opts.botId,
      secret: this.opts.secret,
      maxAuthFailureAttempts: 1,
      logger: silentLogger,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(new Error("timeout")), WECOM_PROBE_TIMEOUT_MS);
        const onAuthed = () => finish(null);
        const onError = (err: Error) => finish(err);
        const finish = (err: Error | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          probe.off("authenticated", onAuthed);
          probe.off("error", onError);
          if (err) reject(err);
          else resolve();
        };
        probe.once("authenticated", onAuthed);
        probe.on("error", onError);
        probe.connect();
      });
      return { ok: true };
    } catch (err) {
      const code = (err as { code?: string })?.code;
      return {
        ok: false,
        reason:
          code === AUTH_EXHAUSTED
            ? "wecom rejected credentials"
            : "wecom api unreachable",
      };
    } finally {
      try {
        probe.removeAllListeners();
        probe.disconnect();
      } catch {
        // best-effort cleanup
      }
    }
  }
}

export class WecomChannelFactory implements ChannelAdapterFactory {
  readonly channel: string = KnownChannel.Wecom;
  readonly envKeys: readonly string[] = [WECOM_AIBOT_BOT_ID_ENV_KEY, WECOM_AIBOT_SECRET_ENV_KEY];

  fromEnv(env: Record<string, string | undefined>): ChannelAdapter | null {
    const botId = env[WECOM_AIBOT_BOT_ID_ENV_KEY]?.trim();
    const secret = env[WECOM_AIBOT_SECRET_ENV_KEY]?.trim();
    // Fail-closed: incomplete credentials → not registered, startup never blocked.
    if (!botId || !secret) return null;
    return new WecomChannelAdapter({ botId, secret });
  }
}

export function createWecomChannelFactory(): WecomChannelFactory {
  return new WecomChannelFactory();
}
