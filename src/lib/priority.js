'use strict';
// Priority from impact and urgency (INC-003). 1 = high ... 3 = low; priority 1 (P1) is the most urgent.
const DEFAULT_MATRIX = { 1: { 1: 1, 2: 2, 3: 3 }, 2: { 1: 2, 2: 3, 3: 4 }, 3: { 1: 3, 2: 4, 3: 4 } };

function compute(matrix, impact, urgency) {
  const m = matrix || DEFAULT_MATRIX;
  const p = m[String(impact)] && m[String(impact)][String(urgency)];
  return Number.isInteger(p) && p >= 1 && p <= 4 ? p : 3;
}

const LABELS = { 1: 'P1 Critical', 2: 'P2 High', 3: 'P3 Medium', 4: 'P4 Low' };
const LEVELS = { 1: 'High', 2: 'Medium', 3: 'Low' };

module.exports = { compute, DEFAULT_MATRIX, LABELS, LEVELS };
