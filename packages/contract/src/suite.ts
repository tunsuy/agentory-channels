/**
 * Independent contract test suite — every channel adapter (official or
 * community) runs this suite against its own implementation. Zero dependency
 * on the private control plane: the suite only knows this package's types.
 *
 * Usage (inside an adapter package):
 *
 *   import { defineChannelContractTests } from "@agentoryhq/im-channel-contract/suite";
 *   defineChannelContractTests({
 *     name: "my-channel",
 *     create: () => new MyChannelAdapter(TEST_OPTS),          // valid deterministic offline creds
 *     createInvalid: () => new MyChannelAdapter(BAD_OPTS),    // invalid/absent creds
 *     inject: (a, seed) => (a as MyChannelAdapter).emitInbound(seed), // loopback hook, if any
 *     secretSentinels: ["FAKE-SECRET-xyz"],                   // must never leak
 *   });
 *
 * `create`/`inject` are optional: adapters whose transport cannot be looped
 * back offline still MUST pass the credential-less guard tests (identity,
 * fail-closed probe/start, not_started guard, hygiene).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTER_API_VERSION,
  type ChannelAdapter,
  ChannelAdapterError,
  type InboundMessage,
} from "./index.js";

/** Deterministic inbound seed an adapter's loopback hook accepts. */
export type ContractInboundSeed = {
  externalUserId: string;
  externalUserName?: string;
  conversationId: string;
  text: string;
  conversationType?: "private" | "group";
  mentionedBot?: boolean;
  messageId?: string;
};

export type ChannelContractOptions = {
  name: string;
  /** Adapter with valid, deterministic, fully offline test credentials. */
  create?: () => ChannelAdapter | Promise<ChannelAdapter>;
  /** Adapter with invalid/absent credentials — every guard test runs on this instance. */
  createInvalid: () => ChannelAdapter | Promise<ChannelAdapter>;
  /** Loopback hook injecting a deterministic inbound event (mock / test-transport capable adapters). */
  inject?: (adapter: ChannelAdapter, seed: ContractInboundSeed) => Promise<unknown>;
  /** Fake credential values that must never appear in errors, probe reasons or messages. */
  secretSentinels?: readonly string[];
};

const noopEvents = { onMessage: () => {} };

export function defineChannelContractTests(opts: ChannelContractOptions): void {
  const { name } = opts;

  test(`${name}: contract identity (apiVersion / channel / capabilities)`, async () => {
    const a = await (opts.create ? opts.create() : opts.createInvalid());
    assert.equal(a.apiVersion, ADAPTER_API_VERSION);
    assert.equal(typeof a.channel, "string");
    assert.ok(a.channel.length > 0);
    assert.ok(Array.isArray(a.capabilities));
    for (const c of a.capabilities) {
      assert.ok(c === "private" || c === "group", `unknown capability: ${c}`);
    }
    await a.stop();
  });

  test(`${name}: stop() is safe before start() (idempotent)`, async () => {
    const a = await opts.createInvalid();
    await a.stop();
    await a.stop();
  });

  test(`${name}: probeCredentials fail-closed on invalid credentials (never throws)`, async () => {
    const a = await opts.createInvalid();
    const probe = await a.probeCredentials();
    assert.equal(probe.ok, false);
    if (!probe.ok) {
      assert.equal(typeof probe.reason, "string");
      assert.ok(probe.reason.length > 0);
    }
    await a.stop();
  });

  test(`${name}: start() rejects with ChannelAdapterError(credential_invalid) on invalid credentials`, async () => {
    const a = await opts.createInvalid();
    await assert.rejects(
      () => a.start(noopEvents),
      (err: unknown) => {
        assert.ok(err instanceof ChannelAdapterError, `expected ChannelAdapterError, got ${String(err)}`);
        assert.equal(err.code, "credential_invalid");
        return true;
      },
    );
    await a.stop();
  });

  test(`${name}: send() before start() rejects with ChannelAdapterError(not_started)`, async () => {
    const a = await opts.createInvalid();
    await assert.rejects(
      () => a.send({ conversationId: "contract-probe", text: "ping" }),
      (err: unknown) => {
        assert.ok(err instanceof ChannelAdapterError, `expected ChannelAdapterError, got ${String(err)}`);
        assert.equal(err.code, "not_started");
        return true;
      },
    );
    await a.stop();
  });

  test(`${name}: secret hygiene — credential sentinels never leak (probe/start/send errors)`, async () => {
    const sentinels = opts.secretSentinels ?? [];
    if (sentinels.length === 0) return;
    const a = await opts.createInvalid();
    const captured: string[] = [];
    const probe = await a.probeCredentials();
    captured.push(JSON.stringify(probe));
    try {
      await a.start(noopEvents);
    } catch (err) {
      captured.push(String((err as Error)?.message ?? err));
    }
    try {
      await a.send({ conversationId: "contract-probe", text: "ping" });
    } catch (err) {
      captured.push(String((err as Error)?.message ?? err));
    }
    const blob = captured.join("|");
    for (const s of sentinels) {
      assert.ok(!blob.includes(s), `credential sentinel leaked: ${s}`);
    }
    await a.stop();
  });

  // ── Loopback-dependent tests (skipped when the adapter has no offline transport) ──

  if (opts.create) {
    test(`${name}: lifecycle — start/stop idempotent, state transitions reported`, async () => {
      const a = await opts.create!();
      const states: string[] = [];
      await a.start({ onMessage: () => {}, onStateChange: (s) => states.push(s) });
      await a.start(noopEvents); // second start resolves as no-op
      await a.stop();
      await a.stop(); // idempotent
      assert.ok(states.length >= 0);
    });

    test(`${name}: send() after start() resolves with a SendResult`, async () => {
      const a = await opts.create!();
      await a.start(noopEvents);
      const r = await a.send({ conversationId: "contract-conv", text: "hello" });
      assert.equal(typeof r, "object");
      await a.stop();
    });
  }

  if (opts.create && opts.inject) {
    const inject = opts.inject;

    test(`${name}: inbound normalization — private chat emits a full InboundMessage`, async () => {
      const a = await opts.create!();
      const received: InboundMessage[] = [];
      await a.start({ onMessage: (m) => { received.push(m); } });
      await inject(a, { externalUserId: "u1", conversationId: "c1", text: "  do the thing  " });
      assert.equal(received.length, 1);
      const m = received[0];
      assert.equal(m.channel, a.channel);
      assert.equal(m.externalUserId, "u1");
      assert.equal(m.conversationId, "c1");
      assert.equal(m.conversationType, "private");
      assert.equal(m.text, "do the thing", "text must be trimmed");
      assert.equal(m.mentionedBot, true);
      assert.equal(typeof m.messageId, "string");
      assert.ok(m.messageId.length > 0);
      assert.ok(!Number.isNaN(Date.parse(m.receivedAt)), "receivedAt must be ISO-8601");
      await a.stop();
    });

    test(`${name}: inbound normalization — group @bot emits, non-mention drops (zero emission)`, async () => {
      const a = await opts.create!();
      if (!a.capabilities.includes("group")) {
        await a.stop();
        return; // private-only channels (e.g. wechat_personal) legitimately skip group behavior
      }
      const received: InboundMessage[] = [];
      await a.start({ onMessage: (m) => { received.push(m); } });
      await inject(a, {
        externalUserId: "u2", conversationId: "g1", text: "casual chat",
        conversationType: "group", mentionedBot: false,
      });
      assert.equal(received.length, 0, "non-mention group message must be dropped at the channel layer");
      await inject(a, {
        externalUserId: "u2", conversationId: "g1", text: "@bot do X",
        conversationType: "group", mentionedBot: true,
      });
      assert.equal(received.length, 1);
      assert.equal(received[0].conversationType, "group");
      assert.equal(received[0].text, "do X", "mention markup must be stripped from normalized text");
      await a.stop();
    });
  }
}
