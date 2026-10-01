import { test } from "node:test";
import assert from "node:assert/strict";
import { defineChannelContractTests } from "@agentoryhq/im-channel-contract/suite";
import {
  FEISHU_APP_ID_ENV_KEY,
  FEISHU_APP_SECRET_ENV_KEY,
  FEISHU_TEXT_LIMIT,
  FeishuChannelAdapter,
  clampFeishuText,
  createFeishuChannelFactory,
  normalizeFeishuEvent,
  type FeishuInboundEvent,
} from "./index.js";

const SENTINEL = "FAKE-SECRET-feishu-sentinel";

// ── Contract suite (guard tests): WSClient cannot be looped back offline, so
// create/inject are omitted — every credential-less guard test still runs.
defineChannelContractTests({
  name: "feishu",
  createInvalid: () => new FeishuChannelAdapter({ appId: "", appSecret: SENTINEL }),
  secretSentinels: [SENTINEL],
});

function textEvent(overrides: {
  chatType?: string;
  text?: string;
  mentions?: Array<{ key: string; name: string }>;
  senderType?: string;
  messageType?: string;
  content?: string;
} = {}): FeishuInboundEvent {
  return {
    sender: {
      sender_id: { open_id: "ou_user_1" },
      sender_type: overrides.senderType ?? "user",
    },
    message: {
      message_id: "om_msg_1",
      chat_id: "oc_chat_1",
      chat_type: overrides.chatType ?? "p2p",
      message_type: overrides.messageType ?? "text",
      content: overrides.content ?? JSON.stringify({ text: overrides.text ?? "hello" }),
      create_time: "1760000000000",
      ...(overrides.mentions ? { mentions: overrides.mentions } : {}),
    },
  };
}

test("feishu: normalizer — private text emits a full InboundMessage", () => {
  const msg = normalizeFeishuEvent(textEvent({ text: "  do the thing  " }));
  assert.ok(msg);
  assert.equal(msg.channel, "feishu");
  assert.equal(msg.externalUserId, "ou_user_1");
  assert.equal(msg.conversationId, "oc_chat_1");
  assert.equal(msg.conversationType, "private");
  assert.equal(msg.messageId, "om_msg_1");
  assert.equal(msg.text, "do the thing", "text must be trimmed");
  assert.equal(msg.mentionedBot, true);
  assert.equal(msg.receivedAt, new Date(1760000000000).toISOString());
  assert.ok(!JSON.stringify(msg.raw ?? {}).includes(SENTINEL));
});

test("feishu: normalizer — group @bot emits with mention keys stripped; non-mention drops", () => {
  const mentioned = normalizeFeishuEvent(
    textEvent({
      chatType: "group",
      text: "@_user_1   summarize the release notes ",
      mentions: [{ key: "@_user_1", name: "Agentory Bot" }],
    }),
  );
  assert.ok(mentioned);
  assert.equal(mentioned.conversationType, "group");
  assert.equal(mentioned.text, "summarize the release notes", "mention markup stripped");

  const casual = normalizeFeishuEvent(textEvent({ chatType: "group", text: "casual chat" }));
  assert.equal(casual, null, "non-mention group message must be dropped at the channel layer");

  const bare = normalizeFeishuEvent(
    textEvent({ chatType: "group", text: "@_user_1", mentions: [{ key: "@_user_1", name: "B" }] }),
  );
  assert.equal(bare, null, "bare mention without instruction drops");
});

test("feishu: normalizer — drop matrix (bot sender / non-text / malformed / unknown chat)", () => {
  assert.equal(normalizeFeishuEvent(textEvent({ senderType: "bot" })), null, "bot echo drops");
  assert.equal(normalizeFeishuEvent(textEvent({ messageType: "image", content: "{}" })), null);
  assert.equal(normalizeFeishuEvent(textEvent({ content: "not-json" })), null);
  assert.equal(normalizeFeishuEvent(textEvent({ content: JSON.stringify({ text: 42 }) })), null);
  assert.equal(normalizeFeishuEvent(textEvent({ chatType: "topic" })), null, "unknown chat_type");
  const noSender = normalizeFeishuEvent({
    sender: { sender_type: "user" },
    message: { message_id: "om1", chat_id: "oc1", chat_type: "p2p", message_type: "text", content: '{"text":"hi"}' },
  });
  assert.equal(noSender, null, "missing open_id is unattributable");
  assert.equal(normalizeFeishuEvent({}), null, "empty event");
});

test("feishu: normalizer — bad create_time falls back to now (still ISO-8601)", () => {
  const ev = textEvent();
  ev.message!.create_time = "not-a-number";
  const msg = normalizeFeishuEvent(ev);
  assert.ok(msg);
  assert.ok(!Number.isNaN(Date.parse(msg.receivedAt)));
});

test("feishu: clamp — over-limit text truncates, at-limit passes through", () => {
  const exact = clampFeishuText("x".repeat(FEISHU_TEXT_LIMIT));
  assert.equal(exact.truncated, false);
  const over = clampFeishuText("y".repeat(FEISHU_TEXT_LIMIT + 100));
  assert.equal(over.truncated, true);
  assert.equal(over.text.length, FEISHU_TEXT_LIMIT, "clamp keeps the documented limit");
  assert.ok(over.text.endsWith("…"));
});

test("feishu: factory — fail-closed on incomplete env; constructs when complete", async () => {
  const factory = createFeishuChannelFactory();
  assert.equal(factory.channel, "feishu");
  assert.deepEqual(factory.envKeys, [FEISHU_APP_ID_ENV_KEY, FEISHU_APP_SECRET_ENV_KEY]);
  assert.equal(factory.fromEnv({}), null);
  assert.equal(factory.fromEnv({ [FEISHU_APP_ID_ENV_KEY]: "cli_fake" }), null);
  assert.equal(factory.fromEnv({ [FEISHU_APP_SECRET_ENV_KEY]: "  " }), null);
  const adapter = factory.fromEnv({
    [FEISHU_APP_ID_ENV_KEY]: "cli_fake",
    [FEISHU_APP_SECRET_ENV_KEY]: "fake-secret",
  });
  assert.ok(adapter);
  assert.equal(adapter.apiVersion, 1);
  assert.deepEqual([...adapter.capabilities], ["private", "group"]);
  await adapter.stop(); // safe before start
});

test("feishu: probe — missing credentials fail-closed without network", async () => {
  const adapter = new FeishuChannelAdapter({ appId: " ", appSecret: "" });
  const probe = await adapter.probeCredentials();
  assert.equal(probe.ok, false);
  if (!probe.ok) assert.match(probe.reason, /missing FEISHU_APP_ID/);
  await adapter.stop();
});
