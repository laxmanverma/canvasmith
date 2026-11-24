/* DittoProvider — Phase 4: how the parent platform (Fastrr/Ditto) consumes Canvasmith.

   Deliberately lives HERE, not in the ditto repo: the platform stays untouched until its owners
   choose to migrate. Drop this file into the platform bundle and its existing window.DittoAPI
   becomes a full Canvasmith AI provider — keys stay server-side, wallet/RBAC/asset-history all
   keep working because the calls are the same ones the current editor makes today.

     const ed = new Editor({ fabric, canvasEl, width, height });
     ed.ai.register(new DittoProvider(window.DittoAPI));

   Capability mapping (Canvasmith -> DittoAPI):
     magicEdit        -> magicEdit({ imageDataURL, instruction, maskDataURL? })
     generateImage    -> generateObject({ prompt })
     detectRegions    -> detectRegions({ imageDataURL })
     removeBackground -> segmentRegions with one full-frame product region
     describe         -> (not exposed by DittoAPI today — capability simply absent)

   magicEdit's optional 3rd argument (a mask dataURL — white = the model may repaint, black = keep
   pixel-identical) is forwarded as DittoAPI's own `maskDataURL` field whenever the Canvasmith
   caller supplies one (Editor#aiBgSwap/#aiExtendBackground do, for a masked background edit) —
   the field is simply omitted otherwise, matching every other optional-field call here.

   MIGRATION PATH for the platform, when ready:
     1. Ship @canvasmith/core alongside fabricEditor.jsx (no conflict — different globals).
     2. New surfaces (e.g. a lightweight "quick edit" modal) use Canvasmith + this provider.
     3. Port fabricEditor.jsx panels one at a time onto the Editor facade; its PaintEngine,
        history and selection logic are the SAME code, so behaviour parity is testable.
     4. Delete fabricEditor.jsx once nothing renders it. */

const strip = (d) => (d || '').split(',')[1] || d;

export class DittoProvider {
  constructor(api) {
    if (!api) throw new Error('Pass window.DittoAPI (the platform must be signed in).');
    this.api = api;
  }

  async magicEdit(imageDataURL, instruction, maskDataURL) {
    const r = await this.api.magicEdit(maskDataURL ? { imageDataURL, instruction, maskDataURL } : { imageDataURL, instruction });
    const b64 = r && (r.image_base64 || r.edited_base64);
    if (!b64) throw new Error((r && r.error) || 'Magic edit returned no image.');
    return 'data:image/png;base64,' + b64;
  }

  async generateImage(prompt) {
    const r = await this.api.generateObject({ prompt });
    const b64 = r && (r.image_base64 || r.object_base64);
    if (!b64) throw new Error((r && r.error) || 'Generation returned no image.');
    return 'data:image/png;base64,' + b64;
  }

  async detectRegions(imageDataURL) {
    const r = await this.api.detectRegions({ imageDataURL });
    return (r && r.regions) || [];
  }

  async removeBackground(imageDataURL) {
    const r = await this.api.segmentRegions({
      imageDataURL,
      regions: [{ type: 'product', bbox: { x: 0, y: 0, width: 100, height: 100 } }],
    });
    const layer = ((r && r.layers) || []).find(l => l.image_base64);
    if (!layer) throw new Error((r && r.error) || 'Segmentation returned no cutout.');
    return 'data:image/png;base64,' + strip(layer.image_base64);
  }
}
