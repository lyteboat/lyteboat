# @lyteboat/history-import

lyteboat's external history import: entries grouped into rounds by trace id (half rounds dropped, the first duplicate role kept, ordered by create time); each round a session lacks, by trace id, queued as a turn of its own and answered on the lyteboat/intake waterfall without a model request.

Part of [lyteboat](https://github.com/lyteboat/lyteboat), an agent harness for business agents built on DeepSeek Harness. Its source is [`lyteboat/plugins/history-import`](https://github.com/lyteboat/lyteboat/tree/master/lyteboat/plugins/history-import); the repository README explains how the packages fit together and how a project outside the repository installs them.
