# Third-party notices

## deepseek-ai/deepseek-harness (MIT)

Everything under `dsh/<group>/<package>` (the packages `dsh/kernel.json` lists) is imported from
https://github.com/deepseek-ai/deepseek-harness by `scripts/dist/import-upstream.ts`, at the tag
the most recent `Dist-Import` commit names (dsh-v0.2.0-rc.2, commit 639ed015), and carries
lyteboat's changes as commits on top; `src/lyteboat/` and `tests/lyteboat/` inside those packages are lyteboat's
own. Files elsewhere marked "Adapted from deepseek-ai/deepseek-harness" (or "Modeled on") in their
header are derived from the same repository at dsh-v0.2.0-rc.2 (commit 639ed015), the tag their
header names, except `lyteboat/plugins/agent-catalog/src/agent-directory.ts`: it is adapted from
packages/preset/agent-presets/src/discovery.ts and metadata.ts at dsh-v0.1.5-alpha.2 (commit
b2e3b2a0), files dsh-v0.2.0-rc.2 does not carry.

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
