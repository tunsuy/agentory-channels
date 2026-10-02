# agentory-channels

Open-source IM channel adapters for **[Agentory](https://github.com/tunsuy/agentory-node)** — let platform-managed Agents be driven from WeChat (personal), WeCom, Feishu (Lark) and DingTalk: DM the bot or @-mention it in a group, execution results flow back into the origin conversation.

This repo holds the **channel transport layer only**: the `ChannelAdapter` contract, official reference implementations, a deterministic mock channel, and an independent contract test suite. It is the sibling of [`agentory-node`](https://github.com/tunsuy/agentory-node) (runtime adapters, open source) — same "contract & core separation" boundary.

## Boundary — what lives where

| In this repo (open source, Apache-2.0) | In the private Agentory control plane |
|---|---|
| `ChannelAdapter` contract + `ADAPTER_API_VERSION` (additive evolution) | Identity binding gate (IM identity ↔ workspace member, fail-closed) |
| Official channel reference implementations (Feishu / DingTalk / WeCom / WeChat personal) | Tenant isolation, conversation targeting, default-Agent routing |
| Mock channel package (smoke/dev carrier) | Auditing, rate limiting, message domain & execution chain |
| Independent contract test suite (zero control-plane dependency) | Channel registry & credential injection (`buildChannelRegistryFromEnv`) — loads packages from this repo as **pinned npm dependencies** |
| This README + contribution guide | Console UI ("IM Channels" page) |

Adapters run **inside the control-plane process**. Every transport is an outbound long-lived connection or long poll — adapters never open inbound listeners (no public webhook endpoints), and never talk to Agent nodes.

**Hard red lines for this repo** (enforced in review and by the contract suite):

- Zero private control-plane logic (binding / targeting / auditing / rate limiting) — adapters are thin transport shells.
- Zero real credentials or credential samples anywhere (code, tests, fixtures, CI).
- Credential values never appear in error messages, probe reasons, inbound `raw` payloads, or logs (the contract suite runs hygiene sentinels against every adapter).

## Packages

| Package | npm | Status |
|---|---|---|
| `packages/contract` — `ChannelAdapter` port + contract test suite | `@agentoryhq/im-channel-contract` | published · npm `0.1.0` |
| `packages/mock` — deterministic mock channel (env-gated; production never registers it) | `@agentoryhq/im-channel-mock` | published · npm `0.1.0` |
| `packages/feishu` — Feishu/Lark (`@larksuiteoapi/node-sdk`, WSClient long connection) | `@agentoryhq/im-channel-feishu` | published · npm `0.1.0` |
| `packages/dingtalk` — DingTalk (`dingtalk-stream`, Stream mode WSClient; replies via per-conversation sessionWebhook) | `@agentoryhq/im-channel-dingtalk` | published · npm `0.1.0` |
| `packages/wecom` — WeCom (`@wecom/aibot-node-sdk`, WebSocket; active-send is markdown-only per protocol) | `@agentoryhq/im-channel-wecom` | published · npm `0.1.0` |
| `packages/wechat-personal` — personal WeChat (iLink bot CGI protocol, outbound long-poll; clean-room reimplementation — the official plugin is OpenClaw-host-coupled. **1:1 private chat only**) | `@agentoryhq/im-channel-wechat-personal` | published · npm `0.1.0` |

## Develop

```bash
npm install
npm run build
npm test        # contract suite + mock behavior tests (node --test)
```

Node >= 20. Workspaces are plain npm workspaces; TypeScript strict, ESM (`NodeNext`).

## Write a channel adapter

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide. Short version:

1. Implement `ChannelAdapter` (+ a `ChannelAdapterFactory` whose `fromEnv` returns `null` on incomplete credentials — fail-closed, never blocks startup).
2. Normalize inbound per the contract: trim, strip mention markup, drop non-mention group messages at the channel layer.
3. Run `defineChannelContractTests` from `@agentoryhq/im-channel-contract/suite` against your implementation in your package's tests.
4. Outbound transports only; keep credentials out of every error surface.

## Versioning

`ADAPTER_API_VERSION` (currently `1`) evolves **additively only** — same policy as `@agentoryhq/runtime-contract`. The control plane pins exact package versions (`package-lock.json`), so publishing here never silently changes a deployment.

## License

Apache-2.0 — see [LICENSE](LICENSE).
