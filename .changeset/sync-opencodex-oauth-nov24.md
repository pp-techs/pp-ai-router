---
"server": patch
---

Sync subscription providers with opencodex v2.100.6-52 (`9e0e298ef`, no new commits) and oh-my-pi 19.1.1 (`31ffee513f`).

ChatGPT subscription: a tool schema `pattern` (or `patternProperties` key) with an unescaped `[` inside a character class, such as `^[^[\]]*$`, is now dropped like the lookaround patterns already were — OpenAI's validator reads it as a nested class and refuses the whole request; the user agent follows omp 19.1.1 (`omp/19.1.1`).

Claude subscription, Antigravity and Kiro: no wire change. The four OAuth flows were re-verified and needed no change.
