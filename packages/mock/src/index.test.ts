import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTER_API_VERSION,
  ChannelAdapterError,
  KnownChannel,
  type InboundMessage,
} from "@agentoryhq/im-channel-contract";
import { defineChannelContractTests } from "@agentoryhq/im-channel-contract/suite";
import {
  MOCK_FAIL_PREFIX,
  MOCK_LIMIT_PREFIX,
  MockChannelAdapter,
  createMockChannelAdapterFactory,
} from "./index.js";

const SENTINEL = "FAKE-SECRET-SENTINEL-9f3c";

// ── Shared contract suite (the same suite every channel package runs) ──

defineChannelContractTests({
  name: "mock",
  create: () => new MockChannelAdapter({ secretValue: SENTINEL }),
  createInvalid: () => new MockChannelAdapter({ credentials: "invalid", secretValue: SENTINEL }),
  inject: (a, seed) => (a as MockChannelAdapter).emitInbound(seed),
  secretSentinels: [SENTINEL],
});

// ── Mock-specific behavior (smoke carrier semantics) ──

test("mock: factory is env-gated to zero registration in production", () => {
  const f = createMockChannelAdapterFactory();
  assert.equal(f.channel, KnownChannel.Mock);
  assert.equal(f.fromEnv({}), null, "unset IM_CHANNEL_MOCK → not registered");
  assert.equal(f.fromEnv({ IM_CHANNEL_MOCK: "0" }), null);
  const a = f.fromEnv({ IM_CHANNEL_MOCK: "1" });
  assert.ok(a instanceof MockChannelAdapter);
  assert.equal(a.apiVersion, ADAPTER_API_VERSION);
});

test("mock: factory maps IM_CHANNEL_MOCK_CREDENTIALS=invalid to fail-closed adapter", async () => {
  const f = createMockChannelAdapterFactory();
  const a = f.fromEnv({ IM_CHANNEL_MOCK: "1", IM_CHANNEL_MOCK_CREDENTIALS: "invalid" });
  assert.ok(a);
  const probe = await a.probeCredentials();
  assert.equal(probe.ok, false);
});

test("mock: probeCredentials ok on valid credentials", async () => {
  const a = new MockChannelAdapter();
  assert.deepEqual(await a.probeCredentials(), { ok: true });
});

test("mock: emitInbound normalizes private chat and reaches onMessage once", async () => {
  const a = new MockChannelAdapter();
  const received: InboundMessage[] = [];
  await a.start({ onMessage: (m) => { received.push(m); } });
  const emitted = await a.emitInbound({ externalUserId: "u1", conversationId: "c1", text: "查一下构建" });
  assert.ok(emitted);
  assert.equal(received.length, 1);
  assert.equal(received[0].channel, KnownChannel.Mock);
  assert.equal(received[0].conversationType, "private");
  assert.equal(received[0].mentionedBot, true);
  assert.equal(received[0].text, "查一下构建");
});

test("mock: group inbound — @bot emits with mention stripped, non-mention drops", async () => {
  const a = new MockChannelAdapter();
  const received: InboundMessage[] = [];
  await a.start({ onMessage: (m) => { received.push(m); } });
  const dropped = await a.emitInbound({
    externalUserId: "u2", conversationId: "g1", text: "随便聊聊",
    conversationType: "group", mentionedBot: false,
  });
  assert.equal(dropped, null);
  assert.equal(received.length, 0);
  const kept = await a.emitInbound({
    externalUserId: "u2", conversationId: "g1", text: "@bot 跑一下测试",
    conversationType: "group", mentionedBot: true,
  });
  assert.ok(kept);
  assert.equal(received.length, 1);
  assert.equal(received[0].text, "跑一下测试");
});

test("mock: emitInbound before start rejects with not_started", async () => {
  const a = new MockChannelAdapter();
  await assert.rejects(
    () => a.emitInbound({ externalUserId: "u1", conversationId: "c1", text: "x" }),
    (err: unknown) => err instanceof ChannelAdapterError && err.code === "not_started",
  );
});

test("mock: send captures replies and returns deterministic channelMessageId", async () => {
  const a = new MockChannelAdapter();
  await a.start({ onMessage: () => {} });
  const r1 = await a.send({ conversationId: "c1", text: "结果 A" });
  const r2 = await a.send({ conversationId: "c1", text: "结果 B" });
  assert.equal(r1.channelMessageId, "mock-out-1");
  assert.equal(r2.channelMessageId, "mock-out-2");
  assert.equal(a.sent.length, 2);
  assert.equal(a.sent[1].text, "结果 B");
});

test("mock: deterministic failure carriers (MOCK_FAIL / MOCK_LIMIT)", async () => {
  const a = new MockChannelAdapter();
  await a.start({ onMessage: () => {} });
  await assert.rejects(
    () => a.send({ conversationId: "c1", text: `${MOCK_FAIL_PREFIX}boom` }),
    (err: unknown) => err instanceof ChannelAdapterError && err.code === "send_failed" && err.retryable === false,
  );
  await assert.rejects(
    () => a.send({ conversationId: "c1", text: `${MOCK_LIMIT_PREFIX}slow down` }),
    (err: unknown) => err instanceof ChannelAdapterError && err.code === "rate_limited" && err.retryable === true,
  );
  assert.equal(a.sent.length, 0, "failed sends are not captured");
});

test("mock: state transitions and transport errors surface via callbacks", async () => {
  const a = new MockChannelAdapter();
  const states: string[] = [];
  const errors: ChannelAdapterError[] = [];
  await a.start({
    onMessage: () => {},
    onStateChange: (s) => states.push(s),
    onError: (e) => errors.push(e),
  });
  a.simulateState("reconnecting");
  a.simulateError("connection_lost", "socket closed", true);
  await a.stop();
  assert.deepEqual(states, ["connected", "reconnecting", "disconnected"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "connection_lost");
  assert.equal(errors[0].retryable, true);
});

test("mock: stored secret value never appears in any emitted surface", async () => {
  const a = new MockChannelAdapter({ secretValue: SENTINEL });
  const received: InboundMessage[] = [];
  await a.start({ onMessage: (m) => { received.push(m); } });
  await a.emitInbound({ externalUserId: "u1", conversationId: "c1", text: "hi" });
  await a.send({ conversationId: "c1", text: "ok" });
  const probe = await a.probeCredentials();
  const blob = JSON.stringify({ received, sent: a.sent, probe });
  assert.ok(!blob.includes(SENTINEL));
});
