import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Execute the real handlers with DOM boundaries stubbed; no browser or API calls.
const source = readFileSync("src/app/PdfReader.tsx", "utf8");
const handlers = source.slice(source.indexOf("    const redrawActiveFrame ="), source.indexOf('    container?.addEventListener("mouseup"'));
const compiled = ts.transpileModule(handlers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let frame = null;
let clicks = 0;
let selected = "";
let selection = "";
const a = { id: "184:1" }, b = { id: "184:2" };
const callbacks = { current: { followTranslationEnabled: false, lockedTargetId: null, onTargetClick: () => clicks++ } };
const classes = new Set();
const api = new Function("callbackRef", "targetMap", "container", "window", "Element", "drawTargetFrame", "clearTargetFrame", "lookupTarget", "syncHighlightRef", "onSelectionTextRef", `
  let pointerDown = null, suppressClick = false, hoveredTarget;
  ${compiled}
  return { handlePointerOver, handlePointerDown, handlePointerMove, handleClick, handleMouseUp, finishPointer, handlePointerCancel, redrawActiveFrame };
`)(callbacks, new Map([[a.id, a], [b.id, b]]), { classList: { add: x => classes.add(x), remove: x => classes.delete(x) } },
  { getSelection: () => ({ type: selection ? "Range" : "Caret", toString: () => selection }) }, class {},
  target => { frame = target.id; }, () => { frame = null; }, event => event.target, {}, { current: text => { selected = text; } });
const event = target => ({ target, button: 0, clientX: 10, clientY: 10 });
api.handlePointerOver(event(a)); api.handleClick(event(a));
assert.equal(frame, null); assert.equal(clicks, 0);
callbacks.current.followTranslationEnabled = true;
api.handlePointerOver(event(a));
assert.equal(frame, a.id); assert.equal(clicks, 0);
api.handleClick(event(a)); assert.equal(clicks, 1);
callbacks.current.lockedTargetId = a.id;
api.handlePointerOver(event(b)); assert.equal(frame, a.id);
api.handlePointerDown(event(b)); assert.equal(frame, null); assert(classes.has("translation-selecting"));
api.handlePointerOver(event(b)); api.handleClick(event(b)); assert.equal(clicks, 1); assert.equal(frame, null);
selection = "selected sentence";
api.handlePointerMove({ clientX: 80, clientY: 10 }); api.handleMouseUp(); api.finishPointer(); api.handleClick(event(b));
assert.equal(selected, selection); assert.equal(clicks, 1); assert.equal(frame, a.id); assert(!classes.has("translation-selecting"));
selection = "";
api.handleClick(event(b)); assert.equal(clicks, 1); // A drag's synthetic click stays suppressed.
api.handlePointerDown(event(b)); api.finishPointer(); api.handleClick(event(b)); assert.equal(clicks, 2);
api.handlePointerDown(event(b)); api.handlePointerCancel(); api.handleClick(event(b)); assert.equal(clicks, 2);
callbacks.current.followTranslationEnabled = false; api.redrawActiveFrame(); assert.equal(frame, null);

const page = readFileSync("src/app/page.tsx", "utf8");
const clickFunction = page.slice(page.indexOf("  function openTranslationTarget("), page.indexOf("  function toggleFollowTranslation()"));
const clickJs = ts.transpileModule(clickFunction, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const state = { enabled: false, pinned: false, target: null, calls: 0 };
function click(target) {
  new Function("followTranslationEnabled", "translationPinned", "translationTarget", "setTranslationPinned", "setTranslationTarget", "setTranslationPreviewOpen", "translateTarget", "translationScope", "target", `${clickJs}; openTranslationTarget(target);`)(
    state.enabled, state.pinned, state.target, x => { state.pinned = x; }, x => { state.target = x; }, () => {}, () => { state.calls++; }, "paragraph", target);
}
click(a); assert.equal(state.calls, 0);
state.enabled = true; click(a); assert(state.pinned); assert.equal(state.calls, 1);
click(a); assert(!state.pinned); assert.equal(state.calls, 1);
click(a); click(b); assert(state.pinned); assert.equal(state.target.id, b.id); assert.equal(state.calls, 3);
assert.match(readFileSync("src/app/globals.css", "utf8"), /\.translation-paragraph-frame\{[^}]*pointer-events:none/);
console.log("PASS: follow off/on, hover without translation, lock/unlock/switch, drag suppression, selection callback, cancellation, pointer-transparent overlay.");
