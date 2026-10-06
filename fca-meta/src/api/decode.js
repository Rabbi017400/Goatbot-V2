"use strict";

const { parseLossless } = require("../bigjson");
const { LightSpeedDecoder } = require("../lightspeed");
const { spToDepMap } = require("../lightspeed/sp");

function decodeSteps(steps, spList) {
  const depMap = spToDepMap(spList);
  const table = {};
  new LightSpeedDecoder(depMap, table).decode(steps);
  return table;
}

function parsePublishResponse(response) {
  if (!response || !response.payload) return {};
  const prd = parseLossless(response.payload.toString());
  if (!prd) return {};
  return decodeSteps(prd.step, response.sp);
}

module.exports = { decodeSteps, parsePublishResponse };
