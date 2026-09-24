// Run:  node worker/tests/questions_test.mjs
// Turning what the model asks into something a dealer can answer with a tap, and degrading to a
// text box when the model ignores the new field — which is a routine event, not an emergency.
import { dealerQuestions, cleanQuestion } from "../appraiser.js";

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

// ---- cleanQuestion: the options do not belong in the question ----
// Production, 2026-09-24, the candlestick run. This exact string went onto the card and into the
// uncertainty warning, so the dealer read a comma-separated list glued to the end of a question
// while the same options sat underneath it as buttons.
eq("strips an options tail after the question mark",
  cleanQuestion("Are the items four separate candlesticks or a single multi-arm candelabra? - Four separate sticks,Single candelabra,Unsure"),
  "Are the items four separate candlesticks or a single multi-arm candelabra?");
eq("em dash too",
  cleanQuestion("Does a magnet stick to the base? — Yes,No,Can't tell"),
  "Does a magnet stick to the base?");
eq("a clean question is untouched",
  cleanQuestion("Any hairlines or chips on the rim or base?"),
  "Any hairlines or chips on the rim or base?");
eq("only the first question survives",
  cleanQuestion("Is there a stamp? Where is it?"), "Is there a stamp?");
eq("a question mark inside the question still cuts at the first one",
  cleanQuestion("Is it marked 'Made in USA'? Yes or no"), "Is it marked 'Made in USA'?");
// No question mark at all: keep the instruction, drop a dangling list.
eq("imperative with an options tail",
  cleanQuestion("Tell us the height in inches - under 6,6 to 10,over 10"),
  "Tell us the height in inches");
eq("imperative with no list is untouched",
  cleanQuestion("A close, sharp photo of the stamp on the base"),
  "A close, sharp photo of the stamp on the base");
eq("a hyphenated phrase with no comma is not a list",
  cleanQuestion("Send a photo of the salt-glazed side"),
  "Send a photo of the salt-glazed side");
eq("empty", cleanQuestion(""), "");
eq("undefined", cleanQuestion(undefined), "");
// And it is actually applied to the chips the dealer taps.
eq("dealerQuestions cleans the q it returns",
  dealerQuestions({ dealer_questions: [{ q: "Solid brass or plated? - Solid,Plated,Can't tell",
                                         options: ["Solid", "Plated", "Can't tell"] }] }),
  [{ q: "Solid brass or plated?", options: ["Solid", "Plated", "Can't tell"] }]);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
