---
"server": minor
---

Anthropic and Claude subscription: a tool whose root schema is a `oneOf`/`anyOf`/`allOf` now keeps every declaration of a property that its variants declare differently (nested `anyOf`, `allOf` for a root `allOf`) instead of the last one winning, and requires the keys every `anyOf`/`oneOf` variant requires (oh-my-pi `0d20eee217`). The opencodex changes since `994d15e8a` do not touch the Antigravity, Kiro or ChatGPT wire behaviour.
