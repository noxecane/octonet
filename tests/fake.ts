import { randomInt, randomUUID } from "crypto";

/**
 * Random test data, shaped like the parts of @faker-js/faker these tests used.
 */

const firstNames = ["Ada", "Grace", "Alan", "Kunle", "Amara", "Linus", "Margaret", "Chidi", "Zara", "Tunde"];
const lastNames = ["Lovelace", "Hopper", "Turing", "Okafor", "Hamilton", "Adeyemi", "Torvalds", "Bello"];
const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];

const pick = <T>(xs: T[]) => xs[randomInt(xs.length)];
const suffix = () => randomUUID().slice(0, 8);

function number(opts: { min?: number; max?: number } = {}) {
  const { min = 0, max = 99_999 } = opts;
  return randomInt(min, max + 1);
}

export const faker = {
  datatype: {
    uuid: () => randomUUID(),
    number
  },
  finance: {
    /** a random amount with 2 decimal places, as a string */
    amount: (min = 0, max = 1000) => (min + Math.random() * (max - min)).toFixed(2)
  },
  internet: {
    userName: () => `${pick(firstNames).toLowerCase()}_${suffix()}`,
    email: () => `${pick(firstNames).toLowerCase()}.${suffix()}@example.com`
  },
  lorem: {
    word: () => pick(words)
  },
  name: {
    firstName: () => pick(firstNames),
    lastName: () => pick(lastNames),
    fullName: () => `${pick(firstNames)} ${pick(lastNames)}`
  }
};
