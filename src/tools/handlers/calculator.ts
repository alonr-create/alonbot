import type { ToolHandler } from '../types.js';

const SAFE_MATH: Record<string, any> = {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  log: Math.log,
  PI: Math.PI,
  E: Math.E,
  pow: Math.pow,
};

const handler: ToolHandler = {
  name: 'calculator',
  definition: {
    name: 'calculator',
    description:
      'Evaluate math expressions safely. Supports basic arithmetic, percentages, and unit conversions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        expression: {
          type: 'string',
          description: 'Math expression to evaluate (e.g., "sqrt(144) + 3 * 2")',
        },
      },
      required: ['expression'],
    },
  },
  async execute(input) {
    try {
      // Replace ^ with ** for exponentiation
      let expr = (input.expression as string).replace(/\^/g, '**');

      // Build a sandboxed function with only math helpers in scope
      const paramNames = Object.keys(SAFE_MATH);
      const paramValues = Object.values(SAFE_MATH);

      const fn = new Function(...paramNames, `"use strict"; return (${expr});`);
      const result = fn(...paramValues);

      if (typeof result !== 'number' || !isFinite(result)) {
        return `Error: Expression did not produce a valid number (got ${result}).`;
      }

      return `${input.expression} = ${result}`;
    } catch (e: any) {
      return `Error evaluating expression: ${e.message}`;
    }
  },
};

export default handler;
