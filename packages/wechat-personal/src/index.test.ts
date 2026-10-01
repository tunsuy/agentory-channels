import { test } from "node:test";
import assert from "node:assert/strict";
import { defineChannelContractTests } from "@agentoryhq/im-channel-contract/suite";
import {
  WECHAT_PERSONAL_BASE_URL_ENV_KEY,
  WECHAT_PERSONAL_DEFAULT_BASE_URL,
  WECHAT_PERSONAL_TEXT_LIMIT,
  WECHAT_PERSONAL_TOKEN_ENV_KEY,
  WechatPersonalChannelAdapter,
  clampWeixinText,
  createWechatPersonalChannelFactory,
  extractWeixinText,
  normalizeWeixinMessage,
  type WeixinWireMessage,
} from "./index.js";

const CTX_SENTINEL = "FAKE-CONTEXT-TOKEN-wxp";
const BOT_TOKEN_SENTINEL = "FAKE-BOT-TOKEN-wxp";

// ── Contract suite (guard tests): createInvalid uses an ABSENT token so every
// guard test fails closed offline (a present-but-invalid token would require a
// network round-trip to disprove — the poll loop surfaces that as
// credential_invalid via onError at runtime). The transport is a long-poll
// loop, so create/inject are omitted. Secret hygiene is asserted separately
// below (context_token / bot_token never reach normalized output).
defineChannelContractTests({
  name: "wechat_personal",
  createInvalid: () => new WechatPersonalChannelAdapter({ botToken: "" }),
});

function wireMsg(overrides: Partial<WeixinWireMessage> = {}): WeixinWireMessage {
  return {
    message_id: "18446744073709551000",
    from_user_id: "wxid_peer_001@im.wechat",
    context_token: CTX_SENTINEL,
    item_list: [{ type: 1, text_item: { text: "hello" } }],
    ...overrides,
  };
}

test("wechat_personal: normalizer — direct message emits private InboundMessage keyed on from_user_id", () => {
  const msg = normalizeWeixinMessage(wireMsg({ item_list: [{ type: 1, text_item: { text: "  do the thing  " } }] }));
  assert.ok(msg);
  assert.equal(msg.channel, "wechat_personal");
  assert.equal(msg.externalUserId, "wxid_peer_001@im.wechat");
  assert.equal(msg.conversationId, "wxid_peer_001@im.wechat", "single-chat key = peer id");
  assert.equal(msg.conversationType, "private", "protocol is direct-only");
  assert.equal(msg.messageId, "18446744073709551000", "uint64 id stays a string");
  assert.equal(msg.text, "do the thing", "text must be trimmed");
  assert.equal(msg.mentionedBot, true);
  assert.equal(msg.externalUserName, undefined, "no display name on the wire — omitted honestly");
  assert.ok(!Number.isNaN(Date.parse(msg.receivedAt)));
});

test("wechat_personal: normalizer — text extraction joins text items, ignores media", () => {
  assert.equal(
    extractWeixinText(wireMsg({
      item_list: [
        { type: 1, text_item: { text: "line one" } },
        { type: 2 }, // image — ignored (phase-1 boundary)
        { type: 1, text_item: { text: "line two" } },
      ],
    })),
    "line one\nline two".replace(/\s+/g, " ").trim(),
  );
  assert.equal(extractWeixinText(wireMsg({ item_list: [{ type: 2 }] })), null, "media-only drops");
  assert.equal(extractWeixinText(wireMsg({ item_list: [] })), null);
  assert.equal(extractWeixinText(wireMsg({ item_list: [{ type: 1, text_item: { text: "   " } }] })), null, "blank drops");
});

test("wechat_personal: normalizer — drop matrix (missing ids / no text)", () => {
  assert.equal(normalizeWeixinMessage(wireMsg({ from_user_id: undefined })), null);
  assert.equal(normalizeWeixinMessage(wireMsg({ from_user_id: "  " })), null);
  assert.equal(normalizeWeixinMessage(wireMsg({ message_id: undefined })), null);
  assert.equal(normalizeWeixinMessage(wireMsg({ item_list: undefined })), null);
  assert.equal(normalizeWeixinMessage({} as WeixinWireMessage), null, "empty wire message");
});

test("wechat_personal: hygiene — context_token never reaches normalized output or raw", () => {
  const msg = normalizeWeixinMessage(wireMsg());
  assert.ok(msg);
  const blob = JSON.stringify(msg);
  assert.ok(!blob.includes(CTX_SENTINEL), "context_token leaked into InboundMessage");
  assert.ok(!blob.includes("context_token"), "context_token key leaked into raw");
});

test("wechat_personal: clamp — over-limit text truncates, at-limit passes through", () => {
  const exact = clampWeixinText("x".repeat(WECHAT_PERSONAL_TEXT_LIMIT));
  assert.equal(exact.truncated, false);
  const over = clampWeixinText("y".repeat(WECHAT_PERSONAL_TEXT_LIMIT + 100));
  assert.equal(over.truncated, true);
  assert.equal(over.text.length, WECHAT_PERSONAL_TEXT_LIMIT);
  assert.ok(over.text.endsWith("…"));
});

test("wechat_personal: adapter declares private-only capability (no group on this protocol)", async () => {
  const adapter = new WechatPersonalChannelAdapter({ botToken: BOT_TOKEN_SENTINEL });
  assert.deepEqual([...adapter.capabilities], ["private"]);
  assert.equal(adapter.apiVersion, 1);
  // probe/send errors never echo the token (static reasons only).
  const notStarted = await adapter.send({ conversationId: "c", text: "x" }).then(
    () => null,
    (e: Error) => e.message,
  );
  assert.ok(notStarted && notStarted.includes("not_started"));
  assert.ok(!notStarted.includes(BOT_TOKEN_SENTINEL), "bot token leaked into send error");
  await adapter.stop(); // safe before start
});

test("wechat_personal: probe — missing token fails closed without network", async () => {
  const adapter = new WechatPersonalChannelAdapter({ botToken: " " });
  const probe = await adapter.probeCredentials();
  assert.equal(probe.ok, false);
  if (!probe.ok) assert.match(probe.reason, /missing WECHAT_PERSONAL_BOT_TOKEN/);
  await adapter.stop();
});

test("wechat_personal: factory — fail-closed without token; base url override optional", async () => {
  const factory = createWechatPersonalChannelFactory();
  assert.equal(factory.channel, "wechat_personal");
  assert.deepEqual(factory.envKeys, [WECHAT_PERSONAL_TOKEN_ENV_KEY, WECHAT_PERSONAL_BASE_URL_ENV_KEY]);
  assert.equal(factory.fromEnv({}), null);
  assert.equal(factory.fromEnv({ [WECHAT_PERSONAL_TOKEN_ENV_KEY]: "   " }), null);
  const adapter = factory.fromEnv({ [WECHAT_PERSONAL_TOKEN_ENV_KEY]: "tok" });
  assert.ok(adapter);
  assert.equal(WECHAT_PERSONAL_DEFAULT_BASE_URL, "https://ilinkai.weixin.qq.com");
  await adapter.stop();
});
