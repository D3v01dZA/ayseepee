# TODO

## Backend
- [ ] Replace sync fs methods (`readdirSync`, `statSync`, `realpathSync`, `readFileSync`, `existsSync`) with async equivalents
- [ ] Tool execution permission flow — relay SDK permission prompts to clients via API, let web UI approve/deny
- [ ] Granular `allowedTools` support per session (not just workspace level)

## Frontend
- [ ] Chat "streaming/pending" status indicator disappears too early — keep visible until message is complete
- [ ] Persist open directory state in file picker across dialog open/close
- [ ] Show tool use events in message feed (currently only assistant text and results render)
