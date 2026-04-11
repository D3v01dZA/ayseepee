# TODO

## Typing
- [ ] Fix the types for controllers, strongly define what each input/output type looks like

## Backend
- [x] Replace sync fs methods (`readdirSync`, `statSync`, `realpathSync`, `readFileSync`, `existsSync`) with async equivalents
- [x] Tool execution permission flow — relay SDK permission prompts to clients via API, let web UI approve/deny
- [ ] Granular `allowedTools` support per session (not just workspace level)

## Frontend
- [x] Chat "streaming/pending" status indicator disappears too early — keep visible until message is complete
- [x] Show tool use events in message feed (currently only assistant text and results render)

## Token Usage
- [ ] Use https://github.com/JuliusBrussee/caveman
