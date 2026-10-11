# Harness pending-tool compatibility fixture

This is real JSONL output generated with the public
`@deepseek-ai/dsh@0.2.1-alpha.1` API and the Qingzuo adapter. The generator ran
in a private temporary HOME with API keys, user profiles and npm configuration
removed from the child environment. A local SSE fixture supplied every model
response; messages, model names, plugin metadata and results are synthetic.
The fixture contains no production credentials or profile data.

The model requested `call_plugin` with provider call ID `old-pending-call`.
The call entered `PluginApprovals` and was still awaiting human confirmation.
The generator flushed the official session persistence service, then copied
`ai/sessions.json` and `session.v4.jsonl` **before** cancelling or disposing the
agent. The JSONL ends at `tool/call`: there is no tool result, step end or turn
end. The shell index also records the tool and turn as running.

Tests copy the frozen files into a temporary profile and resume the agent. They
verify that the old request cannot execute or restore its prior authorization,
and that a new request executes only after fresh human confirmation. Keep this
fixture unchanged when validating candidate versions; regenerating it with the
candidate would remove the historical format and recovery check.
