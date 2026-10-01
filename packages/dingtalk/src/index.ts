/**
 * @agentoryhq/im-channel-dingtalk
 *
 * DingTalk channel adapter — official reference implementation of the
 * ChannelAdapter contract on top of `dingtalk-stream` (pinned).
 *
 * Transport: DWClient outbound WebSocket long connection opened via the
 * official gateway (`/v1.0/gateway/connections/open`). No public webhook
 * endpoint, no inbound listener — contract v1 red line. Inbound robot
 * messages arrive on the `/v1.0/im/bot/messages/get` callback topic.
 *
 * Reply path (documented DingTalk stream-mode boundary): replies are POSTed
 * to the `sessionWebhook` carried by the most recent inbound message of each
 * conversation, valid until `sessionWebhookExpiredTime`. The adapter caches
 * that webhook per conversation; when no live session exists (cold
 * conversation or expired window) `send` fails honestly with `send_failed` —
 * the control plane surfaces its standard guidance. The webhook URL embeds a
 * session token: it is held in this instance only and NEVER echoed into
 * errors, `raw` payloads, or log lines.
 *
 * Credential fail-closed: `DWClient.connect()` swallows auth errors and
 * schedules silent reconnects (it never rejects), so `start()` pre-validates
 * credentials against the official token endpoint BEFORE connecting —
 * otherwise the contract's `credential_invalid` guarantee would be
 * unenforceable.
 *
 * Phase-1 honest boundary: plain-text messages only (`msgtype: "text"`);
 * rich media is a future additive capability of the contract.
 */
import { DWClient, GET_TOKEN_URL, TOPIC_ROBOT, type DWClientDownStream } from "dingtalk-stream";
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

export const DINGTALK_CLIENT_ID_ENV_KEY = "DINGTALK_CLIENT_ID";
export const DINGTALK_CLIENT_SECRET_ENV_KEY = "DINGTALK_CLIENT_SECRET";

/** Conservative plain-text clamp for a single DingTalk reply (control plane usually pre-clamps). */
export const DINGTALK_TEXT_LIMIT = 4096;

export const DINGTALK_PROBE_TIMEOUT_MS = 5_000;
export const DINGTALK_SEND_TIMEOUT_MS = 10_000;

export type DingTalkAdapterOptions = {
  /** AppKey of the DingTalk internal app (clientId in stream-mode terms). */
  clientId: string;
  /** AppSecret — held in this instance only, never logged or echoed. */
  clientSecret: string;
};

/**
 * Minimal structural shape of the robot-message payload delivered on
 * TOPIC_ROBOT (`JSON.parse(downstream.data)`). Kept local so normalization
 * stays unit-testable offline without the SDK's generated types.
 * NOTE: `sessionWebhook` embeds a session token — it must never appear in
 * InboundMessage.raw or any error text.
 */
export type DingTalkRobotPayload = {
  conversationId?: string;
  /** "1" = 1:1 private chat, "2" = group chat (string on the wire). */
  conversationType?: string;
  senderStaffId?: string;
  senderId?: string;
  senderNick?: string;
  msgId?: string;
  msgtype?: string;
  text?: { content?: string };
  /** Milliseconds epoch. */
  createAt?: number;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
};

/**
 * Normalize one DingTalk robot payload into the contract's InboundMessage.
 * Returns null (= drop at the channel layer, zero emission) when:
 * - msgId / conversationId missing (unattributable or undeliverable);
 * - msgtype is not plain text (phase-1 boundary);
 * - neither senderStaffId nor senderId present (no stable identity to bind);
 * - unknown conversationType;
 * - text is empty after trimming.
 *
 * Group semantics: DingTalk group robots only receive messages that @-mention
 * the bot, so every emitted group message has mentionedBot=true (same
 * contract posture as the Feishu adapter: non-mention group chat never
 * reaches the control plane — here the platform itself enforces it).
 */
export function normalizeDingTalkMessage(payload: DingTalkRobotPayload): InboundMessage | null {
  if (!payload?.msgId || !payload.conversationId) return null;
  if (payload.msgtype !== "text") return null;
  const externalUserId = payload.senderStaffId?.trim() || payload.senderId?.trim();
  if (!externalUserId) return null;

  const conversationType =
    payload.conversationType === "1"
      ? "private"
      : payload.conversationType === "2"
        ? "group"
        : null;
  if (!conversationType) return null;

  const content = payload.text?.content;
  if (typeof content !== "string") return null;
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  const created = Number(payload.createAt);
  const senderNick = payload.senderNick?.trim();
  return {
    channel: KnownChannel.DingTalk,
    externalUserId,
    ...(senderNick ? { externalUserName: senderNick } : {}),
    conversationId: payload.conversationId,
    conversationType,
    messageId: payload.msgId,
    text: normalized,
    mentionedBot: true,
    receivedAt: new Date(
      Number.isFinite(created) && created > 0 ? created : Date.now(),
    ).toISOString(),
    // sessionWebhook deliberately excluded (embeds a session token).
    raw: { conversationType: payload.conversationType, msgtype: payload.msgtype },
  };
}

/** Defensive outbound clamp. */
export function clampDingTalkText(text: string): { text: string; truncated: boolean } {
  if (text.length <= DINGTALK_TEXT_LIMIT) return { text, truncated: false };
  return { text: `${text.slice(0, DINGTALK_TEXT_LIMIT - 1)}…`, truncated: true };
}

export type DingTalkTokenProbe =
  | { ok: true }
  | { ok: false; reason: string; credential: boolean };

/**
 * Validate credentials against the official token endpoint (non-destructive).
 * Never throws. Reasons carry only DingTalk's numeric errcode — never the
 * errmsg text (may echo request parameters) and never credential values.
 */
export async function fetchDingTalkTokenStatus(
  clientId: string,
  clientSecret: string,
  timeoutMs: number = DINGTALK_PROBE_TIMEOUT_MS,
): Promise<DingTalkTokenProbe> {
  try {
    const url = `${GET_TOKEN_URL}?appkey=${encodeURIComponent(clientId)}&appsecret=${encodeURIComponent(clientSecret)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const data = (await res.json().catch(() => ({}))) as { errcode?: number };
    if (res.ok && data.errcode === 0) return { ok: true };
    return {
      ok: false,
      reason: `dingtalk rejected credentials (code ${data.errcode ?? res.status})`,
      credential: true,
    };
  } catch {
    return { ok: false, reason: "dingtalk api unreachable", credential: false };
  }
}

/**
 * Classify a sessionWebhook send result (pure — unit-testable offline).
 * errcode 0 = delivered; DingTalk flow-control surfaces as "send too fast"
 * family errmsg values (platform rate is ~20 msgs/min per bot).
 */
export function classifyDingTalkSendResult(
  errcode: number | undefined,
  errmsg: string | undefined,
): "ok" | "rate_limited" | "send_failed" {
  if (errcode === 0) return "ok";
  const s = `${errmsg ?? ""}`.toLowerCase();
  if (/too fast|flow ?control|rate|frequen|limit/.test(s)) return "rate_limited";
  return "send_failed";
}

type SessionEntry = { webhook: string; expiresAt: number };

export class DingTalkChannelAdapter implements ChannelAdapter {
  readonly channel: string = KnownChannel.DingTalk;
  readonly apiVersion = ADAPTER_API_VERSION;
  readonly capabilities: readonly AdapterCapability[] = ["private", "group"];

  private events: ChannelAdapterEvents | null = null;
  private started = false;
  private client: DWClient | null = null;
  private state: AdapterConnectionState = "disconnected";
  /** conversationId → most recent live sessionWebhook (contains a token; instance-private). */
  private sessions = new Map<string, SessionEntry>();

  constructor(private readonly opts: DingTalkAdapterOptions) {}

  private credentialsPresent(): boolean {
    return Boolean(this.opts.clientId?.trim()) && Boolean(this.opts.clientSecret?.trim());
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
        "missing DINGTALK_CLIENT_ID or DINGTALK_CLIENT_SECRET",
      );
    }
    if (this.started) return; // idempotent
    this.events = events;

    // DWClient.connect() never rejects (silent reconnect loop), so credentials
    // MUST be pre-validated here or start() could not honor the contract's
    // credential_invalid guarantee.
    const token = await fetchDingTalkTokenStatus(this.opts.clientId, this.opts.clientSecret);
    if (!token.ok) {
      this.events = null;
      throw new ChannelAdapterError(
        this.channel,
        token.credential ? "credential_invalid" : "internal",
        token.reason,
        !token.credential,
      );
    }

    const client = new DWClient({
      clientId: this.opts.clientId,
      clientSecret: this.opts.clientSecret,
      ua: "agentory-channels",
    });
    client.registerCallbackListener(TOPIC_ROBOT, (res) => this.onDownstream(res));

    this.setState("connecting");
    try {
      await client.connect();
    } catch {
      // Defensive only — connect() is documented to swallow errors.
    }
    if (!client.connected) {
      try {
        client.disconnect();
      } catch {
        // best-effort cleanup
      }
      this.events = null;
      this.setState("disconnected");
      throw new ChannelAdapterError(
        this.channel,
        "connection_lost",
        "dingtalk start failed (gateway or websocket unreachable)",
        true,
      );
    }
    this.client = client;
    this.started = true;
    this.setState("connected");
  }

  /** TOPIC_ROBOT callback: ack first (avoid 60s server retries), then normalize + emit. */
  private onDownstream(res: DWClientDownStream): void {
    try {
      this.client?.socketCallBackResponse(res?.headers?.messageId, {});
    } catch {
      // ack is best-effort; server retry is deduped downstream by messageId
    }
    let payload: DingTalkRobotPayload;
    try {
      payload = JSON.parse(res?.data ?? "") as DingTalkRobotPayload;
    } catch {
      return; // malformed frame — drop silently (zero emission)
    }
    const msg = normalizeDingTalkMessage(payload);
    if (!msg) return;
    // Cache the reply window for this conversation (token-bearing; never leaves the instance).
    if (payload.sessionWebhook && Number(payload.sessionWebhookExpiredTime) > Date.now()) {
      this.sessions.set(msg.conversationId, {
        webhook: payload.sessionWebhook,
        expiresAt: Number(payload.sessionWebhookExpiredTime),
      });
    }
    void Promise.resolve(this.events?.onMessage(msg)).catch((err: unknown) => {
      this.events?.onError?.(
        err instanceof ChannelAdapterError
          ? err
          : new ChannelAdapterError(this.channel, "internal", "dingtalk inbound handler failed"),
      );
    });
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.started = false;
    this.events = null;
    this.sessions.clear();
    this.state = "disconnected";
    if (client) {
      try {
        client.disconnect();
      } catch {
        // disconnect is best-effort; stop must stay idempotent and safe before start
      }
    }
  }

  async send(reply: OutboundReply): Promise<SendResult> {
    if (!this.started || !this.client) {
      throw new ChannelAdapterError(this.channel, "not_started", "dingtalk adapter not started");
    }
    const session = this.sessions.get(reply.conversationId);
    if (!session || session.expiresAt <= Date.now()) {
      // Honest boundary: DingTalk stream-mode replies ride the session webhook
      // of a recent inbound message; a cold/expired conversation cannot be
      // pushed to without one.
      throw new ChannelAdapterError(
        this.channel,
        "send_failed",
        "dingtalk reply window unavailable (no recent inbound message for this conversation)",
        true,
      );
    }
    const { text } = clampDingTalkText(reply.text);
    let errcode: number | undefined;
    let errmsg: string | undefined;
    try {
      const res = await fetch(session.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: text } }),
        signal: AbortSignal.timeout(DINGTALK_SEND_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
      errcode = res.ok ? data.errcode : (data.errcode ?? res.status);
      errmsg = data.errmsg;
    } catch {
      throw new ChannelAdapterError(this.channel, "send_failed", "dingtalk send failed", true);
    }
    const verdict = classifyDingTalkSendResult(errcode, errmsg);
    if (verdict === "ok") return {}; // sessionWebhook responses carry no message id
    throw new ChannelAdapterError(
      this.channel,
      verdict,
      verdict === "rate_limited" ? "dingtalk rate limited" : "dingtalk send failed",
      true,
    );
  }

  /**
   * Validate credentials via the official token endpoint. Never throws; never
   * echoes credential values — reasons carry only DingTalk's numeric errcode.
   */
  async probeCredentials(): Promise<CredentialProbe> {
    if (!this.credentialsPresent()) {
      return { ok: false, reason: "missing DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET" };
    }
    const probe = await fetchDingTalkTokenStatus(this.opts.clientId, this.opts.clientSecret);
    return probe.ok ? { ok: true } : { ok: false, reason: probe.reason };
  }
}

export class DingTalkChannelFactory implements ChannelAdapterFactory {
  readonly channel: string = KnownChannel.DingTalk;
  readonly envKeys: readonly string[] = [DINGTALK_CLIENT_ID_ENV_KEY, DINGTALK_CLIENT_SECRET_ENV_KEY];

  fromEnv(env: Record<string, string | undefined>): ChannelAdapter | null {
    const clientId = env[DINGTALK_CLIENT_ID_ENV_KEY]?.trim();
    const clientSecret = env[DINGTALK_CLIENT_SECRET_ENV_KEY]?.trim();
    // Fail-closed: incomplete credentials → not registered, startup never blocked.
    if (!clientId || !clientSecret) return null;
    return new DingTalkChannelAdapter({ clientId, clientSecret });
  }
}

export function createDingTalkChannelFactory(): DingTalkChannelFactory {
  return new DingTalkChannelFactory();
}
