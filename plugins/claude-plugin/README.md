# Canvasmith for Claude (plugin)

Opens the Canvasmith image editor inside the conversation. Ask Claude to open a photo or start a blank canvas.
Exports are saved to `~/Pictures/Canvasmith` (override with `CANVASMITH_OUTPUT_DIR`). Everything runs locally.

Requires Node 20+.

```
/plugin marketplace add Rizwanhoda/canvasmith
/plugin install canvasmith@canvasmith
```

`server/` is generated from `plugins/claude-extension` by `npm run sync:plugin` there. Don't edit it by hand.
