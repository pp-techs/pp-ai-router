-- Extra headers sent with every upstream request of a provider, as a JSON object of name -> value.
ALTER TABLE providers ADD COLUMN headers TEXT NOT NULL DEFAULT '{}';

-- One credential's overrides of those headers; on a name both set, the credential's value wins.
ALTER TABLE credentials ADD COLUMN headers TEXT NOT NULL DEFAULT '{}';
