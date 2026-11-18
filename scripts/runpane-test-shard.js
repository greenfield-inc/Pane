// Splits a runpane wrapper suite across CI jobs. With RUNPANE_TEST_SHARD=<index>/<count>
// a suite runs only its index-th part: item k (0-based, in registration order) belongs
// to shard (k % count) + 1, so shards 1..count together run every item exactly once.
// Unset, everything runs.
const nodeTest = require('node:test');

function parseShard(value) {
  if (!value) return null;
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = match ? Number(match[1]) : 0;
  const count = match ? Number(match[2]) : 0;
  if (index < 1 || index > count) {
    throw new Error(`RUNPANE_TEST_SHARD is "${value}". Set it to <index>/<count> with 1 <= index <= count, such as 2/4, or unset it to run every test.`);
  }
  return { index, count };
}

const shard = parseShard(process.env.RUNPANE_TEST_SHARD);

/** Whether the item at this 0-based position runs in this shard. */
function inShard(position) {
  return !shard || position % shard.count === shard.index - 1;
}

let registered = 0;

/** node:test's `test`, registering only this shard's top-level tests. */
function test(...args) {
  if (inShard(registered++)) return nodeTest.test(...args);
  return undefined;
}

module.exports = { inShard, test };
