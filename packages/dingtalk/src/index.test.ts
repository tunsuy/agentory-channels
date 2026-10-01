import { test } from "node:test";
import assert from "node:assert/strict";
import { defineChannelContractTests } from "@agentoryhq/im-channel-contract/suite";
import {
  DINGTALK_CLIENT_ID_ENV_KEY,
  DINGTALK_CLIENT_SECRET_ENV_KEY,
  DINGTALK_TEXT_LIMIT,
  DingTalkChannelAdapter,
  classifyDingTalkSendResult,
  clampDingTalkText,
  createDingTalkChannelFactory,
  normalizeDingTalkMessage,
  type DingTalkRobotPayload,
} from "./index.js";

const SENTINEL = "FAKE-SECRET-dingtalk-sentinel";
const WEBHOOK_SENTINEL = "https://oapi.dingtalk.com/robot/sendBySession?session=FAKE-SESSION-TOKEN";

// ── Contract suite (guard tests): DWClient cannot be looped back offline and
// connect() never rejects, so create/inject are omitted — every
// credential-less guard test still runs (start fails closed on missing
// credentials BEFORE any network access).
defineChannelContractTests({
  name: "dingtalk",
  createInvalid: () => new DingTalkChannelAdapter({ clientId: "", clientSecret: SENTINEL }),
  secretSentinels: [SENTINEL],
});

function robotPayload(overrides: Partial<DingTalkRobotPayload> = {}): DingTalkRobotPayload {
  return {
    conversationId: "cidConv1",
    conversationType: "1",
    senderStaffId: "staff_001",
    senderId: "sender_001",
    senderNick: " 测试成员甲 ",
    msgId: "msg_001",
    msgtype: "text",
    text: { content: "hello" },
    createAt: 1760000000000,
    sessionWebhook: WEBHOOK_SENTINEL,
    sessionWebhookExpiredTime: Date.now() + 3_600_000,
    ...overrides,
  };
}

test("dingtalk: normalizer — private text emits a full InboundMessage", () => {
  const msg = normalizeDingTalkMessage(robotPayload({ text: { content: "  do the thing  " } }));
  assert.ok(msg);
  assert.equal(msg.channel, "dingtalk");
  assert.equal(msg.externalUserId, "staff_001");
  assert.equal(msg.externalUserName, "测试成员甲", "senderNick trimmed");
  assert.equal(msg.conversationId, "cidConv1");
  assert.equal(msg.conversationType, "private");
  assert.equal(msg.messageId, "msg_001");
  assert.equal(msg.text, "do the thing", "text must be trimmed");
  assert.equal(msg.mentionedBot, true);
  assert.equal(msg.receivedAt, new Date(1760000000000).toISOString());
});

test("dingtalk: normalizer — group payload maps conversationType '2'; senderStaffId falls back to senderId", () => {
  const group = normalizeDingTalkMessage(
    robotPayload({ conversationType: "2", conversationId: "cidGroup1" }),
  );
  assert.ok(group);
  assert.equal(group.conversationType, "group");
  const fallback = normalizeDingTalkMessage(robotPayload({ senderStaffId: undefined }));
  assert.ok(fallback);
  assert.equal(fallback.externalUserId, "sender_001", "senderId fallback keeps a stable identity");
});

test("dingtalk: normalizer — drop matrix (non-text / missing ids / unknown type / empty text)", () => {
  assert.equal(normalizeDingTalkMessage(robotPayload({ msgtype: "picture" })), null, "non-text drops");
  assert.equal(normalizeDingTalkMessage(robotPayload({ msgId: undefined })), null);
  assert.equal(normalizeDingTalkMessage(robotPayload({ conversationId: "" })), null);
  assert.equal(
    normalizeDingTalkMessage(robotPayload({ senderStaffId: " ", senderId: undefined })),
    null,
    "no stable identity drops",
  );
  assert.equal(normalizeDingTalkMessage(robotPayload({ conversationType: "3" })), null, "unknown conversationType");
  assert.equal(normalizeDingTalkMessage(robotPayload({ text: { content: "   " } })), null, "blank text drops");
  assert.equal(normalizeDingTalkMessage(robotPayload({ text: undefined })), null);
  assert.equal(normalizeDingTalkMessage({} as DingTalkRobotPayload), null, "empty payload");
});

test("dingtalk: normalizer — sessionWebhook token never reaches raw (hygiene)", () => {
  const msg = normalizeDingTalkMessage(robotPayload());
  assert.ok(msg);
  const blob = JSON.stringify(msg.raw ?? {});
  assert.ok(!blob.includes("FAKE-SESSION-TOKEN"), "session token leaked into raw");
  assert.ok(!blob.includes("session="), "webhook query leaked into raw");
});

test("dingtalk: normalizer — bad createAt falls back to now (still ISO-8601)", () => {
  const msg = normalizeDingTalkMessage(robotPayload({ createAt: Number.NaN }));
  assert.ok(msg);
  assert.ok(!Number.isNaN(Date.parse(msg.receivedAt)));
});

test("dingtalk: clamp — over-limit text truncates, at-limit passes through", () => {
  const exact = clampDingTalkText("x".repeat(DINGTALK_TEXT_LIMIT));
  assert.equal(exact.truncated, false);
  const over = clampDingTalkText("y".repeat(DINGTALK_TEXT_LIMIT + 100));
  assert.equal(over.truncated, true);
  assert.equal(over.text.length, DINGTALK_TEXT_LIMIT);
  assert.ok(over.text.endsWith("…"));
});

test("dingtalk: send classification — errcode 0 ok, flow-control errmsg rate_limited, else send_failed", () => {
  assert.equal(classifyDingTalkSendResult(0, "ok"), "ok");
  assert.equal(classifyDingTalkSendResult(130101, "send too fast"), "rate_limited");
  assert.equal(classifyDingTalkSendResult(410100, "flow control"), "rate_limited");
  assert.equal(classifyDingTalkSendResult(300001, "token is not exist"), "send_failed");
  assert.equal(classifyDingTalkSendResult(undefined, undefined), "send_failed");
});

test("dingtalk: factory — fail-closed on incomplete env; constructs when complete", async () => {
  const factory = createDingTalkChannelFactory();
  assert.equal(factory.channel, "dingtalk");
  assert.deepEqual(factory.envKeys, [DINGTALK_CLIENT_ID_ENV_KEY, DINGTALK_CLIENT_SECRET_ENV_KEY]);
  assert.equal(factory.fromEnv({}), null);
  assert.equal(factory.fromEnv({ [DINGTALK_CLIENT_ID_ENV_KEY]: "ding_fake" }), null);
  assert.equal(factory.fromEnv({ [DINGTALK_CLIENT_SECRET_ENV_KEY]: "  " }), null);
  const adapter = factory.fromEnv({
    [DINGTALK_CLIENT_ID_ENV_KEY]: "ding_fake",
    [DINGTALK_CLIENT_SECRET_ENV_KEY]: "fake-secret",
  });
  assert.ok(adapter);
  assert.equal(adapter.apiVersion, 1);
  assert.deepEqual([...adapter.capabilities], ["private", "group"]);
  await adapter.stop(); // safe before start
});

test("dingtalk: probe — missing credentials fail-closed without network", async () => {
  const adapter = new DingTalkChannelAdapter({ clientId: " ", clientSecret: "" });
  const probe = await adapter.probeCredentials();
  assert.equal(probe.ok, false);
  if (!probe.ok) assert.match(probe.reason, /missing DINGTALK_CLIENT_ID/);
  await adapter.stop();
});
