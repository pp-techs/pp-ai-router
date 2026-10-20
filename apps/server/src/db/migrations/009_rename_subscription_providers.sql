-- Provider types renamed to the product names: anthropic-subscription -> claude-subscription.
-- (codex-subscription shipped as chatgpt-subscription, so it needs no row update.)
UPDATE providers SET type = 'claude-subscription' WHERE type = 'anthropic-subscription';
