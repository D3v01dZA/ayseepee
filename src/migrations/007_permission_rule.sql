-- Store the allow rule pattern and scope on permission requests
ALTER TABLE permission_requests ADD COLUMN rule_pattern TEXT;
ALTER TABLE permission_requests ADD COLUMN rule_scope TEXT;
