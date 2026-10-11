# Harness old-session compatibility fixture

This is real, unmodified JSONL session output produced by the public
`@deepseek-ai/dsh@0.2.1-alpha.1` API with the Qingzuo adapter. All messages,
plugin results, model names and API keys are synthetic; requests went only to a
local SSE fixture server. The generator ran with an empty environment and a
temporary HOME. The fixture contains no production profile or credentials.

It records a user message, `list_plugins`, `call_plugin`, the completed tool
result and an assistant reply. Tests copy both the engine JSONL and shell index
into a temporary profile, resume using the candidate version, check tool history
and assert that completed calls never replay. The same tests verify cancellation,
interrupted index state and a new approval after restart.

Keep this fixture unchanged during upgrades. Add a separately versioned fixture
only when a newly adopted baseline needs a new historical compatibility gate.
