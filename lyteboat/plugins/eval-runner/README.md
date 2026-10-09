# @lyteboat/eval-runner

lyteboat's eval runner: an agent's cases, each a new session whose turns go through dsh's session controller, checked turn by turn from the session log, recorded in a real run and replayed without a model or a key; ./records reads the runs on disk and the case files for the Studio.

Part of [lyteboat](https://github.com/lyteboat/lyteboat), an agent harness for business agents built on DeepSeek Harness. Its source is [`lyteboat/plugins/eval-runner`](https://github.com/lyteboat/lyteboat/tree/master/lyteboat/plugins/eval-runner); the repository README explains how the packages fit together and how a project outside the repository installs them.
