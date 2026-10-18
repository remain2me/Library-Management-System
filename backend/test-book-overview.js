
require("dotenv").config();

const { generateBookOverview } = require("./services/bookOverview");

const MIN_WORDS = 40;
const MAX_WORDS = 60;

const validCases = [
  {
    name: "Fiction book",
    input: {
      title: "The Alchemist",
      author: "Paulo Coelho",
      category: "Fiction",
    },
  },
  {
    name: "Technical book",
    input: {
      title: "The C Programming Language",
      author: "Brian W. Kernighan and Dennis M. Ritchie",
      category: "Programming",
    },
  },
  {
    name: "Non-fiction book",
    input: {
      title: "Atomic Habits",
      author: "James Clear",
      category: "Self-help",
    },
  },
  {
    name: "Unknown book",
    input: {
      title: "The Invisible Library of Planet Zorvax 999",
      author: "Unknown Test Author",
      category: "Fiction",
    },
  },
  {
    name: "Missing optional metadata",
    input: {
      title: "The Alchemist",
      author: "Paulo Coelho",
    },
  },
  {
    name: "Metadata with extra spaces",
    input: {
      title: "  The Alchemist  ",
      author: "  Paulo Coelho  ",
      category: "  Fiction  ",
    },
  },
];

const invalidCases = [
  {
    name: "Missing title",
    input: { author: "Test Author" },
  },
  {
    name: "Missing author",
    input: { title: "Test Book" },
  },
  {
    name: "Empty title",
    input: { title: "   ", author: "Test Author" },
  },
  {
    name: "Empty author",
    input: { title: "Test Book", author: "   " },
  },
  {
    name: "Missing all metadata",
    input: {},
  },
  {
    name: "Null input",
    input: null,
  },
];

function countWords(text) {
  return text.trim().split(/\s+/).length;
}

function check(condition, message) {
  console.log(`${condition ? "PASS" : "FAIL"}: ${message}`);
  return condition;
}

async function main() {
  let passed = 0;
  let failed = 0;

  function record(result) {
    if (result) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log("\n========== INPUT VALIDATION TESTS ==========\n");

  for (const test of invalidCases) {
    try {
      const result = await generateBookOverview(test.input);

      record(
        check(
          result === null,
          `${test.name} returns null`
        )
      );
    } catch (error) {
      console.log(`FAIL: ${test.name} threw an error`);
      console.log(`Reason: ${error.message}`);
      failed++;
    }
  }

  console.log("\n========== GEMINI API TESTS ==========\n");

  for (const test of validCases) {
    console.log(`\nTesting: ${test.name}`);

    try {
      const result = await generateBookOverview(test.input);

      if (result === null) {
        console.log(
          "FAIL: Service returned null for valid metadata"
        );
        failed++;
        continue;
      }

      record(
        check(
          typeof result === "string",
          "Output is a string"
        )
      );

      record(
        check(
          result.trim().length > 0,
          "Overview is not empty"
        )
      );

      const words = countWords(result);

      record(
        check(
          words >= MIN_WORDS && words <= MAX_WORDS,
          `Word count is ${words} (required: 40-60)`
        )
      );

      record(
        check(
          !/^\s*(overview|summary)\s*:/i.test(result),
          "No unnecessary heading"
        )
      );

      record(
        check(
          !result.includes("\n- ") &&
          !result.includes("\n* "),
          "No bullet list"
        )
      );

      console.log("\nGenerated overview:\n");
      console.log(result);
      console.log("\n------------------------------------------");
    } catch (error) {
      console.log(`FAIL: ${test.name} threw an error`);
      console.log(`Reason: ${error.message}`);
      failed++;
    }
  }

  console.log("\n========== FINAL REPORT ==========");
  console.log(`Passed checks: ${passed}`);
  console.log(`Failed checks: ${failed}`);
  console.log(`Total checks: ${passed + failed}`);

  if (failed === 0) {
    console.log("All executed checks passed.");
  } else {
    console.log("Some checks failed. Review the output above.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Test runner failed:", error.message);
  process.exitCode = 1;
});
