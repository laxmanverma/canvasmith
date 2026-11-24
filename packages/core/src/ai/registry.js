/* AI provider seam.

   The editor never talks to a model directly — it calls whatever provider the host registered.
   That is what makes this library open-sourceable: a SaaS host plugs its own backend in (keys
   stay server-side), an indie user plugs in the bundled Gemini provider with their free
   AI-Studio key, and with no provider at all every AI affordance simply reports itself
   unavailable instead of breaking the editor.

   A provider implements any subset of CAPABILITIES; hosts feature-test with `ai.can(name)`.
   All methods are async and speak dataURLs in, dataURLs out. */

export const CAPABILITIES = [
  'magicEdit',        // (imageDataURL, instruction, maskDataURL?) -> imageDataURL   free-text edit,
                       //   optionally mask-guided (white = the model may repaint, black = keep
                       //   pixel-identical) — the 3rd argument is optional and additive: a provider
                       //   that only reads (imageDataURL, instruction) keeps working unchanged, it
                       //   just ignores the mask a caller passes. AIRegistry#run forwards whatever
                       //   args a caller supplies, so no registry change was needed to add this.
                       //   An optional 4th argument {reference} (an image dataURL) is a style/
                       //   content reference the model should take cues from; same additive rule.
  'generateImage',    // (prompt, opts)              -> imageDataURL   text-to-image insert
                       //   (opts.reference: optional reference image dataURL)
  'enhancePrompt',    // (text, opts)                -> string         rewrite a short edit request
                       //   into a clearer, more specific instruction (opts.kind: 'edit'|'background')
  'removeBackground', // (imageDataURL)              -> imageDataURL   subject cutout with alpha
  'detectRegions',    // (imageDataURL)              -> [{type,bbox:{x,y,width,height in %},content?}]
  'describe',         // (imageDataURL)              -> string         alt-text / layer naming
  'locateObject',     // (imageDataURL, description) -> {x,y,width,height in %} | null   where a named
                       //   thing ("the dog") is in the picture; the editor refines the box with GrabCut
  'interpretCommand', // (transcript, ctx)           -> [{action,...}] free-form spoken/typed request
                       //   -> editor commands (the voice.js vocabulary). Text only, no image. The
                       //   caller validates every command, so a provider can't run anything off-list.
];

export class AIRegistry {
  constructor() { this._provider = null; }

  register(provider) {
    this._provider = provider || null;
    return this;
  }

  provider() { return this._provider; }

  can(capability) {
    return !!(this._provider && typeof this._provider[capability] === 'function');
  }

  capabilities() {
    return CAPABILITIES.filter(c => this.can(c));
  }

  /* Uniform call site: {status:'ok', result} | {status:'error', reason}. Never throws — an AI
     hiccup must never take the canvas down with it. */
  async run(capability, ...args) {
    if (!this.can(capability)) {
      return { status: 'error', reason: 'no_provider', message: 'No AI provider offers ' + capability + '. Register one with editor.ai.register(...).' };
    }
    try {
      const result = await this._provider[capability](...args);
      return { status: 'ok', result };
    } catch (e) {
      return { status: 'error', reason: e && e.code === 429 ? 'rate_limited' : 'provider_failed', message: String(e && e.message || e).slice(0, 300) };
    }
  }
}
