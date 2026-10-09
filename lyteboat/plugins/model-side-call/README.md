# @lyteboat/model-side-call

lyteboat's side model calls: one prompt a plugin sends for an agent (a routing decision, an intake classification) under its own deadline, recorded in the agent's session as an ignorable lyteboat/aux-llm-call record. Config: reasoningEffort, the effort every side call requests (an id the routes' adapter defines).

Part of [lyteboat](https://github.com/lyteboat/lyteboat), an agent harness for business agents built on DeepSeek Harness. Its source is [`lyteboat/plugins/model-side-call`](https://github.com/lyteboat/lyteboat/tree/master/lyteboat/plugins/model-side-call); the repository README explains how the packages fit together and how a project outside the repository installs them.
