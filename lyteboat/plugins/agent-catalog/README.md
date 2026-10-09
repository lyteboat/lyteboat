# @lyteboat/agent-catalog

lyteboat's agent catalog: scans agent roots, reads each agent's manifest (agent.yml), declares each agent directory to dsh's agent preset registry with the directory as its base URL, and reports the agents that fail to read or mount.

Part of [lyteboat](https://github.com/lyteboat/lyteboat), an agent harness for business agents built on DeepSeek Harness. Its source is [`lyteboat/plugins/agent-catalog`](https://github.com/lyteboat/lyteboat/tree/master/lyteboat/plugins/agent-catalog); the repository README explains how the packages fit together and how a project outside the repository installs them.
