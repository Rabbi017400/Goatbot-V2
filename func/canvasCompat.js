const Canvas = require("canvas");

// @napi-rs/canvas (the maintained prebuilt replacement for node-canvas) exposes
// fonts through GlobalFonts. Map the legacy node-canvas registerFont API onto it
// so existing commands keep working unchanged.
if (typeof Canvas.registerFont !== "function" && Canvas.GlobalFonts && typeof Canvas.GlobalFonts.registerFromPath === "function") {
	Canvas.registerFont = (fontPath, options) => Canvas.GlobalFonts.registerFromPath(fontPath, options && options.family);
}

module.exports = Canvas;
