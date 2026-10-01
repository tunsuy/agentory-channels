import { test } from "node:test";
import assert from "node:assert/strict";
import { defineChannelContractTests } from "@agentoryhq/im-channel-contract/suite";
import {
  WECOM_AIBOT_BOT_ID_ENV_KEY,
  WECOM_AIBOT_SECRET_ENV_KEY,
  WECOM_TEXT_LIMIT,
  WecomChannelAdapter,
  classifyWecomSendError,
  clampWecomText,
  createWecomChannelFactory,
  normalizeWecomMessage,
  type WecomTextFrame,
} from "./index.js";

const SENTINEL = "FAKE-SECRET-wecom-sentinel";
const RESPONSE_URL_SENTINEL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=FAKE-KEY";

// ── Contract suite (guard tests): the WSClient transport cannot be looped
// back offline, so create/inject are omitted — every credential-less guard
// test still runs (start fails closed on missing credentials BEFORE any
// network access).
defineChannelContractTests({
  name: "wecom",
  createInvalid: () => new WecomChannelAdapter({ botId: "", secret: SENTINEL }),
  secretSentinels: [SENTINEL],
});

function textFrame(overrides: Partial<NonNullable<WecomTextFrame["body"]>> = {}): WecomTextFrame {
  return {
    headers: { req_id: "req_1" },
    body: {
      msgid: "wxmsg_001",
      aibotid: "aibot_1",
      chattype: "single",
      from: { userid: "wxuser_001" },
      msgtype: "text",
      text: { content: "hello" },
      create_time: 1760000000,
      response_url: RESPONSE_URL_SENTINEL,
      ...overrides,
    },
  };
}

test("wecom: normalizer — single chat uses from.userid as conversation key (no chatid on the wire)", () => {
  const msg = normalizeWecomMessage(textFrame({ text: { content: "  do the thing  " } }));
  assert.ok(msg);
  assert.equal(msg.channel, "wecom");
  assert.equal(msg.externalUserId, "wxuser_001");
  assert.equal(msg.conversationId, "wxuser_001", "single-chat conversation key = from.userid");
  assert.equal(msg.conversationType, "private");
  assert.equal(msg.messageId, "wxmsg_001");
  assert.equal(msg.text, "do the thing", "text must be trimmed");
  assert.equal(msg.mentionedBot, true);
  assert.equal(msg.externalUserName, undefined, "protocol has no display name — omitted honestly");
  assert.equal(msg.receivedAt, new Date(1760000000 * 1000).toISOString(), "seconds → ISO");
});

test("wecom: normalizer — group message keys on chatid; ms timestamps pass through", () => {
  const group = normalizeWecomMessage(
    textFrame({ chattype: "group", chatid: "wr_group_1", create_time: 1760000000000 }),
  );
  assert.ok(group);
  assert.equal(group.conversationType, "group");
  assert.equal(group.conversationId, "wr_group_1");
  assert.equal(group.receivedAt, new Date(1760000000000).toISOString());
});

test("wecom: normalizer — drop matrix (non-text / missing ids / group without chatid / empty text)", () => {
  assert.equal(normalizeWecomMessage(textFrame({ msgtype: "image" })), null, "non-text drops");
  assert.equal(normalizeWecomMessage(textFrame({ msgid: undefined })), null);
  assert.equal(normalizeWecomMessage(textFrame({ from: undefined })), null);
  assert.equal(normalizeWecomMessage(textFrame({ from: { userid: "  " } })), null);
  assert.equal(normalizeWecomMessage(textFrame({ chattype: "group" })), null, "group without chatid drops");
  assert.equal(normalizeWecomMessage(textFrame({ chattype: "unknown" })), null, "unknown chattype drops");
  assert.equal(normalizeWecomMessage(textFrame({ text: { content: "   " } })), null, "blank text drops");
  assert.equal(normalizeWecomMessage(textFrame({ text: undefined })), null);
  assert.equal(normalizeWecomMessage({}), null, "body-less frame drops");
});

test("wecom: normalizer — response_url never reaches raw (hygiene)", () => {
  const msg = normalizeWecomMessage(textFrame());
  assert.ok(msg);
  const blob = JSON.stringify(msg);
  assert.ok(!blob.includes("FAKE-KEY"), "temporary reply URL leaked");
  assert.ok(!blob.includes("response_url"), "response_url field leaked");
});

test("wecom: normalizer — missing create_time falls back to now (still ISO-8601)", () => {
  const msg = normalizeWecomMessage(textFrame({ create_time: undefined }));
  assert.ok(msg);
  assert.ok(!Number.isNaN(Date.parse(msg.receivedAt)));
});

test("wecom: clamp — over-limit text truncates, at-limit passes through", () => {
  const exact = clampWecomText("x".repeat(WECOM_TEXT_LIMIT));
  assert.equal(exact.truncated, false);
  const over = clampWecomText("y".repeat(WECOM_TEXT_LIMIT + 100));
  assert.equal(over.truncated, true);
  assert.equal(over.text.length, WECOM_TEXT_LIMIT);
  assert.ok(over.text.endsWith("…"));
});

test("wecom: send classification — auth exhausted is credential_invalid, others honest send_failed", () => {
  const auth = classifyWecomSendError(Object.assign(new Error("auth failed"), { code: "WS_AUTH_FAILURE_EXHAUSTED" }));
  assert.equal(auth.code, "credential_invalid");
  assert.equal(auth.retryable, false);
  const generic = classifyWecomSendError(new Error("reply timeout"));
  assert.equal(generic.code, "send_failed");
  assert.equal(generic.retryable, true);
  const limited = classifyWecomSendError(new Error("message frequency limit exceeded"));
  assert.equal(limited.code, "rate_limited");
});

test("wecom: factory — fail-closed on incomplete env; constructs when complete", async () => {
  const factory = createWecomChannelFactory();
  assert.equal(factory.channel, "wecom");
  assert.deepEqual(factory.envKeys, [WECOM_AIBOT_BOT_ID_ENV_KEY, WECOM_AIBOT_SECRET_ENV_KEY]);
  assert.equal(factory.fromEnv({}), null);
  assert.equal(factory.fromEnv({ [WECOM_AIBOT_BOT_ID_ENV_KEY]: "aibot_fake" }), null);
  assert.equal(factory.fromEnv({ [WECOM_AIBOT_SECRET_ENV_KEY]: "  " }), null);
  const adapter = factory.fromEnv({
    [WECOM_AIBOT_BOT_ID_ENV_KEY]: "aibot_fake",
    [WECOM_AIBOT_SECRET_ENV_KEY]: "fake-secret",
  });
  assert.ok(adapter);
  assert.equal(adapter.apiVersion, 1);
  assert.deepEqual([...adapter.capabilities], ["private", "group"]);
  await adapter.stop(); // safe before start
});

test("wecom: probe — missing credentials fail-closed without network", async () => {
  const adapter = new WecomChannelAdapter({ botId: " ", secret: "" });
  const probe = await adapter.probeCredentials();
  assert.equal(probe.ok, false);
  if (!probe.ok) assert.match(probe.reason, /missing WECOM_AIBOT_BOT_ID/);
  await adapter.stop();
});
