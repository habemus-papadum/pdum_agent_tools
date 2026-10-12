import { experiments } from "@agent-spike/experiment-kit";

console.log("Agent spike experiments\n");

for (const experiment of experiments) {
  console.log(`${experiment.id} [${experiment.status}]`);
  console.log(`  ${experiment.description}\n`);
}
