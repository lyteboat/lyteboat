# @lyteboat/turn-outcome

lyteboat's turn outcome: the lyteboatTurnOutcomes projection folds each turn's request, counts, tool calls, and outcome from the session log once, and the turnOutcome service reads it, waits for the turn that answers a request, and folds a stored log the same way.

Part of [lyteboat](https://github.com/lyteboat/lyteboat), an agent harness for business agents built on DeepSeek Harness. Its source is [`lyteboat/plugins/turn-outcome`](https://github.com/lyteboat/lyteboat/tree/master/lyteboat/plugins/turn-outcome); the repository README explains how the packages fit together and how a project outside the repository installs them.
