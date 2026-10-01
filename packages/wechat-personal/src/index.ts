/**
 * @agentoryhq/im-channel-wechat-personal
 *
 * Personal-WeChat (微信 ClawBot / iLink) channel adapter — a clean-room
 * reimplementation of Tencent's official iLink bot CGI protocol, matching the
 * wire behaviour of `@tencent-weixin/openclaw-weixin` (the official plugin,
 * which is host-coupled to OpenClaw and cannot be consumed as a library).
 *
 * Transport: OUTBOUND HTTP long-poll against `ilinkai.weixin.qq.com`. The bot
 * repeatedly POSTs `ilink/bot/getupdates`; the server holds each request until
 * new messages arrive or the poll window elapses. There is NO public webhook
 * endpoint and NO inbound listener — contract v1 red line, and the reason this
 * channel is architecturally admissible.
 *
 * Honest boundaries (protocol facts, not shortcuts):
 * - SINGLE CHAT ONLY. The iLink bot protocol is direct-message shaped; group
 *   chat is structurally unavailable. capabilities = ["private"], and the
 *   conversation key is the peer's `from_user_id`.
 * - REPLY-SHAPED, not cold-outbound: every send must echo a `context_token`
 *   that the getupdates API issues per inbound message. A user who has never
 *   messaged the bot has no cached token, so `send` to them is best-effort and
 *   may fail — surfaced honestly as send_failed.
 * - No sender display name exists on the wire; externalUserName is omitted.
 * - Phase-1 plain-text only (item type 1); media is a future additive capability.
 *
 * Credentials: a `bot_token` obtained via QR-scan authorization (see the
 * exported login helpers). The token is read from the factory's `env` argument
 * (never process.env), held in this instance only, and never echoed into
 * error messages, probe reasons, or `raw` payloads. `ret === -14` is the
 * protocol's stale-session signal → credential_invalid (re-login required).
 */
import { randomBytes, randomUUID } from "node:crypto";
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

export const WECHAT_PERSONAL_TOKEN_ENV_KEY = "WECHAT_PERSONAL_BOT_TOKEN";
export const WECHAT_PERSONAL_BASE_URL_ENV_KEY = "WECHAT_PERSONAL_BASE_URL";

/** Official iLink bot gateway. Per-account login may return an override base URL. */
export const WECHAT_PERSONAL_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

/** Protocol stale-session signal (the only named error code in the official plugin). */
export const WECHAT_STALE_TOKEN_RET = -14;

/** Plain-text chunk limit observed in the official plugin (textChunkLimit). */
export const WECHAT_PERSONAL_TEXT_LIMIT = 4000;

/** iLink message item type for plain text. */
const ITEM_TYPE_TEXT = 1;
/** Outbound message_type=BOT(2), message_state=FINISH(2). */
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;
/** bot_type for QR login. */
const QR_BOT_TYPE = "3";

/** base_info identifying this client to the backend (mirrors the official plugin's shape). */
export const WECHAT_BASE_INFO = { channel_version: "2.4.9", bot_agent: "Agentory" } as const;

/** Client-side long-poll window; server may dictate the next one via longpolling_timeout_ms. */
const DEFAULT_POLL_TIMEOUT_MS = 35_000;
const POLL_FETCH_BUFFER_MS = 10_000;
const PROBE_TIMEOUT_MS = 8_000;
const SEND_TIMEOUT_MS = 15_000;

export type WechatPersonalAdapterOptions = {
  botToken: string;
  baseUrl?: string;
};

/** One iLink wire message (subset — the fields this adapter reads). */
export type WeixinWireMessage = {
  /** uint64 on the wire; treated as an opaque string. */
  message_id?: string;
  /** Peer identity, form `<id>@im.wechat`. Doubles as the conversation key. */
  from_user_id?: string;
  /** Per-message token that MUST be echoed on the outbound reply to this peer. */
  context_token?: string;
  item_list?: Array<{ type?: number; text_item?: { text?: string } }>;
  /** Present in the type but never used — the protocol is direct-only. */
  group_id?: string;
};

/** getupdates response (subset). */
export type WeixinUpdates = {
  ret?: number;
  errmsg?: string;
  msgs?: WeixinWireMessage[];
  /** Opaque sync cursor echoed on the next poll. */
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
};

/**
 * Extract and concatenate plain-text items from a wire message. Returns null
 * when there is no non-empty text (media-only or empty) — dropped at the
 * channel layer (phase-1 boundary).
 */
export function extractWeixinText(msg: WeixinWireMessage): string | null {
  const items = msg?.item_list ?? [];
  const parts: string[] = [];
  for (const item of items) {
    if (item?.type === ITEM_TYPE_TEXT) {
      const t = item.text_item?.text;
      if (typeof t === "string") parts.push(t);
    }
  }
  const joined = parts.join("\n").replace(/\s+/g, " ").trim();
  return joined || null;
}

/**
 * Normalize one iLink wire message into the contract's InboundMessage.
 * Returns null (= drop, zero emission) when from_user_id / message_id is
 * missing or there is no plain text. conversationId === from_user_id and
 * conversationType is always "private" (the protocol has no group concept).
 *
 * `context_token` is intentionally NOT copied into `raw` (it is a per-message
 * credential); the adapter caches it separately for the outbound reply.
 */
export function normalizeWeixinMessage(msg: WeixinWireMessage): InboundMessage | null {
  const from = msg?.from_user_id?.trim();
  if (!from || !msg.message_id) return null;
  const text = extractWeixinText(msg);
  if (!text) return null;
  return {
    channel: KnownChannel.WechatPersonal,
    externalUserId: from,
    // No sender display name exists on the wire — omitted honestly.
    conversationId: from,
    conversationType: "private",
    messageId: String(msg.message_id),
    text,
    mentionedBot: true,
    receivedAt: new Date().toISOString(),
    raw: { itemTypes: (msg.item_list ?? []).map((i) => i?.type) },
  };
}

/** Defensive outbound clamp. */
export function clampWeixinText(text: string): { text: string; truncated: boolean } {
  if (text.length <= WECHAT_PERSONAL_TEXT_LIMIT) return { text, truncated: false };
  return { text: `${text.slice(0, WECHAT_PERSONAL_TEXT_LIMIT - 1)}…`, truncated: true };
}

/** Classify a getupdates/send `ret` code WITHOUT echoing message text (hygiene). */
function isStaleToken(ret: number | undefined): boolean {
  return ret === WECHAT_STALE_TOKEN_RET;
}

function authHeaders(token: string): Record<string, string> {
  // X-WECHAT-UIN is a random uint32 base64; iLink-App-ClientVersion packs major<<16|minor<<8|patch.
  const uin = randomBytes(4).toString("base64");
  const clientVersion = String((1 << 16) | (0 << 8) | 0);
  return {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": uin,
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": clientVersion,
  };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export class WechatPersonalChannelAdapter implements ChannelAdapter {
  readonly channel: string = KnownChannel.WechatPersonal;
  readonly apiVersion = ADAPTER_API_VERSION;
  /** Single-chat only — the iLink bot protocol has no group concept. */
  readonly capabilities: readonly AdapterCapability[] = ["private"];

  private events: ChannelAdapterEvents | null = null;
  private started = false;
  private state: AdapterConnectionState = "disconnected";
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  /** peer user id → most recent context_token (required to reply). Token-bearing; instance-private. */
  private contextTokens = new Map<string, string>();
  private pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS;

  constructor(private readonly opts: WechatPersonalAdapterOptions) {}

  private get baseUrl(): string {
    return (this.opts.baseUrl?.trim() || WECHAT_PERSONAL_DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  private tokenPresent(): boolean {
    return Boolean(this.opts.botToken?.trim());
  }

  private setState(next: AdapterConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.events?.onStateChange?.(next);
  }

  /** Authenticated POST; returns parsed JSON. Throws only on transport/HTTP failure. */
  private async post<T>(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: authHeaders(this.opts.botToken),
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`ilink http ${res.status}`);
    return (await res.json()) as T;
  }

  async start(events: ChannelAdapterEvents): Promise<void> {
    // Fail-closed before touching the network (contract guard tests run offline).
    if (!this.tokenPresent()) {
      throw new ChannelAdapterError(
        this.channel,
        "credential_invalid",
        "missing WECHAT_PERSONAL_BOT_TOKEN",
      );
    }
    if (this.started) return; // idempotent
    this.events = events;

    // Pre-validate the token with a light authenticated call so start() can
    // honor the credential_invalid guarantee for a stale token synchronously
    // (mirrors the DingTalk pre-validation posture). Network-unreachable is
    // NOT fatal here — the poll loop retries and reports connection_lost.
    this.setState("connecting");
    try {
      const resp = await this.post<{ ret?: number }>(
        "ilink/bot/msg/notifystart",
        { base_info: WECHAT_BASE_INFO },
        PROBE_TIMEOUT_MS,
      );
      if (isStaleToken(resp.ret)) {
        this.events = null;
        this.setState("disconnected");
        throw new ChannelAdapterError(
          this.channel,
          "credential_invalid",
          "wechat personal token rejected (re-login required)",
        );
      }
    } catch (err) {
      if (err instanceof ChannelAdapterError) throw err;
      // Unreachable / transient: proceed to the loop, which retries with backoff.
    }

    this.started = true;
    this.abort = new AbortController();
    this.loop = this.pollLoop();
    // start() resolves once the loop is running; first successful poll flips
    // state to connected. Connection is fully outbound (AC-11).
  }

  private async pollLoop(): Promise<void> {
    const signal = this.abort!.signal;
    let buf = "";
    let failures = 0;
    while (this.started && !signal.aborted) {
      let updates: WeixinUpdates;
      try {
        updates = await this.post<WeixinUpdates>(
          "ilink/bot/getupdates",
          { get_updates_buf: buf, base_info: WECHAT_BASE_INFO },
          this.pollTimeoutMs + POLL_FETCH_BUFFER_MS,
          signal,
        );
      } catch (err) {
        if (!this.started || signal.aborted) return; // stop() during a held poll
        // A client-side long-poll timeout is NORMAL control flow (empty poll),
        // not a failure — only real transport errors count toward backoff.
        const isTimeout = (err as { name?: string })?.name === "TimeoutError";
        if (isTimeout) {
          continue; // immediately re-poll
        }
        failures++;
        this.setState("reconnecting");
        this.events?.onError?.(
          new ChannelAdapterError(this.channel, "connection_lost", "wechat personal poll failed", true),
        );
        await sleep(failures >= 3 ? 30_000 : 2_000, signal);
        continue;
      }

      if (!this.started || signal.aborted) return;
      if (isStaleToken(updates.ret)) {
        // Credential died mid-session: stop retrying, surface honestly (fail-closed).
        this.started = false;
        this.setState("disconnected");
        this.events?.onError?.(
          new ChannelAdapterError(
            this.channel,
            "credential_invalid",
            "wechat personal token rejected (re-login required)",
          ),
        );
        return;
      }
      if (updates.ret && updates.ret !== 0) {
        failures++;
        this.setState("reconnecting");
        this.events?.onError?.(
          new ChannelAdapterError(this.channel, "connection_lost", "wechat personal poll rejected", true),
        );
        await sleep(failures >= 3 ? 30_000 : 2_000, signal);
        continue;
      }

      failures = 0;
      this.setState("connected");
      if (typeof updates.get_updates_buf === "string") buf = updates.get_updates_buf;
      if (typeof updates.longpolling_timeout_ms === "number" && updates.longpolling_timeout_ms > 0) {
        this.pollTimeoutMs = updates.longpolling_timeout_ms;
      }
      for (const m of updates.msgs ?? []) {
        // Cache the reply token before emitting (token-bearing; never in raw).
        if (m.from_user_id && m.context_token) this.contextTokens.set(m.from_user_id, m.context_token);
        const msg = normalizeWeixinMessage(m);
        if (!msg) continue;
        void Promise.resolve(this.events?.onMessage(msg)).catch((err: unknown) => {
          this.events?.onError?.(
            err instanceof ChannelAdapterError
              ? err
              : new ChannelAdapterError(this.channel, "internal", "wechat personal inbound handler failed"),
          );
        });
      }
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.events = null;
    this.state = "disconnected";
    const abort = this.abort;
    this.abort = null;
    const loop = this.loop;
    this.loop = null;
    this.contextTokens.clear();
    if (abort) abort.abort();
    if (loop) {
      try {
        await loop;
      } catch {
        // loop errors are surfaced via onError; stop stays idempotent
      }
    }
    // Best-effort offline notify — only if we ever went online (never blocks
    // stop, never throws, never touches the network otherwise).
    if (abort && loop && this.tokenPresent()) {
      try {
        await this.post("ilink/bot/msg/notifystop", { base_info: WECHAT_BASE_INFO }, 3_000);
      } catch {
        // ignore
      }
    }
  }

  async send(reply: OutboundReply): Promise<SendResult> {
    if (!this.started) {
      throw new ChannelAdapterError(this.channel, "not_started", "wechat personal adapter not started");
    }
    const { text } = clampWeixinText(reply.text);
    // context_token is issued per inbound message; absent for a peer who has
    // never messaged the bot (cold outbound). Send best-effort with empty token
    // and classify the result honestly.
    const contextToken = this.contextTokens.get(reply.conversationId) ?? "";
    const body = {
      msg: {
        from_user_id: "",
        to_user_id: reply.conversationId,
        client_id: randomUUID(),
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: WECHAT_BASE_INFO,
    };
    let resp: { ret?: number; message_id?: string };
    try {
      resp = await this.post("ilink/bot/sendmessage", body, SEND_TIMEOUT_MS, this.abort?.signal);
    } catch {
      throw new ChannelAdapterError(this.channel, "send_failed", "wechat personal send failed", true);
    }
    if (isStaleToken(resp.ret)) {
      throw new ChannelAdapterError(
        this.channel,
        "credential_invalid",
        "wechat personal token rejected (re-login required)",
      );
    }
    if (resp.ret && resp.ret !== 0) {
      throw new ChannelAdapterError(this.channel, "send_failed", "wechat personal send rejected", true);
    }
    return resp.message_id ? { channelMessageId: String(resp.message_id) } : {};
  }

  /**
   * Validate the bot token with a light authenticated call. Never throws;
   * never echoes credential values — reasons carry only the protocol ret code.
   */
  async probeCredentials(): Promise<CredentialProbe> {
    if (!this.tokenPresent()) {
      return { ok: false, reason: "missing WECHAT_PERSONAL_BOT_TOKEN" };
    }
    try {
      const resp = await this.post<{ ret?: number }>(
        "ilink/bot/msg/notifystart",
        { base_info: WECHAT_BASE_INFO },
        PROBE_TIMEOUT_MS,
      );
      if (resp.ret === 0 || resp.ret === undefined) return { ok: true };
      if (isStaleToken(resp.ret)) {
        return { ok: false, reason: "wechat personal token rejected (re-login required)" };
      }
      return { ok: false, reason: `wechat personal rejected token (ret ${resp.ret})` };
    } catch {
      return { ok: false, reason: "wechat personal api unreachable" };
    }
  }
}

export class WechatPersonalChannelFactory implements ChannelAdapterFactory {
  readonly channel: string = KnownChannel.WechatPersonal;
  readonly envKeys: readonly string[] = [
    WECHAT_PERSONAL_TOKEN_ENV_KEY,
    WECHAT_PERSONAL_BASE_URL_ENV_KEY,
  ];

  fromEnv(env: Record<string, string | undefined>): ChannelAdapter | null {
    const botToken = env[WECHAT_PERSONAL_TOKEN_ENV_KEY]?.trim();
    // Fail-closed: no token → not registered, startup never blocked.
    if (!botToken) return null;
    const baseUrl = env[WECHAT_PERSONAL_BASE_URL_ENV_KEY]?.trim();
    return new WechatPersonalChannelAdapter({
      botToken,
      ...(baseUrl ? { baseUrl } : {}),
    });
  }
}

export function createWechatPersonalChannelFactory(): WechatPersonalChannelFactory {
  return new WechatPersonalChannelFactory();
}

// ── QR-scan login helpers (operator tooling — NOT used by the runtime adapter) ──
//
// The bot_token the adapter consumes is obtained by scanning a QR code with a
// personal WeChat app and confirming authorization. These helpers drive that
// flow so an operator (or the Console credential-setup page) can mint a token
// to place in WECHAT_PERSONAL_BOT_TOKEN. They are outbound-only HTTP calls to
// the same gateway.

export type WeixinLoginQr = {
  /** Opaque QR handle; pass to pollWeixinLoginStatus. */
  qrcode: string;
  /** Renderable QR content (URL string) for the operator to scan. */
  qrcodeImgContent?: string;
};

export type WeixinLoginStatus =
  | { status: "wait" }
  | { status: "scaned" }
  | { status: "need_verifycode" }
  | { status: "expired" }
  | { status: "verify_code_blocked" }
  | { status: "scaned_but_redirect"; redirectHost?: string }
  | { status: "binded_redirect"; redirectHost?: string }
  | {
      status: "confirmed";
      botToken: string;
      ilinkBotId?: string;
      /** Per-account base URL to use for subsequent adapter calls. */
      baseUrl?: string;
      ilinkUserId?: string;
    };

/** Fetch a fresh login QR (step 1). Outbound POST to the gateway. */
export async function requestWeixinLoginQr(
  baseUrl: string = WECHAT_PERSONAL_DEFAULT_BASE_URL,
  localTokenList: string[] = [],
): Promise<WeixinLoginQr> {
  const url = `${baseUrl.replace(/\/+$/, "")}/ilink/bot/get_bot_qrcode?bot_type=${QR_BOT_TYPE}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "iLink-App-Id": "bot" },
    body: JSON.stringify({ local_token_list: localTokenList }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`get_bot_qrcode http ${res.status}`);
  const data = (await res.json()) as { qrcode?: string; qrcode_img_content?: string; ret?: number };
  if (!data.qrcode) throw new Error(`get_bot_qrcode rejected (ret ${data.ret ?? "none"})`);
  return { qrcode: data.qrcode, qrcodeImgContent: data.qrcode_img_content };
}

/**
 * Long-poll the QR authorization status once (step 2). Call repeatedly until
 * `status` is "confirmed" (→ botToken) or a terminal failure ("expired",
 * "verify_code_blocked"). A "*_redirect" status means the operator should
 * re-run the flow against `redirectHost`.
 */
export async function pollWeixinLoginStatus(
  qrcode: string,
  baseUrl: string = WECHAT_PERSONAL_DEFAULT_BASE_URL,
  timeoutMs: number = DEFAULT_POLL_TIMEOUT_MS + POLL_FETCH_BUFFER_MS,
): Promise<WeixinLoginStatus> {
  const url = `${baseUrl.replace(/\/+$/, "")}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "iLink-App-Id": "bot" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`get_qrcode_status http ${res.status}`);
  const d = (await res.json()) as Record<string, unknown>;
  const status = String(d.status ?? "wait");
  const redirectHost = typeof d.redirect_host === "string" ? d.redirect_host : undefined;
  switch (status) {
    case "confirmed": {
      const botToken = d.bot_token;
      if (typeof botToken !== "string" || !botToken) throw new Error("confirmed without bot_token");
      return {
        status: "confirmed",
        botToken,
        ilinkBotId: typeof d.ilink_bot_id === "string" ? d.ilink_bot_id : undefined,
        baseUrl: typeof d.baseurl === "string" ? d.baseurl : undefined,
        ilinkUserId: typeof d.ilink_user_id === "string" ? d.ilink_user_id : undefined,
      };
    }
    case "scaned_but_redirect":
    case "binded_redirect":
      return { status, redirectHost };
    case "scaned":
    case "need_verifycode":
    case "expired":
    case "verify_code_blocked":
      return { status };
    default:
      return { status: "wait" };
  }
}
