# Contributing — writing a channel adapter

Thanks for building a channel for Agentory! An adapter is a **thin transport shell**: it connects to one IM platform's official API, normalizes inbound messages into the contract shape, and delivers outbound replies. Everything else (who may trigger execution, which Agent runs, what gets audited) is the control plane's job and must not be reimplemented here.

## Ground rules (non-negotiable)

1. **Official APIs only.** No hook/RPA/protocol-reverse-engineering routes (account-ban risk, legal risk). If a platform has no official bot API for a conversation shape, the adapter declares it via `capabilities` and the limitation is documented honestly (see WeChat personal: `"private"` only).
2. **Outbound transports only.** WebSocket long connections, stream modes, long polling. Adapters run inside the control-plane process and MUST NOT open inbound listeners or require public webhook endpoints (contract v1 scope).
3. **Zero real credentials** — in code, tests, fixtures, CI config, or issue comments. Tests use fake/deterministic values and loopback hooks.
4. **Credential hygiene.** Credential values never appear in thrown messages, `probeCredentials` reasons, `InboundMessage.raw`, or logs. The contract suite asserts this with sentinels.
5. **Fail-closed.** Incomplete/invalid credentials → `fromEnv` returns `null` (channel simply not registered) or `start` rejects with `ChannelAdapterError(code="credential_invalid")`. Never throw synchronously, never block control-plane startup.
6. **No product logic.** No binding checks, no tenant logic, no rate limiting, no persistence. Emit normalized messages; the control plane gates them.

## Anatomy

```ts
import {
  ADAPTER_API_VERSION, ChannelAdapterError, type ChannelAdapter,
  type ChannelAdapterFactory, type ChannelAdapterEvents, type AdapterCapability,
  type CredentialProbe, type InboundMessage, type OutboundReply, type SendResult,
} from "@agentoryhq/im-channel-contract";

export class MyChannelAdapter implements ChannelAdapter {
  readonly channel = "my_channel";            // lowercase snake_case, stable
  readonly apiVersion = ADAPTER_API_VERSION;
  readonly capabilities: readonly AdapterCapability[] = ["private", "group"];

  async start(events: ChannelAdapterEvents): Promise<void> { /* open outbound transport; idempotent */ }
  async stop(): Promise<void> { /* close; idempotent; safe before start */ }
  async send(reply: OutboundReply): Promise<SendResult> { /* not_started guard; clamp length */ }
  async probeCredentials(): Promise<CredentialProbe> { /* never throws; never echoes secrets */ }
}

export function createMyChannelAdapterFactory(): ChannelAdapterFactory {
  return {
    channel: "my_channel",
    envKeys: ["MY_CHANNEL_APP_ID", "MY_CHANNEL_APP_SECRET"],
    fromEnv(env) {
      const id = env.MY_CHANNEL_APP_ID, secret = env.MY_CHANNEL_APP_SECRET;
      if (!id || !secret) return null;        // incomplete → not registered
      return new MyChannelAdapter({ appId: id, appSecret: secret });
    },
  };
}
```

### Inbound normalization (contract rules)

- `text`: plain text, trimmed, mention markup stripped (`@bot do X` → `do X`).
- Group messages that do **not** mention the bot: dropped at the channel layer — zero emission, zero downstream persistence. Private-chat messages: always emitted.
- `messageId`: the channel-side id (control plane dedupes on it).
- `receivedAt`: ISO-8601.
- `raw`: optional diagnostics; credentials stripped.

### Errors

Reject only with `ChannelAdapterError(channel, code, message, retryable?)`. Codes: `credential_invalid` / `not_started` / `connection_lost` / `send_failed` / `rate_limited` / `internal`. Transport flaps go through `onStateChange("reconnecting")` + auto-reconnect — a single channel's outage must never affect other channels or the control-plane API surface.

## Testing your adapter

Run the shared suite (this is the AC every official package ships with):

```ts
import { defineChannelContractTests } from "@agentoryhq/im-channel-contract/suite";

defineChannelContractTests({
  name: "my_channel",
  create: () => new MyChannelAdapter(OFFLINE_TEST_OPTS),      // deterministic, no network
  createInvalid: () => new MyChannelAdapter(BAD_CREDS_OPTS),
  inject: (a, seed) => (a as MyChannelAdapter).emitInboundForTest(seed), // loopback hook
  secretSentinels: ["FAKE-SECRET-xyz"],
});
```

If your SDK cannot be looped back offline, `create`/`inject` are optional — the credential-less guard tests (identity, fail-closed probe/start, `not_started`, hygiene) still must pass, and you should add behavior tests against a local fake transport where feasible.

## Repo mechanics

- npm workspaces; each package: TypeScript strict ESM (`NodeNext`), `dist`-only `files`, `publishConfig.access: "public"`.
- `npm install && npm test` at the root must stay green (CI runs it on every push/PR).
- New packages are published as `@agentoryhq/im-channel-<name>`; the control plane pins exact versions.
- Additive contract changes only (`ADAPTER_API_VERSION` policy in README). Breaking ideas → open an issue first.

## PR checklist

- [ ] Official API only; outbound transport only; no inbound listeners
- [ ] `fromEnv` fail-closed (`null` on incomplete credentials)
- [ ] Contract suite wired and green; hygiene sentinels included
- [ ] No real credentials anywhere (grep your diff)
- [ ] `capabilities` honest about conversation shapes
- [ ] README package table updated; env keys documented
