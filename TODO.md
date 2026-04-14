# TODO

## Backend
- [x] Replace sync fs methods (`readdirSync`, `statSync`, `realpathSync`, `readFileSync`, `existsSync`) with async equivalents
- [x] Tool execution permission flow — relay SDK permission prompts to clients via API, let web UI approve/deny
- [x] Granular `allowedTools` support per session (not just workspace level)

## Frontend
- [x] Chat "streaming/pending" status indicator disappears too early — keep visible until message is complete
- [x] Show tool use events in message feed (currently only assistant text and results render)
- [x] Make mobile friendly with hamburger menu
- [ ] File explorer
- [ ] Diff viewer 
- [x] Allowed tools whitelisting in execute dialog
- [ ] File upload/download
- [x] Formatting of responses. ``` should be a code block?
- [x] Show context window usage?

## Misc
- [ ] Use https://github.com/JuliusBrussee/caveman
- [x] Fix the types for controllers, strongly define what each input/output type looks like
- [x] Message queueing?
- [x] Message interrupt?
- [x] Clean up stale queries on startup
- [ ] Make sure the API and Views can do the same "stuff"
