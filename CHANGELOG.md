# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/MetaMask/agent-runner/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MetaMask/agent-runner/releases/tag/v0.1.0
