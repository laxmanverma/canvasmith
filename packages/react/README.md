# @canvasmith/react

Ready-made UI for [Canvasmith](https://github.com/laxmanverma/canvasmith) — a headless image
editor on Fabric.js (20+ tools, layers, history, AI-provider seam).

```jsx
import { CanvasmithEditor } from '@canvasmith/react';
<CanvasmithEditor width={1080} height={1080} image={url} onExport={save} />
```

No React in your stack? One script tag:

```html
<script src=".../dist/standalone.js"></script>
<script>Canvasmith.mount('#editor', { width: 1080, height: 1080 });</script>
```

Full docs, demo and the headless core: **github.com/laxmanverma/canvasmith** · MIT

"text"
