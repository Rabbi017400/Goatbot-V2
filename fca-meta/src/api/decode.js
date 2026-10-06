"use strict";

const { parseJSON } = require("../http");
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
  const prd = parseJSON(Buffer.from(response.payload));
  if (!prd) return {};
  return decodeSteps(prd.step, response.sp);
}

module.exports = { decodeSteps, parsePublishResponse };
