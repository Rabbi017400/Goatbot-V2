"use strict";

const { DECODERS, DECODER_ALIASES } = require("./decoders");
const { spToDepMap } = require("./sp");

const STEP = {
  BLOCK: 1,
  LOAD: 2,
  STORE: 3,
  STORE_ARRAY: 4,
  CALL_STORED_PROCEDURE: 5,
  CALL_NATIVE_TYPE_OPERATION: 6,
  CALL_NATIVE_OPERATION: 7,
  UNDEFINED: 9,
  I64_FROM_STRING: 19,
  IF: 23,
  NOT: 26,
  LOGGER_LOG: 49,
  NATIVE_OP_ARRAY_CREATE: 50,
  NATIVE_OP_ARRAY_APPEND: 51,
  NATIVE_OP_ARRAY_GET_SIZE: 52,
  NATIVE_OP_MAP_CREATE: 53,
  NATIVE_OP_MAP_SET: 55,
  NATIVE_OP_CURRENT_TIME: 60,
  I64_ADD: 69,
  I64_EQUAL: 30,
  TO_BLOB: 16,
};

function toInt(value) {
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

class LightSpeedDecoder {
  constructor(dependencies, table) {
    this.table = table || {};
    this.dependencies = dependencies || {};
    this.statementReferences = {};
  }

  decode(steps) {
    if (!Array.isArray(steps)) return steps;
    if (steps.length === 0) return steps;
    const stepType = toInt(steps[0]);
    const stepData = steps.slice(1);

    switch (stepType) {
      case STEP.BLOCK: {
        for (const blockData of stepData) {
          if (!Array.isArray(blockData)) continue;
          this.decode(blockData);
        }
        break;
      }
      case STEP.LOAD: {
        const key = toInt(stepData[0]);
        return this.statementReferences[key] !== undefined ? this.statementReferences[key] : 0;
      }
      case STEP.STORE: {
        const retVal = this.decode(stepData[1]);
        this.statementReferences[toInt(stepData[0])] = retVal;
        break;
      }
      case STEP.STORE_ARRAY: {
        const key = toInt(stepData[0]);
        this.statementReferences[key] = toInt(stepData[1]);
        this.decode(steps.slice(2));
        break;
      }
      case STEP.CALL_STORED_PROCEDURE: {
        const referenceName = stepData[0];
        if (typeof referenceName !== "string") return null;
        this.handleStoredProcedure(referenceName, stepData.slice(1));
        break;
      }
      case STEP.UNDEFINED:
        return null;
      case STEP.I64_FROM_STRING: {
        return toInt(stepData[0]);
      }
      case STEP.IF: {
        const result = toInt(this.decode(stepData[0]));
        if (result > 0) {
          this.decode(stepData[1]);
        } else if (stepData.length >= 3 && stepData[2] !== null && stepData[2] !== undefined) {
          this.decode(stepData[2]);
        }
        break;
      }
      case STEP.NOT:
        return toInt(this.decode(stepData[0]));
      case STEP.NATIVE_OP_CURRENT_TIME:
        return Date.now();
      case STEP.CALL_NATIVE_OPERATION:
      case STEP.CALL_NATIVE_TYPE_OPERATION:
        return null;
      case STEP.NATIVE_OP_MAP_CREATE:
        return {};
      case STEP.NATIVE_OP_MAP_SET: {
        const map = this.decode(stepData[0]);
        if (!map || typeof map !== "object") return null;
        const key = this.decode(stepData[1]);
        const val = this.decode(stepData[2]);
        map[String(key)] = val;
        return map;
      }
      case STEP.NATIVE_OP_ARRAY_CREATE:
        return [];
      case STEP.NATIVE_OP_ARRAY_APPEND: {
        const arr = this.decode(stepData[0]);
        if (!Array.isArray(arr)) return null;
        arr.push(this.decode(stepData[1]));
        return arr;
      }
      case STEP.NATIVE_OP_ARRAY_GET_SIZE: {
        const arr = this.decode(stepData[0]);
        return Array.isArray(arr) ? arr.length : 0;
      }
      case STEP.LOGGER_LOG:
        return null;
      case STEP.I64_ADD:
        return toInt(this.decode(stepData[0])) + toInt(this.decode(stepData[1]));
      case STEP.I64_EQUAL:
        return toInt(this.decode(stepData[0])) === toInt(this.decode(stepData[1]));
      case STEP.TO_BLOB: {
        const b64 = stepData[0];
        if (typeof b64 !== "string") return null;
        try {
          return Buffer.from(b64, "base64");
        } catch (_) {
          return null;
        }
      }
      default:
        return null;
    }
    return null;
  }

  handleStoredProcedure(referenceName, data) {
    const depReference = this.dependencies[referenceName];
    if (!depReference) return;
    const typeName = DECODER_ALIASES[depReference] || depReference;
    const decoder = DECODERS[typeName];
    if (!decoder) return;
    const decodedData = data.map((d) => this.decode(d));
    const item = decoder(decodedData, this);
    if (!this.table[depReference]) this.table[depReference] = [];
    this.table[depReference].push(item);
  }
}

function decodeLSData(lsData, spList) {
  const dependencies = spToDepMap(spList);
  const table = {};
  const decoder = new LightSpeedDecoder(dependencies, table);
  decoder.decode(lsData && lsData.step);
  return table;
}

module.exports = { LightSpeedDecoder, decodeLSData, STEP };
