// Run:  node worker/tests/questions_test.mjs
// Turning what the model asks into something a dealer can answer with a tap, and degrading to a
// text box when the model ignores the new field — which is a routine event, not an emergency.
import { dealerQuestions } from "../appraiser.js";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${n}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
};

eq("questions with options come through", dealerQuestions({
  dealer_questions: [{ q: "What years are on the coins?", options: ["1942-45", "Other", "Mixed"] }],
}), [{ q: "What years are on the coins?", options: ["1942-45", "Other", "Mixed"] }]);

eq("at most three questions", dealerQuestions({
  dealer_questions: [1, 2, 3, 4, 5].map(i => ({ q: "q" + i, options: ["a"] })),
}).length, 3);

eq("at most four options", dealerQuestions({
  dealer_questions: [{ q: "q", options: ["a", "b", "c", "d", "e", "f"] }],
})[0].options.length, 4);

// The model ignoring a new field is routine. Plain strings still produce answerable questions,
// just without chips, and the card falls back to a text box for those.
eq("falls back to questions_for_dealer", dealerQuestions({
  questions_for_dealer: ["Any chips on the rim?", "Is it marked underneath?"],
}), [{ q: "Any chips on the rim?", options: [] }, { q: "Is it marked underneath?", options: [] }]);

eq("dealer_questions wins when both are present", dealerQuestions({
  dealer_questions: [{ q: "Magnet stick?", options: ["Yes", "No"] }],
  questions_for_dealer: ["something else"],
})[0].q, "Magnet stick?");

// Malformed entries must not reach the page.
eq("blank questions dropped", dealerQuestions({ dealer_questions: [{ q: "   ", options: ["a"] }] }), []);
eq("non-objects dropped", dealerQuestions({ dealer_questions: ["just a string", null, 7] }), []);
eq("missing options is a text question", dealerQuestions({ dealer_questions: [{ q: "What is it?" }] }),
  [{ q: "What is it?", options: [] }]);
eq("blank options dropped", dealerQuestions({ dealer_questions: [{ q: "q", options: ["", "  ", "Yes"] }] })[0].options,
  ["Yes"]);
eq("long option truncated", dealerQuestions({
  dealer_questions: [{ q: "q", options: ["x".repeat(60)] }] })[0].options[0].length, 24);
eq("long question truncated", dealerQuestions({
  dealer_questions: [{ q: "y".repeat(300), options: [] }] })[0].q.length, 140);

// Nothing at all.
eq("no questions", dealerQuestions({}), []);
eq("null input", dealerQuestions(null), []);
eq("dealer_questions not an array", dealerQuestions({ dealer_questions: { q: "x" } }), []);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
