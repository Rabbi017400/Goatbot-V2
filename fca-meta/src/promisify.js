"use strict";

// Wraps an async function so it supports both the classic fb-chat-api callback
// signature (err, data) and Promise return values.
function callbackify(fn) {
  return function (...args) {
    let callback = null;
    // The callback is the first trailing function argument.
    for (let i = args.length - 1; i >= 0; i--) {
      if (typeof args[i] === "function") {
        callback = args[i];
        args = args.slice(0, i).concat(args.slice(i + 1));
        break;
      }
    }
    const promise = Promise.resolve().then(() => fn(...args));
    if (callback) {
      promise.then(
        (data) => callback(null, data),
        (err) => callback(err)
      );
    }
    return promise;
  };
}

module.exports = { callbackify };
