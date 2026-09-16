# Third-party notices

## humanize-korean (Humanize KR / im-not-ai)

The Korean polishing rule set used by the Polish feature — translationese
patterns (`~을 통해`, `~에 대해`, `~에 있어서`, `~에 의해`, `가지고 있다`), AI
filler phrases (`결론적으로`, `주목할 만하다`, `시사하는 바가 크다`), passive and
nominalisation overuse, repeated sentence openings, and the meaning-preservation
checklist — is adapted from the `humanize-korean` skill.

- Project: im-not-ai / Humanize KR
- Author: epoko77-ai
- Repository: https://github.com/epoko77-ai/im-not-ai
- Version inspected: Claude Web skill package v1 (based on upstream v2.3.2)
- License: MIT

WorkLens adapts the rules rather than copying the package: the detection
categories and the "meaning first, minimal edit" principles are reused in
`src/lib/ai/polish-prompt.ts`, while structure rewriting, rhythm variation and
bullet/heading restructuring are deliberately not applied, and every model
answer is re-checked by `src/lib/polish/protect.ts` so document facts,
quotations and statement strength cannot change. No upstream file is vendored
into this repository.

```
MIT License

Copyright (c) 2026 epoko77-ai

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
