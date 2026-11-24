/* @canvasmith/core — headless image-editor engine on Fabric.js.
   Use the Editor facade for everything, or import the pieces and build your own. */

export { Editor, ALL_TOOLS, SEL_TOOLS, SHAPE_TOOLS, REGION_ROLE, REGION_COLOR, REGION_NAME, REGION_FILL_ALPHA, outlineRegion } from './editor.js';
export { PaintEngine, PAINT_TOOLS, renderObjectsFlat } from './engine.js';
export { History } from './history.js';
export {
  startSelection, updateSelection, finalizeSelection,
  selectionToPath2D, selectionFillRule, floodSelectPolygon, wandSelect,
  startPolyBuild, polyBuildAdd, polyBuildPreview, finishPolyBuild,
  buildEdgeMapFromImageData, snapToEdge,
  selectionPolys, polysToSelection, addPolyToSelection, selectionBounds, HoverCache,
} from './selection.js';
export { makeShape, makeText, layerLabel, describeLayer, layerTypeLabel, isContainerGroup, starPoints, uid, FONT_GROUPS, FONT_STYLESHEET_URL, MATCH_FONTS, fontCss } from './shapes.js';
export { ICON_PREFIXES, ICON_SUGGESTIONS, isIconId, iconUrl, searchIcons, fetchIconSVG } from './icons.js';
export { GOOGLE_FONT_CATALOG, GOOGLE_FONT_CATEGORIES, searchGoogleFonts, loadFontPreviews } from './fontcatalog.js';
export { addGoogleFont, addCustomFont, restoreUserFonts, removeUserFont } from './fonts.js';
export { makeCTA, makeBadge, makePrice, makeBrandLockup, autoFitText, applyLegibilityShadow } from './adtext.js';
export { buildLayerFromSpec, buildPromoLayout, scrimFill } from './templates.js';
export { getCropHandle, dragCropRect, applyCrop, fitCropRect, clampCropRect } from './crop.js';
export { alignDelta, snapDelta } from './layout.js';
export { strokeInfo, canPositionStroke } from './stroke.js';
export { EXTRA, serialize, restore, exportImage, addImageLayer, imageLayerName, artboardForImage, loadImageEl } from './io.js';
export { installAutosave, restoreSession, readSession, writeSession, clearSession, SESSION_KEY,
  discardToTrash, readDiscarded, clearDiscarded, restoreDiscarded, TRASH_KEY,
  exportProject, parseProject, loadProject } from './session.js';
export { BOOLEAN_OPS, BOOLEAN_LABEL, setClipEngine, resetClipEngine, hasClipEngine, combinableReason, objectRings, combineRings } from './booleans.js';
export { DocumentSet, installDocuments, DOCS_KEY, MAX_DOCS } from './docs.js';
export { mountBlendPicker, blendThumb, blendThumbFrom, BLEND_GROUPS, BLEND_MODES } from './blendpicker.js';
export { trapDialog, focusableIn } from './dialog.js';
export { installColorPicker, openColorPicker, closeColorPicker } from './colorpicker.js';
export { selectionClipObject, renderSelectedPixels } from './pixels.js';
export { AIRegistry, CAPABILITIES } from './ai/registry.js';
export { GeminiProvider } from './ai/gemini.js';
export { installBridge, openInEditor, installDropImport, parseLaunch, BRIDGE } from './bridge.js';
export { hexRgb, rgba, toHex, relLum, rgbToHsl, hslToRgb, hexToHsl, recolorPixels, fxToFilterSpecs, FX_DEFAULTS, ADJUST_CONTROLS, formatAdjustValue, normalizeGradientStops, splitGradientStopColor } from './color.js';
export { CvEngine, prepImageData } from './cv/client.js';
export { cvWorkerBody, cvWorkerSource, DEFAULT_OPENCV_URL } from './cv/worker.js';
export { installKeybindings, TOOL_KEYS } from './keybindings.js';
export { drawPickSpinner } from './busy.js';
export { buildContextMenu, mountContextMenu } from './contextmenu.js';
export { drawPenOverlay, penCursor, nodesToPathD, commandsToNodes, splitSegment, toggleSmooth } from './pen.js';
export { makeToneFilterClass, applyTone, isToneNeutral, buildCurveLut, whiteBalanceGains, TONE_DEFAULTS, HSL_BANDS, CURVE_CHANNELS, CURVE_IDENTITY,
  MAX_CURVE_POINTS, normalizeCurves, compactCurves, curveHitTest, curveInsertPoint, curveMovePoint, curveRemovePoint, curveSvgPath, lumaHistogram,
  HSL_PROPS, hslBandLabel, getHslValue, setHslValue, hslBandTrack } from './tone.js';
export { makeGeometryFilterClass, applyGeometry, isGeometryNeutral, straightenScale, keystoneQuad, squareToQuad, mapHomography, geometrySourcePoint, GEOMETRY_DEFAULTS, UNIT_QUAD, GEOMETRY_CONTROLS, formatGeometryValue } from './geometry.js';
export { colorStats, computeMatch, applyMatch, makeColorMatchFilterClass } from './colormatch.js';
export { applySharpen, makeSharpenFilterClass, SHARPEN_MAX, SHARPEN_RADIUS } from './sharpen.js';
export { makeMaskFilterClass, createMaskCanvas, maskStamp, maskLine } from './mask.js';
export { STICKER_GROUPS, STICKER_PALETTE, stickerSpec, stickerLabel, STICKER_DEFAULT_LABEL } from './stickers.js';
export { installVoice, parseVoiceCommand, parseVoiceCommands, runVoiceCommand, normalizeLLMCommand, catalogPrompt, COMMANDS as VOICE_COMMANDS } from './voice.js';
export { rankCommands } from './cmdk.js';
