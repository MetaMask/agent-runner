# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Optional pi Agent SDK adapter for isolated LiteLLM runs, Docker execution, structured judging, cancellation, and turn limits.
- Provider-specific runner option types with backwards-compatible Claude defaults.

### Fixed

- Scrub configured credential values from pi messages, errors, telemetry, and judge inputs, including short credentials and nested error causes.

## [0.3.1]

### Fixed

- fix: preserve caller-provided Langfuse session id in message handler ([#23](https://github.com/MetaMask/agent-runner/pull/23))

## [0.3.0]

### Added

- feat: add value-level redactor to telemetry span I/O ([#20](https://github.com/MetaMask/agent-runner/pull/20))

### Changed

- chore(deps): upgrade @anthropic-ai/claude-agent-sdk to ^0.3.220 ([#21](https://github.com/MetaMask/agent-runner/pull/21))

## [0.2.0]

### Added

- feat: add sandbox support (docker) ([#11](https://github.com/MetaMask/agent-runner/pull/11))
- feat: add license ([#10](https://github.com/MetaMask/agent-runner/pull/10))
- Docker sandbox runtime for the Claude adapter: agent runs can now
  execute inside a Docker container with a configurable workspace
  mount, additional bind mounts, env forwarding, network/user/`shm`
  overrides, setup commands, and cleanup policy. A bundled
  in-container bridge installs `@anthropic-ai/claude-agent-sdk` on the
  fly and streams SDK messages back to the host runner. The bridge's
  host-side command runner supports `AbortSignal` cancellation so
  early consumer termination (`break`, `iterator.return()`, or an
  `onMessage` handler error) tears the container down promptly.

## [0.1.0]

### Added

- feat: add llm as judge abstraction ([#4](https://github.com/MetaMask/agent-runner/pull/4))
- feat: add agent messages formatter util
- Initial release of `@metamask/agent-runner`
- `createAgentRunner()` factory with `runAgent()`, `flush()`, and `shutdown()` lifecycle API
- `ProviderAdapter` interface decoupling the runner from the Claude SDK — built-in `createClaudeAdapter()` translates raw SDK messages into a discriminated `AgentMessage` union with typed variants (`init`, `generation`, `tool_result`, `result`, `system`, `tool_progress`, `tool_use_summary`, `rate_limit`)
- `formatMessage()` utility for human-readable agent message output
- LLM-as-a-judge evaluation abstraction (`judge()`) with structured scoring, prompt-injection defence, and optional Langfuse score posting
- Optional Langfuse/OpenTelemetry telemetry with per-run span trees, reference-counted infrastructure, and sensitive-key redaction
- LiteLLM proxy support via `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` environment variables
- Dual CJS/ESM package output via `@ts-bridge/cli`

### Fixed

- fix: cleanup unused publish docs ([#8](https://github.com/MetaMask/agent-runner/pull/8))

[Unreleased]: https://github.com/MetaMask/agent-runner/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/MetaMask/agent-runner/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/MetaMask/agent-runner/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/MetaMask/agent-runner/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MetaMask/agent-runner/releases/tag/v0.1.0
