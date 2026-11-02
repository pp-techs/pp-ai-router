---
"server": patch
---

Fix Antigravity OAuth onboarding always requesting the `free-tier` instead of the account's actual default tier. `loadCodeAssist` now reads `allowedTiers` to find the entry with `isDefault: true` and passes that tier id to `onboardUser`; an account whose default allowed tier isn't free previously risked onboarding under the wrong tier.
